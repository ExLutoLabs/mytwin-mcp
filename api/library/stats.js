// GET /api/library/stats
//
// Aggregate stats for the user's library. Runs three parallel Supabase
// queries; type + tag aggregation happens in JS so no SQL migrations are
// needed. Works for libraries up to ~500 items within the maxDuration budget.
//
// Response shape:
//   { totalItems, itemsByType, lastAddedAt, totalTags, mostUsedType }

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { getDB } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'library_stats',
    fn: async (ctx) => {
      const db = getDB();
      const { userId, tenantId } = ctx;

      const [totalRes, rowsRes, lastRes] = await Promise.all([
        // Exact row count — head:true skips fetching any rows
        db.from('knowledge')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('tenant_id', tenantId),

        // type + tags only — cheap even at 500 rows
        db.from('knowledge')
          .select('type, tags')
          .eq('user_id', userId)
          .eq('tenant_id', tenantId),

        // Most recent item for lastAddedAt
        db.from('knowledge')
          .select('created_at')
          .eq('user_id', userId)
          .eq('tenant_id', tenantId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (totalRes.error) throw new Error(totalRes.error.message);
      if (rowsRes.error)  throw new Error(rowsRes.error.message);
      // lastRes error is non-fatal (empty library returns null)

      const itemsByType = {};
      const tagSet = new Set();

      for (const { type, tags } of rowsRes.data ?? []) {
        if (type) itemsByType[type] = (itemsByType[type] || 0) + 1;
        if (Array.isArray(tags)) {
          for (const t of tags) {
            const clean = String(t || '').toLowerCase().trim();
            if (clean && clean !== 'untagged') tagSet.add(clean);
          }
        }
      }

      const topEntry = Object.entries(itemsByType).sort((a, b) => b[1] - a[1])[0];

      return {
        totalItems:   totalRes.count ?? 0,
        itemsByType,
        lastAddedAt:  lastRes.data?.created_at ?? null,
        totalTags:    tagSet.size,
        mostUsedType: topEntry
          ? { type: topEntry[0], count: topEntry[1] }
          : null,
      };
    },
  });
}
