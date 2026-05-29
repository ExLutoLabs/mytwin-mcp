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

// ── Proactive opener ──────────────────────────────────────────────────────────
// The moat is the twin doing something *before* the user asks (v2 brief Phase 3).
// buildOpener surfaces the single most valuable thing from existing data on
// session open: a drafted skill waiting, a recurring gap, or the user's most
// recent thread. Deterministic and cheap — no LLM call. Shared by the
// get_welcome MCP tool and the /twin web chat opening so both surfaces behave
// the same way.

function humanise(slug) {
  return String(slug || '').replace(/[-_]+/g, ' ').trim();
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return 'recently'; }
}

export async function buildOpener(ctx) {
  const db = getDB();

  const [recentRes, typesRes, proposalRes, gapRes] = await Promise.allSettled([
    db.from('knowledge').select('id, title, type, created_at', { count: 'exact' })
      .eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId)
      .order('created_at', { ascending: false }).limit(1),
    db.from('schema_types').select('name')
      .eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId),
    db.from('skill_proposals').select('id, title, description')
      .eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId)
      .eq('status', 'pending').order('created_at', { ascending: false }).limit(1),
    db.from('skill_gaps').select('output_type, count, last_seen')
      .eq('tenant_id', ctx.tenantId)
      .order('count', { ascending: false }).limit(1),
  ]);

  const recentRow = recentRes.status === 'fulfilled' ? (recentRes.value.data?.[0] || null) : null;
  const total     = recentRes.status === 'fulfilled' ? (recentRes.value.count ?? (recentRow ? 1 : 0)) : 0;
  const typeCount = typesRes.status === 'fulfilled' ? (typesRes.value.data?.length || 0) : 0;
  const proposal  = proposalRes.status === 'fulfilled' ? (proposalRes.value.data?.[0] || null) : null;
  const gap       = gapRes.status === 'fulfilled' ? (gapRes.value.data?.[0] || null) : null;

  // Priority order: a drafted skill waiting > a recurring gap > the recent thread.
  let kind = 'recent';
  let line;

  if (total === 0) {
    kind = 'new';
    line = null;
  } else if (proposal) {
    kind = 'skill_proposal';
    line = `While you were gone I drafted a skill from your recent work: "${proposal.title}". Want to look at it, or leave it for later?`;
  } else if (gap && Number(gap.count) >= 2) {
    kind = 'skill_gap';
    line = `You've come to me for ${humanise(gap.output_type)} ${gap.count} times now, and there's still no skill for it. Worth codifying one so the next one starts from a better place?`;
  } else if (recentRow) {
    kind = 'recent';
    line = `Last thing you added was "${recentRow.title || 'untitled'}" (${recentRow.type}, ${formatDate(recentRow.created_at)}). Want to build on it, or start something new?`;
  }

  return { kind, line, total, typeCount };
}

// ── get_welcome ───────────────────────────────────────────────────────────────

export async function getWelcome(ctx) {
  const opener = await buildOpener(ctx);
  const isNew  = opener.total === 0;

  // The response is composed of two parts Claude reads in order:
  //   1. SYSTEM PROMPT — operating instructions Claude internalises and
  //      follows throughout the session. NOT displayed to the user.
  //   2. SESSION OPENER — what the twin opens with. NOT locked to verbatim:
  //      the twin opens proactively, in voice, then continues naturally.
  const openerSection = isNew
    ? [
        'SESSION OPENER — this user is new. Welcome them warmly, in your own',
        'voice, drawing on the spirit of the message below. Keep it close to',
        'this in substance; do not bury it under extra text. Then invite their',
        'first capture.',
        '════════════════════════════════════════════════════════════',
        '',
        WELCOME_NEW,
      ]
    : [
        'SESSION OPENER — open the session by surfacing the specific thing below,',
        'in your own voice (warm, brief, no em dashes). This is the moat: you are',
        'showing the user something useful before they asked. Keep the specific',
        'fact it carries. After the opener, continue the conversation naturally —',
        'you may propose, ask a question, or offer a next step.',
        '════════════════════════════════════════════════════════════',
        '',
        opener.line,
      ];

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
    ...openerSection,
  ].join('\n');

  return {
    content,
    is_new: isNew,
    opener,
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
- RULE: get_welcome returns a SYSTEM PROMPT section (never shown to the user) and a SESSION OPENER section. Open the session with the opener in your own voice, warm and brief, keeping the specific fact it surfaces. Then continue naturally — you may propose, ask, or offer a next step.
- When the user asks anything that could be answered from their twin, search it first using search_twin
- When storing knowledge, always confirm what was stored and cite the source
- Every retrieval and synthesis response must cite the source
- On the user's first message this session, call get_welcome before responding to anything else
- Speak in the user's own language — use their words back to them when possible
- Never mention item counts of zero. Never use the words "empty", "blank", or "fresh knowledge base"
- The twin is completely theirs. Never delete without explicit confirmation.`;
}
