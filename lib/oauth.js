// OAuth helpers — used by /api/oauth/{authorize, callback, token, register}.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDB } from './supabase.js';

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes per Section 8 spec

// ── Client lookup + auth ─────────────────────────────────────────────────────

// Returns the client row if (client_id, client_secret) matches, else null.
// Constant-time compare on the secret hash.
export async function authenticateClient(clientId, clientSecret) {
  if (!clientId || !clientSecret) return null;
  const db = getDB();
  const { data, error } = await db.from('oauth_clients')
    .select('id, client_id, client_secret_hash, redirect_uris, name')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error || !data) return null;

  const presented = createHash('sha256').update(String(clientSecret)).digest();
  const expected  = Buffer.from(data.client_secret_hash, 'hex');
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;
  return data;
}

// Looks up a client by id only (for /authorize where the client is identifying
// itself but hasn't yet presented its secret — that comes at /token).
export async function getClient(clientId) {
  if (!clientId) return null;
  const db = getDB();
  const { data } = await db.from('oauth_clients')
    .select('client_id, redirect_uris, name, token_endpoint_auth_method')
    .eq('client_id', clientId)
    .maybeSingle();
  return data || null;
}

// Spec-conformant redirect URI matching. Strict string equality, except for
// loopback URIs (http://localhost/... and http://127.0.0.1/...) where the
// port is wildcard — Claude Code uses ephemeral ports per session and the
// Anthropic auth spec requires port-agnostic loopback matching.
export function isRedirectUriAllowed(client, redirectUri) {
  if (!client || !redirectUri) return false;
  if (!Array.isArray(client.redirect_uris)) return false;
  if (client.redirect_uris.includes(redirectUri)) return true;

  // Loopback port-agnostic match.
  let presented;
  try { presented = new URL(redirectUri); } catch { return false; }
  if (presented.protocol !== 'http:') return false;
  if (presented.hostname !== 'localhost' && presented.hostname !== '127.0.0.1') return false;

  for (const allowed of client.redirect_uris) {
    let candidate;
    try { candidate = new URL(allowed); } catch { continue; }
    if (candidate.protocol !== 'http:') continue;
    if (candidate.hostname !== presented.hostname) continue;
    if (candidate.pathname !== presented.pathname) continue;
    return true;
  }
  return false;
}

// ── Authorization codes ──────────────────────────────────────────────────────

export function newAuthCode() {
  // 32 bytes (256 bits) of entropy, encoded as URL-safe base64.
  return randomBytes(32).toString('base64url');
}

export async function issueAuthCode({ userId, tenantId, clientId, redirectUri, state, scope, codeChallenge, codeChallengeMethod }) {
  const db    = getDB();
  const code  = newAuthCode();
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString();
  const { error } = await db.from('oauth_auth_codes').insert({
    code, user_id: userId, tenant_id: tenantId,
    client_id: clientId, redirect_uri: redirectUri,
    state: state || null, scope: scope || null,
    code_challenge:        codeChallenge        || null,
    code_challenge_method: codeChallengeMethod  || null,
    expires_at: expiresAt,
  });
  if (error) throw new Error(error.message);
  return { code, expiresAt };
}

// Atomic single-use consumption: UPDATE only succeeds when the row is unused
// AND not yet expired. Same race-safety pattern as magic_tokens. Returns the
// PKCE values so the token endpoint can verify the code_verifier.
export async function consumeAuthCode({ code, clientId, redirectUri }) {
  const db  = getDB();
  const now = new Date().toISOString();
  const { data, error } = await db.from('oauth_auth_codes')
    .update({ used: true })
    .eq('code', code)
    .eq('client_id', clientId)
    .eq('redirect_uri', redirectUri)
    .eq('used', false)
    .gte('expires_at', now)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    userId:              data.user_id,
    tenantId:            data.tenant_id,
    scope:               data.scope,
    codeChallenge:       data.code_challenge,
    codeChallengeMethod: data.code_challenge_method,
  };
}

// PKCE verification: sha256(verifier), base64url-encoded, must equal challenge.
// Constant-time compare so a timing oracle can't be used to brute-force.
export function verifyPkce({ codeVerifier, codeChallenge, codeChallengeMethod }) {
  if (!codeVerifier || !codeChallenge) return false;
  if (codeChallengeMethod !== 'S256') return false;
  // RFC 7636: code_verifier is 43–128 chars from [A-Z a-z 0-9 - . _ ~]
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
  const computed = createHash('sha256').update(codeVerifier).digest();
  let expected;
  try { expected = Buffer.from(codeChallenge, 'base64url'); }
  catch { return false; }
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

// ── Refresh tokens ───────────────────────────────────────────────────────────

const REFRESH_TOKEN_PREFIX = 'mtr_';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Mints an opaque refresh token. Only the sha256 hash is stored — the raw
// value is returned to the client exactly once.
export async function issueRefreshToken({ userId, tenantId, clientId, scope }) {
  const db   = getDB();
  const raw  = REFRESH_TOKEN_PREFIX + randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
  const { error } = await db.from('oauth_refresh_tokens').insert({
    token_hash: hash,
    user_id:    userId,
    tenant_id:  tenantId,
    client_id:  clientId,
    scope:      scope || null,
    expires_at: expiresAt,
  });
  if (error) throw new Error(error.message);
  return raw;
}

// Atomic single-use consumption with rotation semantics. The UPDATE only
// succeeds when the row is unused AND not expired AND owned by the same
// client. Replay attempts (presenting the same refresh after rotation) hit
// revoked_at IS NOT NULL and return null.
export async function consumeRefreshToken({ rawToken, clientId }) {
  if (!rawToken || !clientId) return null;
  const db   = getDB();
  const hash = createHash('sha256').update(rawToken).digest('hex');
  const now  = new Date().toISOString();
  const { data, error } = await db.from('oauth_refresh_tokens')
    .update({ revoked_at: now })
    .eq('token_hash', hash)
    .eq('client_id', clientId)
    .is('revoked_at', null)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return { userId: data.user_id, tenantId: data.tenant_id, scope: data.scope };
}

// ── Redirect helpers ─────────────────────────────────────────────────────────

export function buildRedirect(uri, params) {
  // Append query params to redirect_uri (or the custom-scheme variant), keeping
  // any existing query intact. Handles both https:// and claude:// schemes.
  const hasQuery = uri.includes('?');
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return uri + (hasQuery ? '&' : '?') + qs;
}
