// GET /api/oauth/callback?token=...
//
// Magic-link target for the OAuth flow. Validates the token (atomic
// single-use + expiry, same as the regular magic_tokens flow), recovers the
// OAuth state attached to it, ensures the user exists, mints an authorization
// code, and redirects to the client's redirect_uri with code + state.

import { verifyMagicToken, getOrCreateUser } from '../../lib/auth.js';
import { getDB } from '../../lib/supabase.js';
import { issueAuthCode, getClient, isRedirectUriAllowed, buildRedirect } from '../../lib/oauth.js';
import { logAudit } from '../../lib/audit.js';

export const config = { maxDuration: 15 };

const APP_URL = process.env.APP_URL || 'https://myaitwin.lutolearn.com';

function htmlError(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OAuth — error</title><style>body{font-family:system-ui,sans-serif;background:#FDFCFA;color:#0F0E0D;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.box{max-width:420px;text-align:center}.bar{position:fixed;top:0;left:0;right:0;height:6px;background:#FFE34A}h1{font-size:1.4rem;margin:0 0 12px;font-family:Georgia,serif;font-weight:500}p{font-size:14px;color:#3A352E;line-height:1.55;margin:0 0 8px}a{color:#0F0E0D}</style></head><body><div class="bar"></div><div class="box"><h1>This link didn't work.</h1><p>${message}</p><p style="margin-top:18px;font-size:12px;color:#857C6E"><a href="/">Back to MyAITwin →</a></p></div></body></html>`;
}

async function readOAuthContextThenInvalidate(token) {
  const db  = getDB();
  // Recover the OAuth context BEFORE consuming the magic token (we need both
  // the email and the OAuth params; verifyMagicToken returns email but not
  // the oauth_* columns). Single read, then atomic consume via verifyMagicToken.
  const { data: row } = await db.from('magic_tokens')
    .select('oauth_client_id, oauth_redirect_uri, oauth_state, oauth_scope, oauth_code_challenge, oauth_code_challenge_method')
    .eq('token', token)
    .eq('used', false)
    .gte('expires_at', new Date().toISOString())
    .maybeSingle();
  return row || null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { token } = req.query || {};
  if (!token) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(htmlError('Missing token.'));
  }

  // Peek at the OAuth context attached to the magic token before consuming it.
  const oauthCtx = await readOAuthContextThenInvalidate(token);
  if (!oauthCtx || !oauthCtx.oauth_client_id || !oauthCtx.oauth_redirect_uri) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(htmlError('This link is not an OAuth link, or it has expired.'));
  }

  let email;
  try {
    const verified = await verifyMagicToken(token); // atomic single-use
    email = verified.email;
  } catch {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(htmlError('The sign-in link expired or was already used. Request a new one.'));
  }

  // Validate the client + redirect_uri against the current registration —
  // defends against a stale link if the client's redirect_uris changed.
  const client = await getClient(oauthCtx.oauth_client_id);
  if (!client || !isRedirectUriAllowed(client, oauthCtx.oauth_redirect_uri)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(htmlError('The connected app is no longer registered.'));
  }

  // Ensure user + tenant. allowUninvited so the OAuth flow doesn't require a
  // separate invite code — Anthropic's directory submission expects sign-up
  // through the connector.
  let user;
  try {
    const out = await getOrCreateUser(email, { allowUninvited: true });
    user = out.user;
  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(htmlError('Could not create or sign in this account.'));
  }

  const { code } = await issueAuthCode({
    userId:              user.id,
    tenantId:            user.tenant_id,
    clientId:            oauthCtx.oauth_client_id,
    redirectUri:         oauthCtx.oauth_redirect_uri,
    state:               oauthCtx.oauth_state,
    scope:               oauthCtx.oauth_scope,
    codeChallenge:       oauthCtx.oauth_code_challenge,
    codeChallengeMethod: oauthCtx.oauth_code_challenge_method,
  });

  logAudit({
    userId:    user.id,
    tenantId:  user.tenant_id,
    eventType: 'oauth_code_issued',
    success:   true,
    context:   { client_id: oauthCtx.oauth_client_id },
  });

  const target = buildRedirect(oauthCtx.oauth_redirect_uri, {
    code,
    state: oauthCtx.oauth_state,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(302, { Location: target });
  return res.end();
}
