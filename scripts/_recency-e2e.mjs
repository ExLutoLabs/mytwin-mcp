// Throwaway harness for the RC3 recency-routing fix (May 2026 audit, sub-phase 5).
// Verifies the classifier now routes temporal/recency queries to chat_mode
// "recent" (which the turn handler serves via listRecent, date-ordered) while
// leaving topical queries on semantic search. Run:
//   node --import ./scripts/_loadenv.mjs scripts/_recency-e2e.mjs
// Delete after use.

import { classifyIntent } from '../api/twin/turn.js';

const checks = [];
const expect = (name, cond, details) => {
  checks.push({ name, pass: !!cond });
  console.log((cond ? 'PASS' : 'FAIL'), name, details ? JSON.stringify(details) : '');
};
const isRecent = r => r.intent === 'chat' && r.chat_mode === 'recent';
const modeOf = r => r.intent === 'chat' ? r.chat_mode : `(intent:${r.intent})`;

try {
  const today = await classifyIntent('what did I save today?', []);
  expect('today_is_recent', isRecent(today), { mode: modeOf(today) });

  const week = await classifyIntent('what have I added this week', []);
  expect('week_is_recent', isRecent(week), { mode: modeOf(week) });

  const latest = await classifyIntent('show me my most recent items', []);
  expect('latest_is_recent', isRecent(latest), { mode: modeOf(latest) });

  // Topical query must NOT route to recent (semantic search still applies).
  const topical = await classifyIntent('what do I think about pricing?', []);
  expect('topical_not_recent', !isRecent(topical), { mode: modeOf(topical) });

} catch (err) {
  expect('harness_did_not_throw', false, { error: err?.message, stack: err?.stack?.split('\n').slice(0, 3).join(' | ') });
} finally {
  const failed = checks.filter(c => !c.pass);
  console.log(`\nRESULT pass=${failed.length === 0} total=${checks.length} failed=${failed.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
