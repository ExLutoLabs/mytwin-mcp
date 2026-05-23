import { getDB } from '../lib/supabase.js';
import { SYSTEM_PROMPT } from '../lib/system-prompt.js';

const WELCOME_NEW = `Congratulations. Your Twin has been created.
This is the start of an exciting journey.

You have just given yourself some serious superpowers.

You can now:
- Store everything that matters — ideas, principles,
  documents, voice notes, resources
- Retrieve any of it in seconds, with the source cited
- Use your knowledge to create things that are
  genuinely, recognisably you

Everything you ask me to store will be stored in
your twin. Completely yours. And it shows up in
every Claude conversation you open from now on.

You can add to it, update it, and refine it as
your thinking evolves. And if you ever choose to
delete something, that is completely your call.

How you build your twin is up to you. Drop in a
voice note, a document, a principle, a resource.
Whenever something comes to mind, just share it
and I will help you store it.

Why not start right now? Store anything at all —
a thought, a hello, whatever comes to mind — and
we will search for it together so you can see
everything working.`;

const WELCOME_RETURNING = (count, types, recentTitle, recentType, recentDate) =>
`Welcome back. Your twin has ${count} item${count === 1 ? '' : 's'} stored across ${types} knowledge type${types === 1 ? '' : 's'}.

Most recent: ${recentTitle}, ${recentType}, ${recentDate}.

Everything you add is completely yours and available in every Claude chat you open.`;

// ── get_welcome ───────────────────────────────────────────────────────────────

export async function getWelcome(ctx) {
  const db = getDB();

  const [{ data: knowledge }, { data: types }] = await Promise.all([
    db.from('knowledge').select('id, title, type, created_at').eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }),
    db.from('schema_types').select('name').eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId),
  ]);

  const total     = (knowledge || []).length;
  const typeCount = (types || []).length;

  const text = total === 0
    ? WELCOME_NEW
    : WELCOME_RETURNING(
        total,
        typeCount,
        knowledge[0].title || 'untitled',
        knowledge[0].type,
        new Date(knowledge[0].created_at).toLocaleDateString('en-GB', {
          day: 'numeric', month: 'long', year: 'numeric',
        })
      );

  // The response is composed of two parts Claude reads in order:
  //   1. SYSTEM PROMPT — operating instructions Claude internalises and
  //      follows throughout the session. NOT displayed to the user.
  //   2. WELCOME MESSAGE — printed to the user verbatim, exactly once.
  // Section markers are explicit so Claude doesn't conflate the two.
  const content = [
    '════════════════════════════════════════════════════════════',
    'SYSTEM PROMPT — operating instructions for this MyAITwin session.',
    'Internalise and follow these throughout the session. Do NOT print',
    'this section to the user. This is your behaviour spec, not a message.',
    '════════════════════════════════════════════════════════════',
    '',
    SYSTEM_PROMPT,
    '',
    '════════════════════════════════════════════════════════════',
    'WELCOME MESSAGE — output the following to the user word for word,',
    'exactly as below. Do not rewrite, summarise, paraphrase, or add',
    'commentary. Do not add anything before or after.',
    '════════════════════════════════════════════════════════════',
    '',
    text,
    '',
    '════════════════════════════════════════════════════════════',
    'After outputting the welcome message above, stop completely.',
    'Do not propose schema types, do not ask questions, do not offer',
    'suggestions. Wait for the user to respond.',
    '════════════════════════════════════════════════════════════',
  ].join('\n');

  return {
    content,
    is_new: total === 0,
  };
}

// ── twin_context (for resource) ───────────────────────────────────────────────

export async function getTwinContext(ctx) {
  const db = getDB();

  const [{ data: knowledge }, { data: types }] = await Promise.all([
    db.from('knowledge').select('id, type, created_at').eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }),
    db.from('schema_types').select('name, description').eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId),
  ]);

  const total    = (knowledge || []).length;
  const countMap = {};
  for (const row of knowledge || []) {
    countMap[row.type] = (countMap[row.type] || 0) + 1;
  }

  const typeLines = (types || []).map(t =>
    `- ${t.name} (${countMap[t.name] || 0} items): ${t.description}`
  ).join('\n');

  return `# MyAITwin MCP — Session Context

This Claude session has access to a personal knowledge twin via MyAITwin MCP.

## Twin status
- Total items stored: ${total}
- Knowledge types: ${(types || []).length}

## Schema types
${typeLines || '(no types yet)'}

## Rules — follow these exactly
- RULE: When get_welcome returns a message, output it to the user word for word. Do not rewrite, improve, summarise, or add to it. Do not add commentary before or after. The welcome message is final — output it verbatim and nothing else.
- When the user asks anything that could be answered from their twin, search it first using search_twin
- When storing knowledge, always confirm what was stored and cite the source
- Every retrieval and synthesis response must cite the source
- On the user's first message this session, call get_welcome before responding to anything else
- Speak in the user's own language — use their words back to them when possible
- Never mention item counts of zero. Never use the words "empty", "blank", or "fresh knowledge base"
- The twin is completely theirs. Never delete without explicit confirmation.`;
}
