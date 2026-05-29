// GET /api/voice/history
//
// Returns knowledge items that originated from voice recordings, with concept
// page linkage data so the Voice tab can show "→ filed into: [concept]".
//
// Covers both storage paths:
//   - source_type = 'voice-note'    — items stored via the legacy /api/twin/voice-note endpoint
//   - source_type = 'voice-capture' — items confirmed via the new voice-capture → confirm-store flow
//
// Response shape:
//   {
//     items: Array<{ id, type, title, content, source_ref, created_at, tags }>,
//     concept_map: Record<itemId, { id: string, title: string }>,
//   }
//
// concept_map maps each item ID to the first concept page that includes it in
// its source_ids array. Clients use this to render "filed into: [concept]" links.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { getDB } from '../../lib/supabase.js';

const KNOWLEDGE_SELECT = 'id, type, title, content, source_ref, created_at, tags';
const CONCEPTS_SELECT  = 'id, title, flavour, source_ids';
const VOICE_TYPES      = ['voice-note', 'voice-capture'];

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'voice_history',
    fn: async (ctx) => {
      const db = getDB();

      // Fetch voice items — newest first, max 50
      const { data: items, error: itemsErr } = await db
        .from('knowledge')
        .select(KNOWLEDGE_SELECT)
        .eq('user_id',   ctx.userId)
        .eq('tenant_id', ctx.tenantId)
        .in('source_type', VOICE_TYPES)
        .order('created_at', { ascending: false })
        .limit(50);

      if (itemsErr) throw new Error(itemsErr.message);

      const safeItems = items ?? [];
      if (safeItems.length === 0) {
        return { items: [], concept_map: {} };
      }

      // Fetch concept pages to build linkage map (non-fatal)
      const conceptMap = {};
      try {
        const { data: pages } = await db
          .from('concept_pages')
          .select(CONCEPTS_SELECT)
          .eq('user_id',   ctx.userId)
          .eq('tenant_id', ctx.tenantId);

        if (pages && pages.length > 0) {
          const itemIds = new Set(safeItems.map(i => i.id));
          for (const page of pages) {
            const ids = Array.isArray(page.source_ids) ? page.source_ids : [];
            for (const id of ids) {
              // First match wins — most items belong to at most one concept page
              if (itemIds.has(id) && !conceptMap[id]) {
                conceptMap[id] = { id: page.id, title: page.title };
              }
            }
          }
        }
      } catch { /* concept linkage is supplementary — never fail the request */ }

      return { items: safeItems, concept_map: conceptMap };
    },
  });
}
