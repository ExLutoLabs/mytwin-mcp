// POST /api/oauth/register — dynamic client registration (RFC 7591).
//
// Accepts: { redirect_uris: [...], client_name? }
// Returns: { client_id, client_id_issued_at, client_name, redirect_uris,
//            token_endpoint_auth_method, grant_types, response_types }
//
// We register every DCR client as PUBLIC (`token_endpoint_auth_method: "none"`).
// PKCE binds the auth-code exchange — no shared secret is needed, and the
// MCP authorization profile is built around this assumption. This is the
// spec-correct path for browser- and CLI-based clients (Claude, Smithery,
// MCP Inspector, etc).
//
// CRITICAL: the response intentionally OMITS both `client_secret` and
// `client_secret_expires_at`. RFC 7591 §3.2.1 says `client_secret_expires_at`
// is REQUIRED *if* a `client_secret` is issued — strict clients (Smithery,
// the Anthropic Connectors Directory review) reject a response that includes
// `client_secret` without a numeric `client_secret_expires_at`. The cleanest
// fix per the spec is to not issue a secret at all when we don't use one.

import { randomBytes, createHash } from 'node:crypto';
import { getDB } from '../../lib/supabase.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(u => typeof u === 'string') : [];
  if (!redirectUris.length) {
    return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array of strings.' });
  }
  for (const u of redirectUris) {
    try { new URL(u); }
    catch {
      // Allow custom schemes (e.g. claude://) which URL() accepts; reject only
      // pure garbage.
      if (!/^[a-z][a-z0-9+\-.]*:\/\//i.test(u)) {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: `redirect_uri ${u} is not a valid URI.` });
      }
    }
  }
  const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : null;

  const clientId          = 'c_' + randomBytes(12).toString('hex');
  // The oauth_clients.client_secret_hash column is NOT NULL (legacy from when
  // DCR issued real secrets). Populate it with random bytes so the constraint
  // is satisfied, but never expose those bytes — public clients route around
  // authenticateClient() in /api/oauth/token via the auth-method check.
  const placeholderHash   = createHash('sha256').update(randomBytes(32)).digest('hex');
  const issuedAtSeconds   = Math.floor(Date.now() / 1000);

  const db = getDB();
  const { error } = await db.from('oauth_clients').insert({
    client_id:                  clientId,
    client_secret_hash:         placeholderHash,
    redirect_uris:              redirectUris,
    name:                       clientName,
    token_endpoint_auth_method: 'none',
  });
  if (error) return res.status(500).json({ error: 'server_error', error_description: error.message });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(201).json({
    client_id:                  clientId,
    client_id_issued_at:        issuedAtSeconds,
    client_name:                clientName,
    redirect_uris:              redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types:                ['authorization_code', 'refresh_token'],
    response_types:             ['code'],
  });
}
