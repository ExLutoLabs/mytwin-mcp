// GET  /api/account — return account info for the authenticated user.
// DELETE /api/account — delete account (requires confirm phrase in body).
//
// Both methods require a valid session cookie (authenticated, not anon).

import { requireAuth, clearSessionCookie } from '../../lib/auth.js';
import { deleteAccount }                   from '../../lib/account.js';
import { getDB }                           from '../../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const session = await requireAuth(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  // ── GET ─────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const db = getDB();

    const { data: user } = await db
      .from('users')
      .select('email, tenant_id, created_at')
      .eq('id', session.userId)
      .maybeSingle();
    if (!user) return res.status(401).json({ error: 'User not found' });

    const [
      { count: itemCount },
      { count: conceptCount },
      { data: sharedTokenRows },
    ] = await Promise.all([
      db.from('knowledge')
        .select('*', { count: 'exact', head: true })
        .eq('user_id',   session.userId)
        .eq('tenant_id', user.tenant_id),
      db.from('concept_pages')
        .select('*', { count: 'exact', head: true })
        .eq('user_id',   session.userId)
        .eq('tenant_id', user.tenant_id),
      db.from('shared_mcp_tokens')
        .select('id, token_prefix, created_at, last_used_at')
        .eq('user_id', session.userId)
        .eq('revoked', false)
        .order('created_at', { ascending: false }),
    ]);

    return res.status(200).json({
      email:              user.email,
      created_at:         user.created_at,
      item_count:         itemCount  || 0,
      concept_page_count: conceptCount || 0,
      shared_tokens: (sharedTokenRows || []).map(t => ({
        id:           t.id,
        prefix:       t.token_prefix,
        created_at:   t.created_at,
        last_used_at: t.last_used_at,
      })),
    });
  }

  // ── DELETE ──────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const CONFIRM = 'DELETE-MY-ACCOUNT';
    if (!req.body || req.body.confirm !== CONFIRM) {
      return res.status(400).json({
        error: `Confirmation required. Send { "confirm": "${CONFIRM}" } in the body.`,
      });
    }
    try {
      const result = await deleteAccount({ userId: session.userId });
      clearSessionCookie(res);
      return res.status(200).json({
        deleted:          true,
        tenant_id:        result.tenantId,
        pinecone_deleted: result.pineconeDeleted,
      });
    } catch (err) {
      console.error('[account/delete]', err?.message);
      return res.status(500).json({ error: 'Could not complete deletion. Try again.' });
    }
  }

  res.status(405).json({ error: 'GET or DELETE only' });
}
