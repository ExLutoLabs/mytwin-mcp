// POST /api/oauth/register — dynamic client registration (RFC 7591, minimal)
//
// Accepts: { redirect_uris: [...], client_name? }
// Returns: { client_id, client_secret, client_name, redirect_uris }
//
// The secret is shown ONCE and the sha256 of it is stored at rest.
// Anthropic doesn't strictly need this — Claude Desktop is pre-registered as
// client_id=claude-desktop — but RFC 7591 / RFC 8414 compatibility is helpful
// for other MCP clients submitting later.

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

  const clientId     = 'c_' + randomBytes(12).toString('hex');
  const clientSecret = 'cs_' + randomBytes(32).toString('hex');
  const hash         = createHash('sha256').update(clientSecret).digest('hex');

  const db = getDB();
  const { error } = await db.from('oauth_clients').insert({
    client_id:          clientId,
    client_secret_hash: hash,
    redirect_uris:      redirectUris,
    name:               clientName,
  });
  if (error) return res.status(500).json({ error: 'server_error', error_description: error.message });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(201).json({
    client_id:     clientId,
    client_secret: clientSecret,
    client_name:   clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'client_secret_post',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
}
