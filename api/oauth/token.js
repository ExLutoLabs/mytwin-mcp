// POST /api/oauth/token
//
// Exchanges an authorization_code for an access_token (the user's MCP bearer
// token). Also supports grant_type=refresh_token, in which case we just
// re-mint a fresh MCP token for the same user — the existing token is
// revoked by the mint, so refresh = rotate.

import { consumeAuthCode, authenticateClient } from '../../lib/oauth.js';
import { mintMcpTokenForUser, getActiveMcpTokenInfo } from '../../lib/auth.js';
import { getDB } from '../../lib/supabase.js';
import { logAudit } from '../../lib/audit.js';

export const config = { maxDuration: 15 };

function err(res, status, error, error_description) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error, error_description });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return err(res, 405, 'invalid_request', 'Method not allowed.');
  }

  // Accept JSON and form-encoded bodies (OAuth spec says form, but JSON is
  // common in MCP/Claude tooling).
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const grant_type    = String(body.grant_type    || '');
  const code          = String(body.code          || '');
  const redirect_uri  = String(body.redirect_uri  || '');
  const client_id     = String(body.client_id     || '');
  const client_secret = String(body.client_secret || '');
  const refresh_token = String(body.refresh_token || '');

  // Client auth — required for both grant types.
  const client = await authenticateClient(client_id, client_secret);
  if (!client) {
    return err(res, 401, 'invalid_client', 'Client authentication failed.');
  }

  if (grant_type === 'authorization_code') {
    if (!code || !redirect_uri) {
      return err(res, 400, 'invalid_request', 'code and redirect_uri are required.');
    }
    const consumed = await consumeAuthCode({ code, clientId: client_id, redirectUri: redirect_uri });
    if (!consumed) {
      return err(res, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used.');
    }

    // Mint the MCP token (revokes any previous active token for this user —
    // intentional, ensures the client always has a single canonical token).
    const minted = await mintMcpTokenForUser(consumed.userId);

    logAudit({
      userId:    consumed.userId,
      tenantId:  consumed.tenantId,
      eventType: 'oauth_token_issued',
      success:   true,
      context:   { client_id, grant: 'authorization_code' },
    });

    return res.status(200).json({
      access_token:  minted.token,
      token_type:    'Bearer',
      scope:         consumed.scope || 'mcp',
      // No refresh_token is issued — the existing /oauth/token refresh path
      // works by presenting an old access_token as a refresh_token (below),
      // which keeps the MCP-token-is-the-access-token invariant clean.
    });
  }

  if (grant_type === 'refresh_token') {
    if (!refresh_token) {
      return err(res, 400, 'invalid_request', 'refresh_token is required.');
    }
    // The "refresh token" here is the user's existing MCP token. We look up
    // who owns it and mint a fresh one.
    const db   = getDB();
    const hash = (await import('node:crypto')).createHash('sha256').update(refresh_token).digest('hex');
    const { data } = await db.from('mcp_tokens')
      .select('user_id, tenant_id')
      .eq('token_hash', hash)
      .is('revoked_at', null)
      .maybeSingle();
    if (!data) {
      return err(res, 400, 'invalid_grant', 'Refresh token is invalid or revoked.');
    }
    const minted = await mintMcpTokenForUser(data.user_id);
    logAudit({
      userId:    data.user_id,
      tenantId:  data.tenant_id,
      eventType: 'oauth_token_issued',
      success:   true,
      context:   { client_id, grant: 'refresh_token' },
    });
    return res.status(200).json({
      access_token: minted.token,
      token_type:   'Bearer',
      scope:        'mcp',
    });
  }

  return err(res, 400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
}
