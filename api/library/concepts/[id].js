// GET /api/library/concepts/[id]
//
// Returns a single concept page with full content and joined source items.
// Multi-tenant safe: 404 for any page not owned by the caller (does not
// reveal whether the id exists in another tenant).
//
// Response shape:
//   {
//     concept:      ConceptPageFull,   — full concept including content field
//     source_items: KnowledgeItem[],   — the knowledge items that sourced it
//   }

import { methodGuard, runTwin, HttpError } from '../../../lib/twin-api.js';
import { getDB } from '../../../lib/supabase.js';

const CONCEPT_SELECT = 'id, flavour, title, summary, content, version, source_ids, created_at, updated_at';
const ITEM_SELECT    = 'id, type, title, content, tags, created_at';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'library_concept_detail',
    fn: async (ctx) => {
      const { id } = req.query;
      if (!id) throw new HttpError(400, { error: 'id is required' });

      const db = getDB();

      // Fetch the concept page (tenant-scoped)
      const { data: concept, error: conceptErr } = await db
        .from('concept_pages')
        .select(CONCEPT_SELECT)
        .eq('id',         id)
        .eq('user_id',   ctx.userId)
        .eq('tenant_id', ctx.tenantId)
        .maybeSingle();

      if (conceptErr) throw new Error(conceptErr.message);
      if (!concept)   throw new HttpError(404, { error: 'Concept not found' });

      // Fetch the source items — any that are still in the knowledge table
      let source_items = [];
      if (concept.source_ids?.length > 0) {
        const { data: items, error: itemsErr } = await db
          .from('knowledge')
          .select(ITEM_SELECT)
          .in('id', concept.source_ids)
          .eq('user_id',   ctx.userId)
          .eq('tenant_id', ctx.tenantId)
          .order('created_at', { ascending: false });

        if (itemsErr) throw new Error(itemsErr.message);
        source_items = items ?? [];
      }

      return { concept, source_items };
    },
  });
}
