// POST /api/oauth/token
//
// Exchanges an authorization_code for an access_token + refresh_token. Also
// supports grant_type=refresh_token, rotating the presented refresh token
// (it is marked revoked atomically and a fresh pair is issued).
//
// Public clients (Claude DCR-registered) authenticate via PKCE; confidential
// clients authenticate with client_secret_post.

import { consumeAuthCode, authenticateClient, getClient, verifyPkce, issueRefreshToken, consumeRefreshToken } from '../../lib/oauth.js';
import { mintMcpTokenForUser } from '../../lib/auth.js';
import { logAudit } from '../../lib/audit.js';

const ACCESS_TOKEN_TTL_SECONDS = parseInt(process.env.OAUTH_TOKEN_EXPIRY_SECONDS || '86400', 10);

function scopeIncludes(scope, want) {
  if (!scope) return false;
  return String(scope).split(/\s+/).filter(Boolean).includes(want);
}

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
  const code_verifier = String(body.code_verifier || '');
  const redirect_uri  = String(body.redirect_uri  || '');
  const client_id     = String(body.client_id     || '');
  const client_secret = String(body.client_secret || '');
  const refresh_token = String(body.refresh_token || '');

  // Client lookup. Public clients (token_endpoint_auth_method=none) authenticate
  // via PKCE, not a secret — Claude DCR-registers as public. Confidential clients
  // still authenticate with client_secret_post.
  const registered = await getClient(client_id);
  if (!registered) {
    return err(res, 401, 'invalid_client', 'Unknown client_id.');
  }
  const isPublic = registered.token_endpoint_auth_method === 'none';
  if (!isPublic) {
    const authed = await authenticateClient(client_id, client_secret);
    if (!authed) {
      return err(res, 401, 'invalid_client', 'Client authentication failed.');
    }
  }
  const client = registered;

  if (grant_type === 'authorization_code') {
    if (!code || !redirect_uri) {
      return err(res, 400, 'invalid_request', 'code and redirect_uri are required.');
    }
    const consumed = await consumeAuthCode({ code, clientId: client_id, redirectUri: redirect_uri });
    if (!consumed) {
      return err(res, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used.');
    }
    // PKCE verification (required by the spec). If the code was issued with a
    // challenge, the verifier MUST match. Codes without a challenge are
    // rejected on the /authorize side, so this is belt-and-braces — but if a
    // pre-PKCE code somehow gets through, refuse it.
    if (!consumed.codeChallenge) {
      return err(res, 400, 'invalid_grant', 'Authorization code is missing PKCE binding.');
    }
    if (!code_verifier) {
      return err(res, 400, 'invalid_request', 'code_verifier is required.');
    }
    const pkceOk = verifyPkce({
      codeVerifier:        code_verifier,
      codeChallenge:       consumed.codeChallenge,
      codeChallengeMethod: consumed.codeChallengeMethod,
    });
    if (!pkceOk) {
      return err(res, 400, 'invalid_grant', 'PKCE verification failed.');
    }

    // Mint the access token scoped to this client (multi-device safe).
    const minted = await mintMcpTokenForUser(consumed.userId, {
      clientId:         client_id,
      expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    });

    const response = {
      access_token: minted.token,
      token_type:   'Bearer',
      expires_in:   ACCESS_TOKEN_TTL_SECONDS,
      scope:        consumed.scope || 'mcp',
    };

    // Issue a refresh token whenever offline_access is in scope. Anthropic
    // adds it automatically when we advertise it in scopes_supported.
    if (scopeIncludes(consumed.scope, 'offline_access')) {
      response.refresh_token = await issueRefreshToken({
        userId:   consumed.userId,
        tenantId: consumed.tenantId,
        clientId: client_id,
        scope:    consumed.scope,
      });
    }

    logAudit({
      userId:    consumed.userId,
      tenantId:  consumed.tenantId,
      eventType: 'oauth_token_issued',
      success:   true,
      context:   { client_id, grant: 'authorization_code' },
    });

    return res.status(200).json(response);
  }

  if (grant_type === 'refresh_token') {
    if (!refresh_token) {
      return err(res, 400, 'invalid_request', 'refresh_token is required.');
    }
    // Atomic single-use: consumeRefreshToken marks the row revoked. Replays
    // of the same refresh token hit revoked_at IS NOT NULL and return null.
    const consumed = await consumeRefreshToken({ rawToken: refresh_token, clientId: client_id });
    if (!consumed) {
      return err(res, 400, 'invalid_grant', 'Refresh token is invalid, expired, or already used.');
    }
    const minted = await mintMcpTokenForUser(consumed.userId, {
      clientId:         client_id,
      expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    });
    // Rotate the refresh token alongside the access token (public-client
    // requirement per the Anthropic auth spec).
    const newRefresh = await issueRefreshToken({
      userId:   consumed.userId,
      tenantId: consumed.tenantId,
      clientId: client_id,
      scope:    consumed.scope,
    });
    logAudit({
      userId:    consumed.userId,
      tenantId:  consumed.tenantId,
      eventType: 'oauth_token_issued',
      success:   true,
      context:   { client_id, grant: 'refresh_token' },
    });
    return res.status(200).json({
      access_token:  minted.token,
      token_type:    'Bearer',
      expires_in:    ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: newRefresh,
      scope:         consumed.scope || 'mcp',
    });
  }

  return err(res, 400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
}
