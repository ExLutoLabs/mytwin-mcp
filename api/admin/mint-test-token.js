// POST /api/admin/mint-test-token
//
// Mint a fresh MCP token for a user by email. Revokes the user's current
// active token (if any) and returns the new value exactly once. Same flow
// as /api/dashboard/regenerate-token, but gated by X-Admin-Password instead
// of a user session — so we can rotate tokens (e.g. the Anthropic test
// account) without needing magic-link access to that account's inbox.
//
// Auth: X-Admin-Password header, constant-time compare against
//       ADMIN_DASHBOARD_PASSWORD env var. Same gate as /api/admin/dashboard.
//
// Body: { "email": "test@lutolearning.com" }
//
// Response (200): { user_id, email, prefix, value, mcpUrl, created_at }
//   - `value` and `mcpUrl` contain the raw token. This is the ONLY time
//     they can be retrieved; after this response only the SHA-256 hash
//     remains stored.
//
// Errors:
//   401  unauthorised (missing/wrong X-Admin-Password)
//   400  bad body (no email or unknown email)
//   500  unexpected (e.g. Supabase down)

import { createHash, timingSafeEqual } from 'node:crypto';
import { getDB } from '../../lib/supabase.js';
import { mintMcpTokenForUser } from '../../lib/auth.js';
import { logAudit } from '../../lib/audit.js';

export const config = { maxDuration: 15 };

function authed(req) {
  const provided = String(req.headers['x-admin-password'] || '');
  const expected = String(process.env.ADMIN_DASHBOARD_PASSWORD || '');
  if (expected.length < 8) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { return res.status(405).json({ error: 'POST only' }); }
  if (!authed(req))             { return res.status(401).json({ error: 'Unauthorised' }); }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const email = String(body?.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'Body must include { "email": "..." }' });
  }

  try {
    const db = getDB();

    const { data: user, error: userErr } = await db
      .from('users')
      .select('id, email, tenant_id')
      .eq('email', email)
      .maybeSingle();

    if (userErr) throw new Error(userErr.message);
    if (!user)   return res.status(400).json({ error: `No user with email ${email}` });

    const minted     = await mintMcpTokenForUser(user.id);
    const mcpUrlBase = `${process.env.APP_URL || 'https://myaitwin.lutolearn.com'}/api/mcp`;

    logAudit({
      userId:    user.id,
      tenantId:  user.tenant_id,
      eventType: 'token_regenerated',
      success:   true,
      context:   { via: 'admin/mint-test-token' },
    });

    return res.status(200).json({
      user_id:    user.id,
      email:      user.email,
      tenant_id:  user.tenant_id,
      prefix:     minted.prefix,
      value:      minted.token,
      mcpUrl:     `${mcpUrlBase}/${minted.token}`,
      mcpUrlBase,
      created_at: minted.createdAt,
    });
  } catch (err) {
    console.error('[admin/mint-test-token] failed:', err && err.message);
    return res.status(500).json({ error: 'Mint failed.' });
  }
}
