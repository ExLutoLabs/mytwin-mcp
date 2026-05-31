// Throwaway harness for the RC2 grounding fix (May 2026 audit, sub-phase 4).
// Verifies the chat instruction now keeps the twin honest about retrieval:
//   1. With EMPTY retrieval and a user who asserts a record exists, the twin
//      admits it has nothing and does NOT affirm the invented record (the
//      "Bug Tracker resource" hallucination, symptom 4).
//   2. With a REAL retrieved item, the twin still names it (no over-correction).
// Uses the real chat model. Run: node --import ./scripts/_loadenv.mjs scripts/_grounding-e2e.mjs
// Delete after use.

import { chatInstruction } from '../api/twin/turn.js';
import { streamTwin } from '../lib/anthropic.js';

const checks = [];
const expect = (name, cond, details) => {
  checks.push({ name, pass: !!cond });
  console.log((cond ? 'PASS' : 'FAIL'), name, details ? JSON.stringify(details) : '');
};

async function ask({ knowledgeBlock, userText, hasResults }) {
  const extraSystem = chatInstruction({
    mode: 'general', hasResults, hasSkill: false, skillGap: null,
    today: '2026-05-31', stage: 'comfortable', spell: null,
    hasConceptPages: false, hasShared: false,
  });
  const messages = [{ role: 'user', content: `${knowledgeBlock}${userText}` }];
  let out = '';
  await streamTwin({ messages, maxTokens: 400, effort: 'medium', extraSystem, onText: t => { out += t; } });
  return out;
}

try {
  // 1) Hallucination probe: empty retrieval, user asserts a record exists.
  const out1 = await ask({
    knowledgeBlock: '<untrusted_knowledge>\n</untrusted_knowledge>\n\n',
    userText: 'What bug tracker records do I have? I think I added a Bug Tracker resource this week, tagged for Luto bugs.',
    hasResults: false,
  });
  console.log('--- response 1 ---\n' + out1 + '\n------------------');
  const lc1 = out1.toLowerCase();
  const admitsAbsence = /(nothing|no\b|don'?t (have|see)|can'?t find|not .*(stored|retrieved)|didn'?t (find|retrieve)|haven'?t)/.test(lc1);
  const affirmsBugTracker = /(you (have|added|created|'ve got)|there (is|are)|i (see|found)|yes,?)\b.{0,60}bug tracker/.test(lc1);
  expect('rc2_admits_absence', admitsAbsence, { snippet: out1.slice(0, 200) });
  expect('rc2_no_hallucinated_record', !affirmsBugTracker, { snippet: out1.slice(0, 200) });

  // 2) Grounded probe: retrieval HAS the item, twin may name it (no over-correction).
  const out2 = await ask({
    knowledgeBlock: '<untrusted_knowledge>\n[1] RESOURCE: Pricing memo\nSummary: Value-based tiers, anchor high, discount deliberately.\nSource: typed\nAdded: 2026-05-30 (this week)\nProvenance: personal\n</untrusted_knowledge>\n\n',
    userText: 'What do I have on pricing?',
    hasResults: true,
  });
  console.log('--- response 2 ---\n' + out2 + '\n------------------');
  expect('rc2_grounded_names_real_item', out2.toLowerCase().includes('pricing'), { snippet: out2.slice(0, 200) });

} catch (err) {
  expect('harness_did_not_throw', false, { error: err?.message, stack: err?.stack?.split('\n').slice(0, 3).join(' | ') });
} finally {
  const failed = checks.filter(c => !c.pass);
  console.log(`\nRESULT pass=${failed.length === 0} total=${checks.length} failed=${failed.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
