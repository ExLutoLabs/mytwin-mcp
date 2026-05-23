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
    .select('client_id, redirect_uris, name')
    .eq('client_id', clientId)
    .maybeSingle();
  return data || null;
}

export function isRedirectUriAllowed(client, redirectUri) {
  if (!client || !redirectUri) return false;
  return Array.isArray(client.redirect_uris) && client.redirect_uris.includes(redirectUri);
}

// ── Authorization codes ──────────────────────────────────────────────────────

export function newAuthCode() {
  // 32 bytes (256 bits) of entropy, encoded as URL-safe base64.
  return randomBytes(32).toString('base64url');
}

export async function issueAuthCode({ userId, tenantId, clientId, redirectUri, state, scope }) {
  const db    = getDB();
  const code  = newAuthCode();
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString();
  const { error } = await db.from('oauth_auth_codes').insert({
    code, user_id: userId, tenant_id: tenantId,
    client_id: clientId, redirect_uri: redirectUri,
    state: state || null, scope: scope || null,
    expires_at: expiresAt,
  });
  if (error) throw new Error(error.message);
  return { code, expiresAt };
}

// Atomic single-use consumption: UPDATE only succeeds when the row is unused
// AND not yet expired. Same race-safety pattern as magic_tokens.
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
