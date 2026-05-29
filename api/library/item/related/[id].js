// GET /api/library/item/related/[id]
//
// Returns semantically related items for a given knowledge item, via Pinecone.
// Called separately from the main item-detail endpoint so the UI can show the
// item content immediately without waiting for the vector search (~200-400ms).
//
// Response:
//   {
//     related: { id, title, type, summary, created_at }[]   — top 3, excluding self
//   }

import { methodGuard, runTwin, HttpError } from '../../../../lib/twin-api.js';
import { getDB } from '../../../../lib/supabase.js';
import { searchTwin } from '../../../../tools/retrieval.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'library_item_related',
    fn: async (ctx) => {
      const { id } = req.query;
      if (!id) throw new HttpError(400, { error: 'id is required' });

      const db = getDB();

      // Fetch the item title + content for the embedding query
      const { data: item, error: itemErr } = await db
        .from('knowledge')
        .select('id, title, content')
        .eq('id',         id)
        .eq('user_id',   ctx.userId)
        .eq('tenant_id', ctx.tenantId)
        .maybeSingle();

      if (itemErr) throw new Error(itemErr.message);
      if (!item)   throw new HttpError(404, { error: 'Item not found' });

      const query = [item.title, item.content]
        .filter(Boolean)
        .join(' ')
        .slice(0, 500);

      try {
        const { results } = await searchTwin(ctx, { query, top_k: 4 });
        const related = (results || [])
          .filter(r => r.id !== id)
          .slice(0, 3)
          .map(r => ({
            id:         r.id,
            title:      r.title,
            type:       r.type,
            summary:    r.summary,
            created_at: r.date,
          }));
        return { related };
      } catch (err) {
        // Pinecone errors are non-fatal for related items
        console.error('[item-related] Pinecone error:', err.message);
        return { related: [] };
      }
    },
  });
}
