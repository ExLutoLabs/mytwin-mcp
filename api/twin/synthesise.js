// POST /api/twin/synthesise — reflect across the tenant's knowledge.
//
// Two-step:
//   1. Call tools/retrieval.js#synthesise to retrieve relevant items + build
//      the synthesis prompt (this is the same path the MCP tool uses).
//   2. If items were found, hand the synthesis_prompt to Claude Sonnet 4.6
//      to produce the actual reflection text. The MCP path delegates this to
//      Claude Desktop; we have to do it server-side for the web frontend.
//
// Capped against the anonymous-tenant 'synthesise' counter (default 3 calls).

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { synthesise as synthesiseTool } from '../../tools/retrieval.js';
import { callTwin, responseText } from '../../lib/anthropic.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { topic, top_k, type } = req.body || {};
  if (typeof topic !== 'string' || !topic.trim()) {
    return res.status(400).json({ error: 'topic is required' });
  }

  return runTwin(req, res, {
    toolName: 'synthesise',
    cap:      'synthesise',
    fn: async (ctx) => {
      const retrieval = await synthesiseTool(ctx, { topic, top_k, type });

      // Nothing to synthesise — return the tool's reason verbatim so the
      // frontend can render the "add more content" CTA.
      if (!retrieval.synthesised) {
        return {
          synthesised: false,
          reason: retrieval.reason,
          topic,
        };
      }

      // The tool returns a fully-formed prompt; we just need to execute it.
      // `effort: high` here because synthesis is the marquee surface — quality
      // matters more than latency on what's at most 3 calls per session.
      const message = await callTwin({
        messages: [{ role: 'user', content: retrieval.synthesis_prompt }],
        maxTokens: 3072,
        effort:    'high',
      });

      return {
        synthesised:   true,
        topic,
        text:          responseText(message),
        chunk_count:   retrieval.chunk_count,
        sources:       retrieval.sources,
        // Slimmed citation list — id/type/title/display_ref is enough for the
        // frontend to render reference markers and link back to the library.
        citations: (retrieval.knowledge || []).map(k => ({
          id:          k.id,
          type:        k.type,
          title:       k.title,
          display_ref: k.display_ref,
          source_ref:  k.source_ref,
        })),
        usage: message.usage,
      };
    },
  });
}
