// GET /api/twin/by-tag/[tag]?limit=20
//
// All items carrying a specific tag, newest first.

import { methodGuard, runTwin } from '../../../lib/twin-api.js';
import { getByTag } from '../../../tools/retrieval.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  const { tag } = req.query;
  if (typeof tag !== 'string' || !tag) {
    return res.status(400).json({ error: 'tag is required in the path' });
  }
  const limit = req.query.limit ? Number(req.query.limit) : undefined;

  return runTwin(req, res, {
    toolName: 'get_by_tag',
    fn: (ctx) => getByTag(ctx, { tag, limit }),
  });
}
