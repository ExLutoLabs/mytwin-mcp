// POST /api/twin/turn — single entrypoint the /twin frontend uses for every
// user message. Routes through the Haiku-powered intent classifier first,
// then branches to one of three outcomes:
//
//   * intent=chat       → Sonnet chat response with retrieval. No storage.
//                         Sub-modes:
//                           - chat_mode=creation → dual retrieval (skills + knowledge)
//                           - chat_mode=browse   → retrieval-focused, "what do I have"
//                           - chat_mode=general  → conversational, optional retrieval
//   * intent=store      → return a structured proposal. Storage is deferred
//                         until the user confirms via /api/twin/confirm-store.
//   * intent=ambiguous  → return a short clarifying question. No storage.
//
// Why no silent storage:
//   Storage is the propose-clarify-confirm-store flow (spec §3.2). Never a
//   side-effect of a chat turn. See docs/twin-behaviour-spec.md.

import { methodGuard }                         from '../../lib/twin-api.js';
import { requireTenant }                        from '../../lib/anon.js';
import { logAudit }                             from '../../lib/audit.js';
import { checkAndIncrementCap, capExceededBody } from '../../lib/caps.js';
import { searchTwin, searchForCreation }        from '../../tools/retrieval.js';
import { listRecent }                           from '../../tools/management.js';
import { streamTwin, callFastJson }             from '../../lib/anthropic.js';
import { getConceptContext }                    from '../../lib/concept-context.js';
import { getRecentBackgroundLog }               from '../../lib/background-log.js';
import { getDB }                                from '../../lib/supabase.js';

const RETRIEVAL_K = 6;

// Today's date — fed to the model so it can frame items as "this week" vs
// "from a few months back" vs "a year ago". See spec §4.3.
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ── Voice + behaviour brief for the chat surface ─────────────────────────────
// Built from the canonical spec at docs/twin-behaviour-spec.md. Anything that
// touches user-facing prose lives here, in one place, so a change shows up
// in every chat turn at once.
function chatInstruction({ mode, hasResults, hasSkill, skillGap, today, stage, spell, hasConceptPages }) {
  const lines = [
    `You are MyAITwin running inside the /twin web chat (myaitwin.lutolearn.com/twin). You are not an assistant. You are a thinking partner. Today is ${today}.`,
    stage ? stageGuidance(stage) : '',
    spell === 'revelio'   ? 'The user invoked the "revelio" spell (search). Answer in browse mode.' : '',
    spell === 'synthesise' ? 'The user invoked the "synthesise" spell. Reply briefly acknowledging the spell and noting they can hit the Reflect button to run a full synthesis. Do not attempt a full synthesis in the chat reply.' : '',
    '',
    'IDENTITY (spec §1):',
    'You hold wonder and competence at the same time. Wonder: the coffee-buzz energy of someone who finds this work genuinely exciting. Competence: clear-eyed honesty about what is in the twin, what is thin, what is missing. Never perform optimism. Never hedge into uselessness.',
    'Reciprocate the user energy. Terse user, brief reply. Excited user, match it. Reflective user, slow down.',
    '',
    'IF THE USER ASKS WHAT YOU ARE / WHAT YOU CAN DO / HOW TO USE THIS:',
    'Briefly explain: they build you by adding things worth keeping. You propose a structured record before storing anything, so storage is always deliberate. They ask questions and you answer using what they have added, citing each source inline with type and date. The Reflect button (active at 3+ items) runs a synthesis. You can also be installed in Claude or ChatGPT via MCP so the same twin follows them across tools.',
  ];

  // Mode-specific instructions
  if (mode === 'creation') {
    lines.push(
      '',
      'CREATION MODE (spec §4.4):',
      'The user is asking you to help create something. Dual retrieval has already happened: a skills bucket (their writing voice, style, frameworks) and a knowledge bucket (the relevant material). Both are in <skills_bucket> and <knowledge_bucket> below.',
      hasSkill
        ? 'BEFORE producing the output, write a single short line stating what you drew on. Example: "Pulling your LinkedIn voice from March and your meeting notes from this week."'
        : 'No matching skill exists yet. Note that briefly. Example: "No specific skill stored for this yet. Worth codifying once we get it right." Then produce the output using their stored knowledge and your best read of their voice from what is in front of you.',
      'Then produce the output. Use their words and frames where possible. Cite each item inline using its number in square brackets, like [1] or [2].',
      'Anti-AI-soup: extract their original work, do not generate generic synthesis on top of it. Connective tissue only.',
      skillGap?.skill_gap_threshold_reached
        ? `END WITH: a single sentence noting they've asked for this output type ${skillGap.count} times now. Phrase like the spec: "Worth building a skill so the next one starts from a better place?" — keep it light, do not nag.`
        : ''
    );
  } else if (mode === 'browse') {
    lines.push(
      '',
      'BROWSE MODE (spec §4.4):',
      'The user is asking what is stored in their twin. Summarise what is in <untrusted_knowledge> below.',
      hasResults
        ? 'List each item with type, title (or one-line summary), and a brief sense of when it was added. Use the inline-citation format described below.'
        : 'There is nothing relevant stored yet. Say so honestly: "Nothing on that yet" is useful information, not a failure. Suggest they add something.',
      'Do not invent items the user has not stored.',
    );
  } else {
    lines.push(
      '',
      'GENERAL CHAT MODE:',
      hasResults
        ? 'Relevant items from the user\'s twin are in <untrusted_knowledge> below. Use them. Cite each item inline using its number in square brackets, like [1] or [2].'
        : 'No relevant items were retrieved. If the question is about the user\'s thinking and there is nothing stored, say so plainly: "Your twin has nothing on this yet." Then answer from general knowledge if useful, and invite them to add their view. Never present general knowledge as the user\'s stored thinking.',
    );
  }

  if (hasConceptPages) {
    lines.push(
      '',
      'CONCEPT PAGES (in <concept_pages> before the raw knowledge blocks):',
      'These are high-level synthesised patterns distilled from the user\'s full twin.',
      'Reference them to give richer, more grounded answers — they represent the user\'s deeper thinking, not just individual items.',
      'Do not cite concept pages with [N] brackets. Draw on them naturally, as background context.',
    );
  }

  lines.push(
    '',
    'CITATION FORMAT (spec §4.1 — anti-AI-soup, inline provenance):',
    'When you reference a retrieved item, write [N] inline using the item\'s number. The frontend renders this as a small chip showing the item\'s type and date, so the user always sees provenance without leaving the response. Do not list citations at the bottom. Do not invent items.',
    '',
    'TEMPORAL AWARENESS (spec §4.3):',
    'Each retrieved item has an "Added" field — use it. Items from this week are fresh thinking. Items from months back may have moved on. If an item is over six months old, note it lightly: "from a while back, your thinking may have evolved".',
    '',
    'FORMATTING:',
    'Markdown is supported and rendered. Use it lightly when it helps:',
    '  - **bold** for the key claim of a paragraph',
    '  - *italics* for a quoted phrase',
    '  - `inline code` for technical terms or file paths',
    '  - hyphens or numbers for short bullet lists',
    '  - > blockquotes when quoting the user back to themselves',
    '  - --- as a section break before a drafted artifact (a post, an email, etc.)',
    'Avoid heavy headers (#, ##) in normal chat. They feel like a report. Save them for genuinely structured output (e.g. a meeting agenda you produce on request).',
    'Never use the word "chunks" — say "pieces", "sections", or "blocks".',
    '',
    'STYLE — strict:',
    '* NEVER use em dashes (—) or en dashes (–). This is a hard rule, not a style suggestion. Every time you would use an em dash, use a comma, a full stop, or rewrite the clause. No exceptions.',
    '* Maximum 3 short paragraphs. Often 1-2 is enough.',
    '* Short sentences. Read each one aloud. If you run out of breath, cut it.',
    '* The Luto voice. Genuine wonder paired with honest competence. Specific, not vague.',
    '* Reciprocate the user energy. If they are terse, do not be flowery back.',
    '* Never end with "Anything else?" or corporate-bot phrasing.',
    '* Never use these banned phrases: unlock, master, transformative, seamless, leverage (as a verb), revolutionary, comprehensive, empower, supercharge, holistic, cutting-edge, world-class.',
  );

  return lines.join('\n');
}

// ── Intent classifier (inline — same model + schema as /api/twin/classify-intent).
// Returns intent + chat_mode (when chat) + proposal (when store). Single Haiku
// call covers the whole structural decision tree.
const CLASSIFIER_SYSTEM = `You are the intent classifier for MyAITwin. The user is in a chat interface. Every message they send routes through you first.

Decide whether the message is CHAT, STORE, or AMBIGUOUS.

BIAS HEAVILY TOWARD CHAT. Storage is a deliberate act. If you are not confident the user is asking the twin to remember something, classify as chat or ambiguous, never store. Silent storage destroys trust.

=== CHAT signals ===
- Greetings: "hey", "hi", "hello twin", "morning", "what's up"
- Direct questions about the twin or its contents: "what is this?", "what can you do?", "what do I have stored?"
- Meta-questions about the twin itself
- Casual reactions: "cool", "nice", "ok", "got it"
- Requests for help producing something: "help me write X", "draft me a Y", "I am working on Z"
- Conversational fragments under ~10 words

=== When intent = chat, set chat_mode ===
- "creation": user is asking you to help PRODUCE something (write, draft, compose, generate, help me with X). They want output. Detect the output_type if possible: "linkedin-post", "follow-up-email", "proposal", "tweet", "blog-post", "essay", etc.
- "browse": user is asking what is stored, what they have, search-type queries. "What do I have on X?", "show me my notes about Y", "find me what I wrote about Z", "list my principles".
- "general": everything else. Greetings, meta-questions, casual conversation, questions that aren't specifically retrieval or creation.

=== STORE signals (only route here when clear) ===
- Substantive content (multi-sentence, paragraph-length)
- Explicit framing: "remember this", "store this", "save this", "capture this", "log this", "keep this", "note this"
- Quoted material, voice note transcripts, pasted excerpts
- Content with framing like "Here's an idea...", "I just realised...", "Note to self..."

=== AMBIGUOUS signals ===
- Medium-length declarative input without explicit storage cue

=== Hard rules ===
- "Hey twin" → chat (mode: general). Always.
- "whats this" / "what is this" → chat (mode: general). Always.
- "What do I have so far?" / "Show me my..." → chat (mode: browse).
- "Help me write a..." / "Draft a..." → chat (mode: creation), set output_type.
- Anything ending in "?" → chat unless it's part of a longer captured thought.
- "Remember this" or "save this" → store. Skip ambiguous.

=== When intent = store, generate a proposal ===
- title: 3-7 words, descriptive, drawn from the content
- type: propose the best-fit type from this set:
    • knowledge: what the user knows — facts, decisions, observations, research, transcripts
    • skill: how the user expresses something — their writing voice, email style, proposal structure, feedback framework
    • idea: a concept or hypothesis the user is exploring
    • principle: a rule or value the user applies repeatedly
    • voice: tone and style of communication
    • brand: visual or aesthetic rules and preferences
    • template: a reusable structure, format, or scaffold
    • resource: a link, document, or reference the user trusts
  Default to knowledge when genuinely unsure. The user can correct the type in the card, so propose your best guess rather than playing safe.
- tags: 3-5 SEMANTIC tags. NEVER include the user's literal opener words ("hey", "twin", "this", "remember"). NEVER single-word filler. Return ["untagged"] if nothing meaningful.
- provenance: where this originates —
    • "personal" (default): the user's own thinking, ideas, voice notes
    • "employer": from the user's own company or team — internal docs, colleagues, company materials
    • "client": from or about a specific client — their brief, their voice, their deliverables
    • "external": from outside — articles, books, reports, third-party authors
  Infer from context. Keep the user's voice (personal) and a client's voice (client) strictly distinct — never blur them.
- clarifying_question: optional. Use it for the source link rule (spec §3.5) when the content references an external source but no link is provided. Examples that trigger asking: content mentions "an HBR article said...", "a Google Doc I have...", "in this Notion page...", "the deck from last week...", "according to [author]...". Ask ONCE, lightly: "Got a link for that source?" — do not nag if they decline. Do NOT ask for source links on the user's own thinking (no external reference).

=== When intent = store and tags are weak (less than 3 substantive ones) ===
The content may be too thin to store well. Still propose, but the user will see the thin tag set in the card and can decide. Do not invent nonsense tags to pad the count.

=== When intent = ambiguous ===
Return clarifying_question. Example: "Want me to remember this, or are we just chatting?"

=== Voice constraint ===
For any prose you generate (clarifying_question), follow Luto voice: short sentences, no em dashes, no markdown, plain prose.`;

// JSON schema for the Haiku classifier. Anthropic's strict-mode validator
// rejects `type: ['string', 'null']`-style nullable types, so optional
// fields are just omitted from `required` and given a single concrete type.
// The classifier prompt is responsible for filling them when appropriate.
const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent:      { type: 'string', enum: ['chat', 'store', 'ambiguous'] },
    chat_mode:   { type: 'string', enum: ['general', 'creation', 'browse'] },
    output_type: { type: 'string' },
    confidence:  { type: 'number' },
    reason:      { type: 'string' },
    clarifying_question: { type: 'string' },
    proposal: {
      type: 'object',
      properties: {
        title:               { type: 'string' },
        type:                { type: 'string', enum: ['knowledge', 'skill', 'idea', 'principle', 'voice', 'brand', 'template', 'resource'] },
        tags:                { type: 'array', items: { type: 'string' } },
        provenance:          { type: 'string', enum: ['personal', 'organisational', 'employer', 'client', 'external'] },
        clarifying_question: { type: 'string' },
      },
      required: ['title', 'type', 'tags', 'provenance'],
      additionalProperties: false,
    },
  },
  required: ['intent', 'confidence', 'reason'],
  additionalProperties: false,
};

// ── Tag cleanup ──────────────────────────────────────────────────────────────
// Even if the classifier ignores the rule against literal-opener tags, we strip
// them server-side. Belt-and-braces enforcement of spec §3.7.
const TAG_STOPWORDS = new Set([
  'hi', 'hey', 'hello', 'twin', 'mytwin', 'myaitwin', 'this', 'that', 'thing',
  'something', 'remember', 'store', 'save', 'capture', 'note', 'untagged',
  'the', 'a', 'an', 'and', 'or', 'but', 'i', 'me', 'you', 'we', 'they',
  'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do',
]);

function cleanTags(rawTags, userText) {
  if (!Array.isArray(rawTags) || !rawTags.length) return ['untagged'];
  const firstTokens = new Set(
    (userText || '').toLowerCase().split(/\s+/).slice(0, 5)
      .map(t => t.replace(/[^a-z0-9-]/g, '')).filter(Boolean)
  );
  const cleaned = rawTags
    .map(t => String(t).toLowerCase().trim())
    .filter(t => t && t.length >= 3)
    .filter(t => !TAG_STOPWORDS.has(t))
    .filter(t => !firstTokens.has(t));
  return cleaned.length ? Array.from(new Set(cleaned)).slice(0, 5) : ['untagged'];
}

async function classifyIntent(text, hasHistory) {
  const userBlock = [
    hasHistory ? '[There is conversation history — the user is mid-chat.]' : '[This is an early message in the conversation.]',
    '',
    '<user_message>',
    text,
    '</user_message>',
    '',
    'Classify the intent. Be biased toward chat. If chat, set chat_mode. If store, generate the proposal.',
  ].join('\n');

  const { data } = await callFastJson({
    system: CLASSIFIER_SYSTEM,
    messages: [{ role: 'user', content: userBlock }],
    schema: INTENT_SCHEMA,
    maxTokens: 800,
  });
  if (data.intent === 'store' && data.proposal) {
    data.proposal.tags = cleanTags(data.proposal.tags, text);
  }
  return data;
}

// ── Temporal helpers — spec §4.3 ─────────────────────────────────────────────
function relativeAge(createdAt) {
  if (!createdAt || createdAt === 'source not recorded') return null;
  const then = new Date(createdAt);
  if (Number.isNaN(then.getTime())) return null;
  const now = Date.now();
  const days = Math.floor((now - then.getTime()) / (1000 * 60 * 60 * 24));
  if (days < 0)   return 'just added';
  if (days < 2)   return 'this week';
  if (days < 8)   return 'this week';
  if (days < 30)  return `${Math.max(1, Math.floor(days / 7))} weeks ago`;
  if (days < 60)  return 'last month';
  if (days < 180) return `${Math.floor(days / 30)} months ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago — may have evolved`;
  return `${Math.floor(days / 365)}+ years ago — your thinking may have moved on`;
}

function shortDate(createdAt) {
  if (!createdAt || createdAt === 'source not recorded') return null;
  const then = new Date(createdAt);
  if (Number.isNaN(then.getTime())) return null;
  const now = new Date();
  if (then.getFullYear() === now.getFullYear()) {
    return then.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
  }
  return then.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

// ── Living document staleness ─────────────────────────────────────────────────
function getLivingDocStaleness(updatedAt) {
  if (!updatedAt) return 'fresh';
  const then = new Date(updatedAt);
  if (Number.isNaN(then.getTime())) return 'fresh';
  const days = (Date.now() - then.getTime()) / (1000 * 60 * 60 * 24);
  if (days < 3)  return 'fresh';
  if (days < 10) return 'aging';
  return 'stale';
}

const LIVING_DOC_WARNINGS = {
  fresh:  '',
  aging:  '⚠ This reference was last updated a few days ago. Verify it reflects current state.',
  stale:  '⚠ WARNING: This reference may be significantly out of date. Treat with caution and suggest the user update it.',
};

// ── Building the context block fed to Sonnet ─────────────────────────────────
function buildKnowledgeBlock(items, tagName = 'untrusted_knowledge') {
  if (!items?.length) return '';
  const body = items.map((r, i) => {
    const provenance = r.provenance || 'personal';

    if (r.is_living_document) {
      // Living documents get staleness framing, not regular temporal framing.
      const staleness = getLivingDocStaleness(r.updated_at || r.created_at);
      const warning   = LIVING_DOC_WARNINGS[staleness];
      return [
        `[${i + 1}] LIVING DOCUMENT — v${r.version_number || 1}${r.title ? `: ${r.title}` : ''}`,
        warning,
        `Summary: ${r.summary || r.content?.slice(0, 200) || ''}`,
        `Source: ${r.source_ref}`,
        `Updated: ${r.updated_at || r.created_at}`,
        `Provenance: ${provenance}`,
      ].filter(Boolean).join('\n');
    }

    // Standard temporal framing for regular items (spec §4.3).
    const age = relativeAge(r.created_at);
    return [
      `[${i + 1}] ${r.type.toUpperCase()}${r.title ? `: ${r.title}` : ''}`,
      `Summary: ${r.summary || r.content?.slice(0, 200) || ''}`,
      `Source: ${r.source_ref}`,
      `Added: ${r.created_at}${age ? ` (${age})` : ''}`,
      `Provenance: ${provenance}`,
    ].join('\n');
  }).join('\n\n---\n\n');
  return `<${tagName}>\n${body}\n</${tagName}>\n\n`;
}

function citationsFor(items) {
  return items.map(r => ({
    id:           r.id,
    type:         r.type,
    title:        r.title,
    display_ref:  r.display_ref,
    source_ref:   r.source_ref,
    provenance:   r.provenance || 'personal',
    created_at:   r.created_at,
    short_date:   shortDate(r.created_at),
    relative_age: relativeAge(r.created_at),
    relevance:    r.relevance,
  }));
}

// ── Built-in spells (spec §8) ─────────────────────────────────────────────────
// Trigger words that map to specific behaviours. Recognised before the
// classifier runs so they take precedence and execute in one beat. v1 ships
// with the built-ins below; custom per-tenant spells are v2 (need a spells
// table). Honouring a spell is a small act of delight, per the spec.
const SPELLS = [
  { trigger: /^\s*accio[\s:.,!]+(.+)$/i,                 action: 'store-now'  },
  { trigger: /^\s*revelio[\s:.,!]+(.+)$/i,               action: 'search'     },
  { trigger: /^\s*synthesise[\s:.,!]+(.+)$/i,            action: 'synthesise' },
  { trigger: /^\s*synthesize[\s:.,!]+(.+)$/i,            action: 'synthesise' },
];

function matchSpell(text) {
  for (const { trigger, action } of SPELLS) {
    const m = trigger.exec(text);
    if (m) return { action, payload: m[1].trim() };
  }
  return null;
}

// ── Progressive user stages (spec §9) ────────────────────────────────────────
// Infer stage from item count and feed to the chat instructions so the twin
// adjusts tone naturally. Beginner gets celebration on small wins; power
// user gets terser, more sophisticated framing.
function inferStage(itemCount) {
  if (itemCount <= 1)   return 'brave-beginner';  // empty or one item
  if (itemCount <= 5)   return 'comfortable';
  if (itemCount <= 20)  return 'skilled';
  if (itemCount <= 60)  return 'power-user';
  return 'one-person-unicorn';
}

function stageGuidance(stage) {
  switch (stage) {
    case 'brave-beginner':
      return 'STAGE: brave beginner. Celebrate small wins. The first item, the first retrieval, the first synthesis are big moments. Lean into wonder.';
    case 'comfortable':
      return 'STAGE: comfortable user. They are getting the hang of it. Surface the distinction between knowledge and skills lightly. Suggest type choices when natural.';
    case 'skilled':
      return 'STAGE: skilled user. Real content is building. You can start to surface patterns and propose meta-principles when you genuinely see them.';
    case 'power-user':
      return 'STAGE: power user. Substantial twin. Be terser. Move faster. Trust them to know what storage is for. Push for the harder synthesis.';
    case 'one-person-unicorn':
      return 'STAGE: one-person unicorn. The twin is woven into their workflow. Be precise, fast, and trust their judgement.';
    default:
      return '';
  }
}

// ── Drift prompt builder ──────────────────────────────────────────────────────
// Extracts stale document titles from a background_log entry and returns a
// plain-text prompt the frontend can surface once per session.
function buildDriftPrompt(driftLog) {
  if (!driftLog?.meta?.stale_titles?.length) return null;
  const titles = driftLog.meta.stale_titles.slice(0, 3); // max 3 in the prompt
  const list = titles.length === 1
    ? `"${titles[0]}"`
    : titles.slice(0, -1).map(t => `"${t}"`).join(', ') + ` and "${titles[titles.length - 1]}"`;
  return `${list} ${titles.length === 1 ? 'hasn\'t' : 'haven\'t'} been updated in a while. Want to review ${titles.length === 1 ? 'it' : 'them'} now?`;
}

// ── Skill proposal fetch ─────────────────────────────────────────────────────
// Checks the skill_proposals table for a pending proposal for this user.
// Used to surface a one-time nudge in creation-mode responses.
// Non-fatal — always resolves.
async function fetchPendingSkillProposal(ctx) {
  const db = getDB();
  const { data } = await db
    .from('skill_proposals')
    .select('id, title, description')
    .eq('tenant_id', ctx.tenantId)
    .eq('user_id',   ctx.userId)
    .eq('status',    'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

// ── SSE plumbing ─────────────────────────────────────────────────────────────
// Server-Sent Events. Every response from /turn streams over SSE so the
// frontend can render incrementally. Even the proposal + ambiguous branches
// use SSE (just meta + done — no token stream) so the client only has one
// transport to consume.
function openSseStream(res) {
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',  // disable any upstream proxy buffering
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  return {
    send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      try { res.end(); } catch {}
    },
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  const history = Array.isArray(body.history) ? body.history.slice(-12) : [];

  // Optional: IDs of concept pages the user pinned in the context panel.
  // Passed through to getConceptContext so those pages are always included
  // in the model's context window regardless of relevance scoring.
  const contextConceptIds = Array.isArray(body.context_concept_ids) && body.context_concept_ids.length > 0
    ? body.context_concept_ids.slice(0, 5).map(String) // clamp + coerce
    : null;

  const ctx = await requireTenant(req);
  if (!ctx) {
    return res.status(401).json({
      error: 'No session. Call POST /api/anon/init first to create an anonymous session.',
    });
  }

  // Audit context — populated as we resolve the route and used at end.
  let auditOutcome = { success: true, errorType: null, errorMsg: null };

  const sse = openSseStream(res);

  // Cleanup: if client disconnects (e.g. user hit Stop), we want to stop work.
  // The streamTwin helper accepts an AbortSignal; wire up a controller here.
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  try {
    // ── Built-in spells first (spec §8) ───────────────────────────────────
    const spell = matchSpell(text);
    if (spell?.action === 'store-now') {
      // Accio — straight to propose.
      const cls = await classifyIntent(spell.payload, history.length > 0);
      const proposal = cls.proposal || {
        title: spell.payload.split(/\s+/).slice(0, 6).join(' '),
        type: 'knowledge',
        tags: ['untagged'],
        provenance: 'personal',
      };
      sse.send('meta', {
        kind: 'store-proposal',
        spell: 'accio',
        proposal: { ...proposal, content: spell.payload },
        confidence: cls?.confidence ?? 1,
      });
      sse.send('done', {});
      sse.close();
      return;
    }

    const classification = (spell?.action === 'search' || spell?.action === 'synthesise')
      ? { intent: 'chat', chat_mode: 'browse', confidence: 1, reason: `spell: ${spell.action}` }
      : await classifyIntent(text, history.length > 0);
    const querySeed = spell?.payload || text;

    // ── STORE branch ──────────────────────────────────────────────────────
    if (classification.intent === 'store' && classification.proposal) {
      sse.send('meta', {
        kind: 'store-proposal',
        proposal: { ...classification.proposal, content: text },
        confidence: classification.confidence,
      });
      sse.send('done', {});
      sse.close();
      return;
    }

    // ── AMBIGUOUS branch ──────────────────────────────────────────────────
    if (classification.intent === 'ambiguous') {
      sse.send('meta', {
        kind: 'ambiguous',
        text: classification.clarifying_question
          || 'Want me to remember this, or are we just chatting?',
      });
      sse.send('done', {});
      sse.close();
      return;
    }

    // ── CHAT branch (streams) ─────────────────────────────────────────────
    const cap = await checkAndIncrementCap({
      tenantId:    ctx.tenantId,
      userId:      ctx.userId,
      kind:        'chat',
      isAnonymous: ctx.isAnonymous,
    });
    if (!cap.allowed) {
      sse.send('error', { status: 429, ...capExceededBody({ kind: 'chat', cap: cap.cap }) });
      sse.send('done', {});
      sse.close();
      auditOutcome = { success: false, errorType: 'CapExceeded', errorMsg: 'chat cap' };
      return;
    }

    const mode = classification.chat_mode || 'general';
    let skillItems = [];
    let knowledgeItems = [];
    let skillGap = null;
    let conceptCtx = '';
    let driftLog = null;
    let skillProposal = null;

    // Run retrieval, concept-page context, and drift check in parallel.
    // Drift check is a cheap DB read — non-fatal if it fails.
    if (mode === 'creation') {
      const [creation, ctxResult, drift, proposal] = await Promise.all([
        searchForCreation(ctx, {
          query:       querySeed,
          output_type: classification.output_type || undefined,
        }),
        getConceptContext(ctx, querySeed, contextConceptIds).catch(() => ''),
        getRecentBackgroundLog(ctx.tenantId, 'drift-detection', 25).catch(() => null),
        fetchPendingSkillProposal(ctx).catch(() => null),
      ]);
      skillItems     = creation.skills?.items    || [];
      knowledgeItems = creation.knowledge?.items || [];
      skillGap       = creation.skill_gap        || null;
      conceptCtx     = ctxResult;
      driftLog       = drift;
      skillProposal  = proposal;
    } else {
      const [search, ctxResult, drift] = await Promise.all([
        searchTwin(ctx, { query: querySeed, top_k: RETRIEVAL_K }),
        getConceptContext(ctx, querySeed, contextConceptIds).catch(() => ''),
        getRecentBackgroundLog(ctx.tenantId, 'drift-detection', 25).catch(() => null),
      ]);
      knowledgeItems = search.results || [];
      conceptCtx     = ctxResult;
      driftLog       = drift;
    }

    // Concept pages come first — they are meta-level context that frames the
    // raw knowledge blocks that follow.
    let contextBlock = conceptCtx;
    if (mode === 'creation') {
      contextBlock += buildKnowledgeBlock(skillItems,     'skills_bucket');
      contextBlock += buildKnowledgeBlock(knowledgeItems, 'knowledge_bucket');
    } else {
      contextBlock += buildKnowledgeBlock(knowledgeItems, 'untrusted_knowledge');
    }

    const hasConceptPages = conceptCtx.length > 0;

    const allItems = mode === 'creation'
      ? [...skillItems, ...knowledgeItems]
      : knowledgeItems;
    const citations = citationsFor(allItems);

    let stage = 'comfortable';
    try {
      const recent = await listRecent(ctx, { limit: 100 });
      stage = inferStage(recent.count || 0);
    } catch { /* non-fatal */ }

    // Build drift prompt — only include if the background log has stale docs
    // and the data is fresh enough to be actionable (within 25h).
    const driftPrompt = buildDriftPrompt(driftLog);

    // Emit the meta envelope first so the frontend can render citations
    // and set the proper bot-message bubble before tokens start arriving.
    sse.send('meta', {
      kind: 'chat',
      mode,
      citations,
      skill_gap:    skillGap,
      spell:        spell?.action || null,
      stage,
      drift_prompt: driftPrompt || null,
      // Skill nudge — only set in creation mode when a pending proposal exists.
      // Frontend shows it once per session (sessionStorage gate).
      skill_nudge: skillProposal
        ? { id: skillProposal.id, title: skillProposal.title, description: skillProposal.description }
        : null,
    });

    const messages = history.map(m => ({
      role:    m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : String(m.content || ''),
    }));
    messages.push({ role: 'user', content: contextBlock + text });

    // Stream tokens to the client as they arrive.
    const final = await streamTwin({
      messages,
      maxTokens:   1280,
      effort:      'medium',
      extraSystem: chatInstruction({
        mode,
        hasResults:     allItems.length > 0,
        hasSkill:       skillItems.length > 0,
        skillGap,
        today:          todayIso(),
        stage,
        spell:          spell?.action,
        hasConceptPages,
      }),
      signal: abort.signal,
      onText: (delta) => sse.send('token', { text: delta }),
    });

    sse.send('done', { usage: final.usage });
    sse.close();
  } catch (err) {
    console.error('[turn] error:', {
      message: err?.message,
      stack: err?.stack?.split('\n').slice(0, 4).join(' | '),
    });
    try {
      sse.send('error', { message: err?.message || 'internal error' });
      sse.send('done', {});
      sse.close();
    } catch { /* res may already be closed */ }
    auditOutcome = { success: false, errorType: 'InternalError', errorMsg: err?.message };
  } finally {
    logAudit({
      userId:    ctx.userId,
      tenantId:  ctx.tenantId,
      eventType: 'tool_call',
      toolName:  'turn',
      ...auditOutcome,
    });
  }
}
