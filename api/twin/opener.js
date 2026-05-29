// GET /api/twin/opener
//
// Returns the proactive session opener for the /twin web chat: the single most
// valuable thing to surface before the user asks (a drafted skill waiting, a
// recurring gap, or the most recent thread). Shares buildOpener with the
// get_welcome MCP tool so both surfaces behave identically (v2 brief Phase 3).
//
// Response shape: { kind, line, total, typeCount }
//   kind ∈ 'new' | 'skill_proposal' | 'skill_gap' | 'recent'
//   line is null when kind === 'new' (the client renders its onboarding copy).

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { buildOpener } from '../../tools/welcome.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'opener',
    fn: async (ctx) => buildOpener(ctx),
  });
}
