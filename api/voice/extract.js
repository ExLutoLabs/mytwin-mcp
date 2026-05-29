// POST /api/voice/extract
//
// Extract 1-5 structured knowledge proposals from a voice recording transcript.
// One recording may contain multiple distinct ideas — each becomes its own
// proposal card the user can confirm or dismiss individually.
//
// Body:     { transcript: string, date?: string }
// Response: { proposals: Array<{ title, content, type, tags, provenance }> }
//
// Uses Haiku (fast + cheap) via callFastJson — same model as the intent
// classifier in /api/twin/turn. No storage cap consumed here; cap is charged
// only when the user confirms via /api/twin/confirm-store.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { callFastJson } from '../../lib/anthropic.js';

const MAX_TRANSCRIPT_CHARS = 8000; // roughly 5-6 minutes of speech

const EXTRACT_SYSTEM = `You are extracting knowledge proposals from a voice recording transcript.

The user spoke freely into a microphone. Identify 1-5 distinct knowledge items worth storing in their personal knowledge twin.

EXTRACTION RULES:
- Focus on: ideas, decisions, observations, insights, principles, things learned — not filler or conversational scaffolding
- One main idea → return 1 proposal. Multiple distinct topics → one proposal per topic.
- NEVER merge unrelated ideas. NEVER split one coherent idea across proposals.
- Each proposal's content should be the user's words, cleaned of false starts, ums, repetition — in clear prose.
- If nothing worth storing: return empty proposals array (honest > noisy).

FIELD RULES:
- title: 3-7 words, descriptive, drawn from the content
- content: 1-4 sentences. Clean up the speech. Preserve exact meaning and voice.
- type: "knowledge" (default — facts, ideas, decisions, observations) or "skill" (ONLY if explicitly about how the user does something — their style, method, process)
- tags: 3-5 semantic tags. Never filler words. Never the opener words ("hey", "twin", "this"). Return ["untagged"] if nothing meaningful.
- provenance: "personal" (their own thinking), "external" (citing someone else / an article / a book), "organisational" (team or company context)

VOICE CONSTRAINTS (Luto brand):
- No em dashes or en dashes in content
- Short sentences. Full stops. If you run out of breath reading it aloud, cut it.
- Specific, not vague. Use their actual words and numbers.`;

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title:      { type: 'string' },
          content:    { type: 'string' },
          type:       { type: 'string', enum: ['knowledge', 'skill'] },
          tags:       { type: 'array', items: { type: 'string' } },
          provenance: { type: 'string', enum: ['personal', 'organisational', 'external'] },
        },
        required: ['title', 'content', 'type', 'tags', 'provenance'],
        additionalProperties: false,
      },
    },
  },
  required: ['proposals'],
  additionalProperties: false,
};

// Tag stopwords — same policy as /api/twin/turn.
const TAG_STOPWORDS = new Set([
  'hi', 'hey', 'hello', 'twin', 'mytwin', 'myaitwin', 'this', 'that', 'thing',
  'something', 'remember', 'store', 'save', 'capture', 'note', 'untagged',
  'the', 'a', 'an', 'and', 'or', 'but', 'i', 'me', 'you', 'we', 'they',
  'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had',
]);

function cleanTags(rawTags) {
  if (!Array.isArray(rawTags) || !rawTags.length) return ['untagged'];
  const cleaned = rawTags
    .map(t => String(t).toLowerCase().trim())
    .filter(t => t.length >= 2 && !TAG_STOPWORDS.has(t));
  return cleaned.length ? [...new Set(cleaned)].slice(0, 5) : ['untagged'];
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { transcript, date } = req.body || {};
  if (typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: 'transcript is required' });
  }
  const trimmed = transcript.trim();
  if (trimmed.length > MAX_TRANSCRIPT_CHARS) {
    return res.status(400).json({
      error: `Transcript exceeds ${MAX_TRANSCRIPT_CHARS} character limit`,
    });
  }

  return runTwin(req, res, {
    toolName: 'voice_extract',
    fn: async () => {
      const userMsg = [
        date ? `Recording date: ${date}` : null,
        '<transcript>',
        trimmed,
        '</transcript>',
        '',
        'Extract knowledge proposals from this voice recording.',
      ].filter(Boolean).join('\n');

      const { data } = await callFastJson({
        system:    EXTRACT_SYSTEM,
        messages:  [{ role: 'user', content: userMsg }],
        schema:    EXTRACT_SCHEMA,
        maxTokens: 1200,
      });

      const proposals = (data.proposals || [])
        .slice(0, 5)
        .map(p => ({
          ...p,
          tags: cleanTags(p.tags),
        }));

      return { proposals };
    },
  });
}
