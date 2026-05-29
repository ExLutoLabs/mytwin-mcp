// POST /api/twin/knowledge — store a typed knowledge item.
//
// Wraps tools/storage.js#addKnowledge with the standard twin-API plumbing
// (anonymous-tenant resolution + 'storage' cap + audit). Body shape mirrors
// the MCP tool's input (sans the MCP-only `manual_tags` rename).

import { methodGuard, runTwin } from '../../../lib/twin-api.js';
import { addKnowledge } from '../../../tools/storage.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { type, content, title, tags, source_ref, provenance } = req.body || {};

  return runTwin(req, res, {
    toolName: 'add_knowledge',
    cap:      'storage',
    fn: (ctx) => addKnowledge(ctx, {
      type,
      content,
      title,
      source_type: 'typed',
      source_ref,
      manual_tags: tags,
      provenance,
    }),
  });
}
