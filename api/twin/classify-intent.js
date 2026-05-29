// POST /api/twin/classify-intent
//
// Single Haiku call that classifies a user message and, when applicable,
// extracts a structured storage proposal. Built per the "anti-twin fix" brief:
// the bug it solves is that conversational openers ("Hey twin", "whats this")
// were being silently filed as Knowledge tagged with the literal opener word.
//
// Returns:
//   { intent: 'chat',      reason, confidence }
//   { intent: 'ambiguous', clarifying_question, reason, confidence }
//   { intent: 'store',     proposal: {title, tags, provenance, clarifying_question?},
//                          reason, confidence }
//
// Bias toward chat when in doubt. Storage is a deliberate act, not a default.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { callFastJson } from '../../lib/anthropic.js';

const SYSTEM_PROMPT = `You are the intent classifier for MyAITwin, a personal knowledge twin. The user is in a chat interface. Every message they send routes through you first.

Your job: decide whether the message is CHAT (talking to the twin) or STORE (handing the twin something to remember) or AMBIGUOUS (genuinely could go either way).

BIAS HEAVILY TOWARD CHAT. Storage is a deliberate act. If you're not confident the user is asking the twin to remember something, classify as chat or ambiguous, never store. Silent storage destroys trust.

=== CHAT signals (route here by default) ===
- Greetings: "hey", "hi", "hello twin", "morning", "what's up"
- Direct questions about the twin or its contents: "what is this?", "what can you do?", "what do I have stored?", "how does this work?", "who are you?"
- Meta-questions: anything about the twin itself
- Casual reactions: "cool", "nice", "ok", "got it"
- Conversational fragments under ~10 words with no clear content
- Anything that reads like talking, not handing over

=== STORE signals (only route here when clear) ===
- Substantial content (multiple sentences, paragraph-length)
- Explicit framing: "remember this", "store this", "save this", "capture this", "log this", "keep this"
- Quoted material the user wants to preserve
- Voice note transcripts, pasted excerpts
- Content that opens with framing: "Here's an idea...", "I just realised...", "Something I want to track...", "Note to self..."
- A clear thought or principle articulated in full

=== AMBIGUOUS signals (when truly unclear) ===
- Medium-length declarative input without an explicit storage cue
- Could read as the user thinking out loud or as the user wanting to file something

=== Hard rules ===
- "Hey twin" → chat. Always.
- "whats this" / "what is this" → chat. Always.
- Anything ending in "?" → chat (unless it's part of a longer captured thought).
- Anything under 8 words with no explicit storage signal → chat or ambiguous, never store.
- If the user explicitly says "remember this" or "save this" → store. Skip ambiguous.

=== When intent = store, generate a proposal ===
The user's content goes into a structured record. Extract:
- title: short, 3-7 words, descriptive. Pull from the substance of the content.
- tags: 3-5 SEMANTIC tags drawn from the content's actual substance. NEVER include the user's literal opener words (e.g. "hey", "twin", "this", "remember"). NEVER use single-word filler. If nothing meaningful can be extracted, return ["untagged"].
- provenance: "personal" by default. Use "external" if the user is quoting/citing someone else. Use "organisational" if it's clearly from their team/company.
- clarifying_question: optional. One short, voice-y question if you need to clarify intent — not about type, just about what the user means or wants to do.

Note: type is NOT your job. The user decides whether this is knowledge or a skill.

=== When intent = ambiguous ===
Return clarifying_question. Example: "Want me to remember this, or are we just chatting?"

=== When intent = chat ===
Just classify. Do not generate a response — that's another step.

=== Voice constraint ===
For any prose you do generate (clarifying_question), follow Luto voice: short sentences, no em dashes, no markdown, plain prose, wonder + competence.`;

// Anthropic strict-mode JSON schema rejects `type: ['string', 'null']`
// nullable arrays. Optional fields are just omitted from `required`.
const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent:     { type: 'string', enum: ['chat', 'store', 'ambiguous'] },
    confidence: { type: 'number' },
    reason:     { type: 'string' },
    clarifying_question: { type: 'string' },
    proposal: {
      type: 'object',
      properties: {
        title:               { type: 'string' },
        tags:                { type: 'array', items: { type: 'string' } },
        provenance:          { type: 'string', enum: ['personal', 'organisational', 'external'] },
        clarifying_question: { type: 'string' },
      },
      required: ['title', 'tags', 'provenance'],
      additionalProperties: false,
    },
  },
  required: ['intent', 'confidence', 'reason'],
  additionalProperties: false,
};

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { text, has_history } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  return runTwin(req, res, {
    toolName: 'classify_intent',
    // No cap — classification is cheap and unmetered for v1.
    fn: async (_ctx) => {
      const userBlock = [
        has_history ? '[There is conversation history — the user is mid-chat.]' : '[This is an early message in the conversation.]',
        '',
        '<user_message>',
        text,
        '</user_message>',
        '',
        'Classify the intent. Be biased toward chat. If store, generate the proposal.',
      ].join('\n');

      const { data, usage } = await callFastJson({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userBlock }],
        schema: INTENT_SCHEMA,
        maxTokens: 800,
      });

      return { ...data, usage };
    },
  });
}
