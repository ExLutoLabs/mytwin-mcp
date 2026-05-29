// GET /api/twin/search?q=...&type=...&top_k=10
//
// Semantic search across the tenant's knowledge — direct passthrough to
// tools/retrieval.js#searchTwin. Read-only, not capped.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { searchTwin } from '../../tools/retrieval.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  const q     = req.query.q;
  const type  = req.query.type;
  const top_k = req.query.top_k ? Number(req.query.top_k) : undefined;

  if (typeof q !== 'string' || !q.trim()) {
    return res.status(400).json({ error: 'q (query) is required' });
  }

  return runTwin(req, res, {
    toolName: 'search_twin',
    fn: (ctx) => searchTwin(ctx, { query: q, top_k, type }),
  });
}
