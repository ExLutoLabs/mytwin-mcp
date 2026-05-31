// Throwaway harness for the RC1 chat-memory fix (May 2026 audit, sub-phase 3).
// Verifies the intent classifier now reads conversation history, so:
//   1. A bare declarative fact is NOT silently stored.
//   2. A follow-up like "store it as a contact" recovers the contact details
//      stated a turn earlier (the Jack Fannon reproducer) via content_override.
//   3. A store proposal stays reachable for follow-up turns — the Fix C
//      placeholder marker plus the earlier user turn keep the substance live.
// Uses the real fast model. Run: node --env-file=.env.local scripts/_chat-memory-e2e.mjs
// Delete after use.

import { classifyIntent } from '../api/twin/turn.js';

const checks = [];
const expect = (name, cond, details) => {
  checks.push({ name, pass: !!cond });
  console.log((cond ? 'PASS' : 'FAIL'), name, details ? JSON.stringify(details) : '');
};
const lc = s => String(s || '').toLowerCase();

try {
  const FACT = 'My friend Jack works at Tilio, his email is jack@tilio.com.';

  // Turn 1: declarative fact. Acceptable outcomes: a store PROPOSAL (deferred,
  // never a silent write) or a chat/ambiguous reply. The propose-then-confirm
  // architecture means even a "store" intent only emits a proposal card. The
  // only unacceptable outcome would be a malformed store with no proposal.
  const t1 = await classifyIntent(FACT, []);
  expect('turn1_no_silent_store', t1.intent !== 'store' || !!t1.proposal,
    { intent: t1.intent, hasProposal: !!t1.proposal });

  // History as the frontend records it after turn 1 — mirror whichever path ran.
  const histAfter1 = t1.intent === 'store'
    ? [
        { role: 'user',      content: FACT },
        { role: 'assistant', content: `[Store proposal shown: "${t1.proposal?.title || 'untitled'}" (${t1.proposal?.type || 'knowledge'}). Awaiting the user's Store or Not now decision.]` },
      ]
    : [
        { role: 'user',      content: FACT },
        { role: 'assistant', content: t1.clarifying_question || 'Want me to remember this, or are we just chatting?' },
      ];

  // Turn 2: short reference. Must route to store and recover the email.
  const t2 = await classifyIntent('Store it as a contact.', histAfter1);
  const t2content = lc(t2.proposal?.content_override);
  expect('turn2_routes_to_store', t2.intent === 'store' && !!t2.proposal, { intent: t2.intent });
  expect('turn2_recovers_email', t2content.includes('jack@tilio.com'),
    { content_override: t2.proposal?.content_override });
  expect('turn2_recovers_name',
    t2content.includes('jack') || lc(t2.proposal?.title).includes('jack'),
    { title: t2.proposal?.title });

  // Simulate the server STORE-branch resolution: content = content_override || text.
  const resolvedContent = t2.proposal?.content_override || 'Store it as a contact.';
  expect('store_content_has_email', lc(resolvedContent).includes('jack@tilio.com'), { resolvedContent });

  // History after turn 2, exactly as Fix C records it (user msg + placeholder marker).
  const histAfter2 = [
    ...histAfter1,
    { role: 'user',      content: 'Store it as a contact.' },
    { role: 'assistant', content: `[Store proposal shown: "${t2.proposal?.title || 'untitled'}" (${t2.proposal?.type || 'knowledge'}). Awaiting the user's Store or Not now decision.]` },
  ];

  // Turn 3: change the proposal. Confirms the substance is STILL reachable
  // through the marker (it lives in the earlier user turn).
  const t3 = await classifyIntent('actually store it as a resource instead', histAfter2);
  const t3content = lc(t3.proposal?.content_override);
  expect('turn3_still_reachable',
    t3.intent === 'store' && (t3content.includes('jack@tilio.com') || lc(t3.proposal?.title).includes('jack')),
    { intent: t3.intent, type: t3.proposal?.type, title: t3.proposal?.title, content_override: t3.proposal?.content_override });

} catch (err) {
  expect('harness_did_not_throw', false, { error: err?.message, stack: err?.stack?.split('\n').slice(0, 3).join(' | ') });
} finally {
  const failed = checks.filter(c => !c.pass);
  console.log(`\nRESULT pass=${failed.length === 0} total=${checks.length} failed=${failed.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
