// GET /api/twin/recent?limit=10&type=...
//
// Most recent items for the tenant, newest first. Used by the /twin page's
// knowledge library sidebar to refresh after a capture.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { listRecent } from '../../tools/management.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  const type  = req.query.type;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;

  return runTwin(req, res, {
    toolName: 'list_recent',
    fn: (ctx) => listRecent(ctx, { limit, type }),
  });
}
