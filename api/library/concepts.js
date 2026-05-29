// GET /api/library/concepts
//
// Returns concept pages for the authenticated tenant, split by flavour.
// Multi-tenant safe: queries filter by both tenant_id AND user_id.
//
// Response shape:
//   {
//     knowledge: ConceptPage[],
//     skills:    ConceptPage[],
//     total:    number,
//     last_compiled_at: string | null,
//     item_count: number,                 // stored knowledge items (need >=2 to compile)
//     compile_status: { status, meta, created_at } | null,  // latest compile run
//   }
//
// item_count + compile_status let the Wiki show an HONEST empty state instead
// of an eternal "still compiling": too few items, a real failure, or simply
// "not built yet" with a Compile-now affordance.
//
// ConceptPage: { id, flavour, title, summary, version, source_ids, updated_at }

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { getDB } from '../../lib/supabase.js';
import { getRecentBackgroundLog } from '../../lib/background-log.js';

const SELECT = 'id, flavour, title, summary, version, source_ids, updated_at';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'library_concepts',
    fn: async (ctx) => {
      const db = getDB();

      const [pagesRes, countRes, compileLog] = await Promise.all([
        db
          .from('concept_pages')
          .select(SELECT)
          .eq('user_id',   ctx.userId)
          .eq('tenant_id', ctx.tenantId)
          .order('updated_at', { ascending: false }),
        db
          .from('knowledge')
          .select('id', { count: 'exact', head: true })
          .eq('user_id',   ctx.userId)
          .eq('tenant_id', ctx.tenantId),
        // Look back 7 days so a recent failed/stalled run still surfaces.
        getRecentBackgroundLog(ctx.tenantId, 'concept-compile', 24 * 7),
      ]);

      if (pagesRes.error) throw new Error(pagesRes.error.message);

      const pages = pagesRes.data ?? [];
      const knowledge = pages.filter(p => p.flavour === 'knowledge');
      const skills    = pages.filter(p => p.flavour === 'skills');

      // last_compiled_at = most recently updated page across both flavours
      const last_compiled_at = pages.length > 0 ? pages[0].updated_at : null;

      return {
        knowledge,
        skills,
        total: pages.length,
        last_compiled_at,
        item_count: countRes.count ?? 0,
        compile_status: compileLog,
      };
    },
  });
}
