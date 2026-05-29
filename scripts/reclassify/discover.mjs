// Read-only discovery for the v2 reclassification rehearsal.
//   * Confirms Supabase connectivity.
//   * Lists every tenant with its user email(s), item count, and a breakdown
//     of types + provenance — so we can identify the staging tenant (Twin 5.0
//     / MyTwinAuthTest) and the production tenant (~262 knowledge items).
//   * Probes whether an `exec_sql` RPC exists (decides whether the migration
//     runner can apply DDL without Management API creds).
//
// Run: node --env-file=.env.local scripts/reclassify/discover.mjs
// Touches nothing. Pure SELECT + one harmless RPC probe.

import { getDB } from '../../lib/supabase.js';

const db = getDB();

const [{ data: users, error: uErr }, { data: knowledge, error: kErr }] = await Promise.all([
  db.from('users').select('id, email, tenant_id, created_at'),
  db.from('knowledge').select('tenant_id, type, provenance, pinecone_id'),
]);

if (uErr) { console.error('users query failed:', uErr.message); process.exit(1); }
if (kErr) { console.error('knowledge query failed:', kErr.message); process.exit(1); }

// Group emails by tenant.
const emailsByTenant = {};
for (const u of users || []) {
  (emailsByTenant[u.tenant_id] ||= []).push(u.email);
}

// Aggregate knowledge per tenant.
const agg = {};
for (const k of knowledge || []) {
  const t = (agg[k.tenant_id] ||= { total: 0, types: {}, provenance: {}, noPinecone: 0 });
  t.total++;
  t.types[k.type] = (t.types[k.type] || 0) + 1;
  const p = k.provenance || '(null)';
  t.provenance[p] = (t.provenance[p] || 0) + 1;
  if (!k.pinecone_id) t.noPinecone++;
}

const tenantIds = new Set([...Object.keys(emailsByTenant), ...Object.keys(agg)]);
const rows = [...tenantIds].map(id => ({
  tenant_id: id,
  emails: (emailsByTenant[id] || []).join(', ') || '(no user row)',
  items: agg[id]?.total || 0,
  types: agg[id]?.types || {},
  provenance: agg[id]?.provenance || {},
  no_pinecone_id: agg[id]?.noPinecone || 0,
})).sort((a, b) => b.items - a.items);

console.log(`\n=== Tenants (${rows.length}) — sorted by item count ===\n`);
for (const r of rows) {
  console.log(`tenant_id:   ${r.tenant_id}`);
  console.log(`  emails:    ${r.emails}`);
  console.log(`  items:     ${r.items}   (rows missing pinecone_id: ${r.no_pinecone_id})`);
  console.log(`  types:     ${JSON.stringify(r.types)}`);
  console.log(`  provenance:${JSON.stringify(r.provenance)}`);
  console.log('');
}

// Probe exec_sql — does the runner's RPC fallback work without Management creds?
let execSql = 'absent';
try {
  const r = await db.rpc('exec_sql', { query: 'select 1' });
  execSql = r.error ? `error: ${r.error.message}` : 'PRESENT (DDL via runner RPC possible)';
} catch (e) {
  execSql = `throw: ${e.message}`;
}
console.log(`=== exec_sql RPC probe: ${execSql} ===\n`);
