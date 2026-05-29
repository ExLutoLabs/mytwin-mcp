// GET /api/library/item/[id]
//
// Extended single-item detail endpoint for the library detail view.
// Returns the item itself plus fast DB-backed contextual panels (siblings and
// concept pages) — all in one round-trip.
//
// Related items (Pinecone) are fetched separately via /api/library/item/[id]/related
// so the detail view can render this response immediately without waiting for
// the vector search to complete.
//
// Response:
//   {
//     item:          KnowledgeItem,
//     siblings:      { id, title }[],                     — same source_ref, sorted by title
//     concept_pages: { id, flavour, title, summary }[],   — concepts this item feeds into
//   }
//
// Multi-tenant safe: every query filters by both tenant_id AND user_id.
// Returns 404 for any item not owned by the caller.

import { methodGuard, runTwin, HttpError } from '../../../lib/twin-api.js';
import { getDB } from '../../../lib/supabase.js';

const ITEM_SELECT    = 'id, type, title, content, tags, source_ref, provenance, created_at, updated_at, version_number, is_living_document, visibility';
const SIBLING_SELECT = 'id, title';
const CONCEPT_SELECT = 'id, flavour, title, summary';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PATCH'])) return;

  return runTwin(req, res, {
    toolName: 'library_item_detail',
    fn: async (ctx) => {
      const { id } = req.query;
      if (!id) throw new HttpError(400, { error: 'id is required' });

      const db = getDB();

      // ── PATCH — update visibility ──────────────────────────────────────────
      if (req.method === 'PATCH') {
        const { visibility } = req.body || {};
        if (!['private', 'sharable'].includes(visibility)) {
          throw new HttpError(400, { error: 'visibility must be "private" or "sharable"' });
        }
        const { data, error } = await db
          .from('knowledge')
          .update({ visibility })
          .eq('id', id)
          .eq('user_id',   ctx.userId)
          .eq('tenant_id', ctx.tenantId)
          .select('id, visibility')
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new HttpError(404, { error: 'Item not found' });
        return { id: data.id, visibility: data.visibility };
      }

      // ── Fetch the item itself first ───────────────────────────────────────
      const { data: item, error: itemErr } = await db
        .from('knowledge')
        .select(ITEM_SELECT)
        .eq('id',         id)
        .eq('user_id',   ctx.userId)
        .eq('tenant_id', ctx.tenantId)
        .maybeSingle();

      if (itemErr) throw new Error(itemErr.message);
      if (!item)   throw new HttpError(404, { error: 'Item not found' });

      // ── Fetch siblings and concept pages in parallel ──────────────────────
      const [siblingsResult, conceptsResult] = await Promise.allSettled([

        // 1. Siblings — same source_ref, different id, sorted naturally
        (async () => {
          if (!item.source_ref || item.source_ref === 'source not recorded') return [];
          const { data, error } = await db
            .from('knowledge')
            .select(SIBLING_SELECT)
            .eq('tenant_id',  ctx.tenantId)
            .eq('user_id',    ctx.userId)
            .eq('source_ref', item.source_ref)
            .neq('id',        id)
            .order('title', { ascending: true });
          if (error) { console.error('[item-detail] siblings error:', error.message); return []; }
          return data || [];
        })(),

        // 2. Concept pages this item feeds into
        (async () => {
          const { data, error } = await db
            .from('concept_pages')
            .select(CONCEPT_SELECT)
            .eq('tenant_id', ctx.tenantId)
            .eq('user_id',   ctx.userId)
            .contains('source_ids', [id]);
          if (error) { console.error('[item-detail] concepts error:', error.message); return []; }
          return data || [];
        })(),
      ]);

      return {
        item,
        siblings:      siblingsResult.status === 'fulfilled' ? siblingsResult.value : [],
        concept_pages: conceptsResult.status === 'fulfilled' ? conceptsResult.value : [],
      };
    },
  });
}
