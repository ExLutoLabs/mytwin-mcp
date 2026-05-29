// POST   /api/account/shared-token — mint a new shared MCP token (revokes the old one).
// DELETE /api/account/shared-token — revoke the active shared token.
//
// Shared tokens give read-only access to a user's sharable knowledge items
// via /mcp/shared/:token. One active token per user at a time.
//
// POST returns { token, prefix, id, created_at } — `token` is the raw value,
// shown exactly once. Store it somewhere safe; it cannot be retrieved again.
// DELETE returns { ok: true }.
//
// Both require a valid session cookie.

import {
  requireAuth,
  mintSharedTokenForUser,
  revokeSharedTokenForUser,
} from '../../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const session = await requireAuth(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  // ── POST: mint ──────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const { token, prefix, id, createdAt } = await mintSharedTokenForUser(session.userId);
      return res.status(200).json({ token, prefix, id, created_at: createdAt });
    } catch (err) {
      console.error('[shared-token/mint]', err?.message);
      return res.status(500).json({ error: 'Could not generate token. Try again.' });
    }
  }

  // ── DELETE: revoke ──────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      await revokeSharedTokenForUser(session.userId);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[shared-token/revoke]', err?.message);
      return res.status(500).json({ error: 'Could not revoke token. Try again.' });
    }
  }

  res.status(405).json({ error: 'POST or DELETE only' });
}
