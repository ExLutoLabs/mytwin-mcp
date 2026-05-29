// GET /api/library/item/versions/[id]
//
// Returns the full version history for a knowledge item.
// Only includes past versions (knowledge_versions) — the current live version
// is fetched separately via GET /api/library/item/[id].
//
// Response:
//   {
//     versions: {
//       id:             string,
//       version_number: number,
//       title:          string,
//       content:        string,
//       replaced_at:    string,   // ISO timestamptz — when this version was superseded
//     }[]
//   }
//
// Multi-tenant safe: filters by both tenant_id AND user_id.
// Returns an empty array (not 404) if the item exists but has no history.

import { methodGuard, runTwin, HttpError } from '../../../../lib/twin-api.js';
import { getDB }                           from '../../../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'library_item_versions',
    fn: async (ctx) => {
      const { id } = req.query;
      if (!id) throw new HttpError(400, { error: 'id is required' });

      const db = getDB();

      // Verify the item exists and belongs to this tenant/user before
      // returning version history — prevents enumeration via version API.
      const { data: item, error: itemErr } = await db
        .from('knowledge')
        .select('id')
        .eq('id',         id)
        .eq('user_id',   ctx.userId)
        .eq('tenant_id', ctx.tenantId)
        .maybeSingle();

      if (itemErr) throw new Error(itemErr.message);
      if (!item)   throw new HttpError(404, { error: 'Item not found' });

      // Fetch all historical versions, newest first
      const { data: versions, error: vErr } = await db
        .from('knowledge_versions')
        .select('id, version_number, title, content, replaced_at')
        .eq('knowledge_id', id)
        .eq('tenant_id',    ctx.tenantId)
        .order('version_number', { ascending: false });

      if (vErr) throw new Error(vErr.message);

      return { versions: versions || [] };
    },
  });
}
