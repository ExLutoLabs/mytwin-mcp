// POST /api/twin/chat — conversational interface over the twin.
//
// Body: { messages: [{ role: 'user'|'assistant', content: string }, ...] }
//
// Flow:
//   1. Pull the last user turn → run searchTwin against it to retrieve the
//      top relevant knowledge items for this question.
//   2. Build a Claude message list that mirrors the conversation history,
//      with the retrieved items injected into the last user turn inside an
//      <untrusted_knowledge> block (same convention as the synthesise tool
//      — keeps prompt-injection guard surface consistent).
//   3. Call Claude Sonnet 4.6 with the cached SYSTEM_PROMPT + an extra system
//      note telling it how to cite.
//   4. Return the rendered text + citation list so the frontend can render
//      reference markers ([1], [2], ...) as clickable items.
//
// Capped against the anonymous-tenant 'chat' counter (default 20 calls).

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { searchTwin } from '../../tools/retrieval.js';
import { callTwin, responseText } from '../../lib/anthropic.js';

const RETRIEVAL_K = 6;
const MAX_HISTORY_TURNS = 12; // last 12 turns is plenty for v1; older context is dropped

const CITATION_INSTRUCTION = [
  'You are running inside the MyAITwin web interface (myaitwin.lutolearn.com/twin), in a chat window with the user who is starting to build their twin.',
  '',
  'WHAT THIS TOOL IS — for when the user asks "what are you", "what is this", "what can you do", "how do I use this", or similar.',
  'Briefly: you are MyAITwin. The user builds you by adding things they want to keep. Anything they paste, dictate as a voice note, or upload as a document gets stored, auto-tagged, and indexed so they can search it back later. You separate two layers on purpose:',
  '  * knowledge — what they know: facts, decisions, transcripts, observations, ideas',
  '  * skills — how they express things: their writing voice, email structure, proposal style',
  'Then they can ask you questions and you answer using what they have added, with each source cited. The Reflect button (active once they have 3+ items) runs a synthesis across what they have given you and surfaces themes and patterns. The whole twin can also be installed in Claude or ChatGPT via the MCP server, so the same twin follows them across tools.',
  '',
  'WHEN ANSWERING A QUESTION:',
  'If relevant knowledge is provided in the <untrusted_knowledge> block below, USE it and cite items inline using bracketed reference numbers like [1], [2] that map to the order they appear.',
  'If the retrieved knowledge does not actually answer the question, say so honestly. Do not invent a citation. You can still respond conversationally using what you know more broadly.',
  '',
  'STYLE — strict:',
  '* Maximum 3 short paragraphs. Often 1-2 is enough.',
  '* No markdown. No asterisks for bold. No hyphens or dashes for bullet lists. No headers. Plain prose only.',
  '* No em dashes or en dashes anywhere. Use full stops or commas. If you cannot, rewrite the sentence.',
  '* Short sentences. Read each one aloud. If you run out of breath, cut it.',
  '* The Luto voice. Genuine wonder paired with honest competence. Specific, not vague.',
].join('\n');

function buildKnowledgeBlock(items) {
  if (!items?.length) return '';
  const body = items.map((r, i) =>
    `[${i + 1}] ${r.type.toUpperCase()}${r.title ? `: ${r.title}` : ''}\n${r.summary || ''}\nSource: ${r.source_ref}\nAdded: ${r.created_at}`
  ).join('\n\n---\n\n');
  return `<untrusted_knowledge>\n${body}\n</untrusted_knowledge>\n\n`;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const body = req.body || {};
  const inMessages = Array.isArray(body.messages) ? body.messages : null;
  if (!inMessages || inMessages.length === 0) {
    return res.status(400).json({ error: 'messages (non-empty array) is required' });
  }
  const lastTurn = inMessages[inMessages.length - 1];
  if (!lastTurn || lastTurn.role !== 'user' || typeof lastTurn.content !== 'string' || !lastTurn.content.trim()) {
    return res.status(400).json({ error: 'last message must be a user turn with non-empty string content' });
  }

  return runTwin(req, res, {
    toolName: 'chat',
    cap:      'chat',
    fn: async (ctx) => {
      // 1. Retrieve relevant knowledge for the user's last message.
      const search = await searchTwin(ctx, { query: lastTurn.content, top_k: RETRIEVAL_K });
      const items = search.results || [];

      // 2. Build Claude message list. Trim history to the last
      //    MAX_HISTORY_TURNS to keep prompt size predictable.
      const trimmed = inMessages.slice(-MAX_HISTORY_TURNS);
      // Validate + coerce each message into the Anthropic shape.
      const messages = trimmed.slice(0, -1).map(m => ({
        role:    m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : String(m.content || ''),
      }));
      const knowledgeBlock = buildKnowledgeBlock(items);
      messages.push({
        role: 'user',
        content: knowledgeBlock + lastTurn.content,
      });

      // 3. Call Claude.
      const message = await callTwin({
        messages,
        maxTokens:   1536,
        effort:      'medium',
        extraSystem: CITATION_INSTRUCTION,
      });

      // 4. Return text + citations for the frontend to render.
      return {
        text: responseText(message),
        citations: items.map(r => ({
          id:          r.id,
          type:        r.type,
          title:       r.title,
          display_ref: r.display_ref,
          source_ref:  r.source_ref,
          relevance:   r.relevance,
        })),
        usage: message.usage,
      };
    },
  });
}
