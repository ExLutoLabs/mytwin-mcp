// Post-reclassification retrieval sanity check (read-only).
// Confirms search still returns ranked results and that the new provenance
// partitioning holds: the creation skills bucket should be personal-only.
//   node --import ./scripts/reclassify/_preload-env.mjs scripts/reclassify/check-retrieval.mjs --tenant <uuid>

import { getDB, parseArgs, requireTenant } from './common.mjs';
import { searchTwin, searchForCreation } from '../../tools/retrieval.js';

const args = parseArgs(process.argv.slice(2));
const tenant = requireTenant(args);
const db = getDB();

const { data: user } = await db.from('users').select('id').eq('tenant_id', tenant).limit(1).single();
if (!user) { console.error('no user for tenant'); process.exit(1); }
const ctx = { tenantId: tenant, userId: user.id };

console.log('\n=== search_twin "premium pricing" ===');
const st = await searchTwin(ctx, { query: 'premium pricing strategy', top_k: 3 });
for (const r of st.results || st.items || []) {
  console.log(`  • [${r.type}] ${r.title || '(untitled)'}  prov=${r.provenance || '?'}  rel=${r.relevance ?? '?'}`);
}

console.log('\n=== search_for_creation "proposal", output_type=proposal ===');
const sc = await searchForCreation(ctx, { query: 'client proposal writing', output_type: 'proposal' });
console.log(`  skills bucket (${sc.skills.count}) — should be personal skill/voice only:`);
for (const r of sc.skills.items) console.log(`    • [${r.type}] ${r.title || '(untitled)'}  prov=${r.provenance || '?'}`);
console.log(`  knowledge bucket (${sc.knowledge.count}):`);
for (const r of sc.knowledge.items.slice(0, 3)) console.log(`    • [${r.type}] ${r.title || '(untitled)'}  prov=${r.provenance || '?'}`);
console.log(`  skill_gap: ${JSON.stringify(sc.skill_gap)}`);
