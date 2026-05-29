// PATCH /api/twin/knowledge/[id] — update fields on a stored item.
// DELETE /api/twin/knowledge/[id] — delete an item.

import { methodGuard, runTwin } from '../../../lib/twin-api.js';
import { updateKnowledge, deleteKnowledge } from '../../../tools/management.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['PATCH', 'DELETE'])) return;

  const { id } = req.query;
  if (typeof id !== 'string' || !id) {
    return res.status(400).json({ error: 'id is required in the path' });
  }

  if (req.method === 'DELETE') {
    return runTwin(req, res, {
      toolName: 'delete_knowledge',
      fn: (ctx) => deleteKnowledge(ctx, { id }),
    });
  }

  // PATCH
  const { content, title, tags, type, provenance } = req.body || {};
  return runTwin(req, res, {
    toolName: 'update_knowledge',
    fn: (ctx) => updateKnowledge(ctx, { id, content, title, tags, type, provenance }),
  });
}
