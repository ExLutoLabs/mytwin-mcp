// GET /api/library/items
//   ?type=    filter to one type (optional)
//   ?sort=    'recent' | 'alphabetical' | 'by-type'  (default: recent)
//   ?limit=   default 50, max 200
//   ?offset=  default 0
//   ?id=      if present, return a single item instead of a list
//
// Multi-tenant safe: every query filters by BOTH tenant_id AND user_id.
// Single-item endpoint returns 404 for any item not owned by the caller
// (does not reveal whether the id exists in another tenant).
// No cap consumed — read-only.

import { methodGuard, runTwin, HttpError } from '../../lib/twin-api.js';
import { getDB } from '../../lib/supabase.js';

const SELECT = 'id, type, title, content, tags, source_ref, provenance, created_at, updated_at, visibility';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'library_items',
    fn: async (ctx) => {
      const db = getDB();
      const {
        id,
        type,
        visibility,
        sort       = 'recent',
        limit:  rawLimit  = '50',
        offset: rawOffset = '0',
      } = req.query;

      // ── Single item detail ───────────────────────────────────────────────
      if (id) {
        const { data, error } = await db
          .from('knowledge')
          .select(SELECT)
          .eq('id', id)
          .eq('user_id', ctx.userId)
          .eq('tenant_id', ctx.tenantId)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new HttpError(404, { error: 'Item not found' });
        return data;
      }

      // ── Paginated list ───────────────────────────────────────────────────
      const limit  = Math.min(Math.max(Number(rawLimit)  || 50,  1), 200);
      const offset = Math.max(Number(rawOffset) || 0, 0);

      let q = db
        .from('knowledge')
        .select(SELECT, { count: 'exact' })
        .eq('user_id', ctx.userId)
        .eq('tenant_id', ctx.tenantId);

      if (type && type !== 'all') q = q.eq('type', type);
      if (visibility === 'private' || visibility === 'sharable') q = q.eq('visibility', visibility);

      switch (sort) {
        case 'alphabetical':
          q = q.order('title', { ascending: true, nullsFirst: false });
          break;
        case 'by-type':
          q = q.order('type', { ascending: true })
               .order('created_at', { ascending: false });
          break;
        default:
          q = q.order('created_at', { ascending: false });
      }

      q = q.range(offset, offset + limit - 1);

      const { data, error, count } = await q;
      if (error) throw new Error(error.message);

      return { items: data ?? [], total: count ?? 0, offset, limit };
    },
  });
}
