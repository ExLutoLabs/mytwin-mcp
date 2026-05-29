// GET /api/twin/background-panel?since=ISO_DATE
//
// Returns background job activity and pending skill proposals for the
// "In the Background" context panel section.
//
// Response shape:
//   {
//     logs:      [{ job_name, meta, created_at }],  // completed entries since `since`
//     proposals: [{ id, title, description }],       // pending skill proposals
//     concepts:  [{ id, title, source_ids, created_at, updated_at }]  // pages updated since `since`
//   }
//
// All three arrays default to [] on any DB failure — this is a non-critical UI feed.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { getDB } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'background_panel',
    fn: async (ctx) => {
      const since = typeof req.query.since === 'string' && req.query.since
        ? req.query.since
        : new Date(0).toISOString();

      const db = getDB();

      const [logsResult, proposalsResult, conceptsResult] = await Promise.allSettled([
        // Recent completed background log entries since last visit
        db.from('background_log')
          .select('job_name, status, meta, created_at')
          .eq('tenant_id', ctx.tenantId)
          .eq('status', 'completed')
          .gt('created_at', since)
          .order('created_at', { ascending: false })
          .limit(10),

        // Pending skill proposals for this user
        db.from('skill_proposals')
          .select('id, title, description')
          .eq('tenant_id', ctx.tenantId)
          .eq('user_id', ctx.userId)
          .eq('status', 'pending')
          .order('created_at', { ascending: false }),

        // Concept pages updated since last visit (for compile-concepts messages)
        db.from('concept_pages')
          .select('id, title, source_ids, created_at, updated_at')
          .eq('tenant_id', ctx.tenantId)
          .gt('updated_at', since)
          .order('updated_at', { ascending: false })
          .limit(5),
      ]);

      return {
        logs:      logsResult.status === 'fulfilled'      ? (logsResult.value.data      || []) : [],
        proposals: proposalsResult.status === 'fulfilled' ? (proposalsResult.value.data || []) : [],
        concepts:  conceptsResult.status === 'fulfilled'  ? (conceptsResult.value.data  || []) : [],
      };
    },
  });
}
