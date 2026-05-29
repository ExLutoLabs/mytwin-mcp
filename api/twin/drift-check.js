// POST /api/twin/drift-check
//
// Checks all living documents for a tenant and writes any stale ones to
// background_log. Can be called manually or from a daily cron webhook.
//
// "Stale" = living document not updated in >= 7 days.
//
// Response: { checked: number, stale: number }

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { runDriftCheck }         from '../../lib/background-log.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  return runTwin(req, res, {
    toolName: 'drift_check',
    fn: async (ctx) => runDriftCheck(ctx.tenantId),
  });
}
