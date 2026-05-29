// POST /api/twin/patterns — surface recurring themes across stored knowledge.
//
// Direct passthrough to tools/analysis.js#findPatternsInKnowledge. That tool
// runs its own LLM pass internally (via OpenAI), so we don't need an extra
// Claude call here — the response is already structured.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { findPatternsInKnowledge } from '../../tools/analysis.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { focus } = req.body || {};

  return runTwin(req, res, {
    toolName: 'find_patterns',
    fn: (ctx) => findPatternsInKnowledge(ctx, { focus }),
  });
}
