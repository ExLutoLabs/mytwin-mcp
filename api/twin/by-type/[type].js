// GET /api/twin/by-type/[type]?limit=20
//
// All items of a specific type, newest first.

import { methodGuard, runTwin } from '../../../lib/twin-api.js';
import { getByType } from '../../../tools/retrieval.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  const { type } = req.query;
  if (typeof type !== 'string' || !type) {
    return res.status(400).json({ error: 'type is required in the path' });
  }
  const limit = req.query.limit ? Number(req.query.limit) : undefined;

  return runTwin(req, res, {
    toolName: 'get_by_type',
    fn: (ctx) => getByType(ctx, { type, limit }),
  });
}
