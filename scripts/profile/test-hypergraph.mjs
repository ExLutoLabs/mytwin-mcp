// Sub-phase 1 endpoint test. Builds the synthetic world (fixtures.mjs), mints
// real session JWTs, invokes the GET /api/profile/hypergraph handler in-process
// with mock req/res, and asserts the brief's permission-scoping guarantees:
//
//   1. no session                      -> 401
//   2. owner self-view (full)          -> all workspace items + null fold-in, no leak
//   3. can_use vs can_view threshold   -> recipient sees only the can_use node
//   4. view-only recipient             -> access 'granted', empty graph, 200 (not 403)
//   5. no relationship / cross-tenant  -> 403, and the other tenant's item never leaks
//   6. induced subgraph                -> every edge index is in range
//
//   node --env-file=.env.local scripts/profile/test-hypergraph.mjs

import { createSessionToken } from '../../lib/auth.js';
import handler from '../../api/profile/hypergraph.js';
import { setupProfileFixtures } from './fixtures.mjs';

const checks = [];
const expect = (name, cond, details) => {
  checks.push({ name, pass: !!cond });
  console.log((cond ? 'PASS' : 'FAIL'), name, details ? JSON.stringify(details) : '');
};

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return res;
}

async function call({ jwt, workspaceId }) {
  const req = {
    method: 'GET',
    query: workspaceId ? { workspace_id: workspaceId } : {},
    headers: jwt ? { cookie: `mt_session=${jwt}` } : {},
  };
  const res = makeRes();
  await handler(req, res);
  return res;
}

let fx;
try {
  fx = await setupProfileFixtures();
  const { users, items } = fx;

  const aliceJwt = await createSessionToken(users.alice.id, users.alice.email);
  const bobJwt   = await createSessionToken(users.bob.id,   users.bob.email);
  const daveJwt  = await createSessionToken(users.dave.id,  users.dave.email);
  const carolJwt = await createSessionToken(users.carol.id, users.carol.email);

  // 1) No session -> 401.
  const r401 = await call({ jwt: null, workspaceId: users.alice.workspaceId });
  expect('no_session_401', r401.statusCode === 401, { status: r401.statusCode });

  // 2) Owner self-view (default workspace) -> full access, 3 stamped + 1 null fold-in.
  const rOwner = await call({ jwt: aliceJwt }); // no workspace_id => personal workspace
  const ownerIds = new Set((rOwner.body?.nodes || []).map(n => n.id));
  expect('owner_full_access', rOwner.statusCode === 200 && rOwner.body?.workspace?.access === 'full',
    { status: rOwner.statusCode, access: rOwner.body?.workspace?.access });
  expect('owner_sees_stamped_items', ownerIds.has(items.iPricing) && ownerIds.has(items.iArch) && ownerIds.has(items.iVoice));
  expect('owner_null_workspace_foldin', ownerIds.has(items.iNull), { count: ownerIds.size });
  expect('owner_no_cross_tenant_leak', !ownerIds.has(items.iCarol));
  expect('owner_stats_match', rOwner.body?.workspace?.stats?.items === ownerIds.size && ownerIds.size === 4,
    { items: rOwner.body?.workspace?.stats?.items });

  // 3) Recipient bob on alice's workspace: can_use node only, can_view excluded.
  const rBob = await call({ jwt: bobJwt, workspaceId: users.alice.workspaceId });
  const bobIds = new Set((rBob.body?.nodes || []).map(n => n.id));
  expect('recipient_granted_200', rBob.statusCode === 200 && rBob.body?.workspace?.access === 'granted',
    { status: rBob.statusCode, access: rBob.body?.workspace?.access });
  expect('recipient_can_use_visible', bobIds.has(items.iPricing));
  expect('recipient_can_view_excluded', !bobIds.has(items.iArch));
  expect('recipient_only_granted_node', bobIds.size === 1, { size: bobIds.size });
  expect('recipient_no_owner_only_items', !bobIds.has(items.iVoice) && !bobIds.has(items.iNull) && !bobIds.has(items.iCarol));

  // 4) View-only recipient dave: relationship exists, but empty visible graph, still 200.
  const rDave = await call({ jwt: daveJwt, workspaceId: users.alice.workspaceId });
  expect('viewonly_granted_200_empty', rDave.statusCode === 200 && rDave.body?.workspace?.access === 'granted'
    && (rDave.body?.nodes || []).length === 0,
    { status: rDave.statusCode, access: rDave.body?.workspace?.access, nodes: rDave.body?.nodes?.length });

  // 5) Carol (other tenant, no grant/membership) on alice's workspace -> 403.
  const rCarol = await call({ jwt: carolJwt, workspaceId: users.alice.workspaceId });
  expect('no_relationship_403', rCarol.statusCode === 403, { status: rCarol.statusCode });

  // 6) Induced subgraph: every edge references an in-range node index.
  const edges = rOwner.body?.edges || [];
  const n = (rOwner.body?.nodes || []).length;
  const edgesInRange = edges.every(e => e.i >= 0 && e.j >= 0 && e.i < n && e.j < n && e.i !== e.j);
  expect('edges_induced_subgraph', edgesInRange, { edges: edges.length, nodes: n });

} catch (err) {
  expect('harness_did_not_throw', false, { error: err?.message, stack: err?.stack?.split('\n').slice(0, 4).join(' | ') });
} finally {
  if (fx) {
    const c = await fx.cleanup();
    console.log('\nCLEANUP', JSON.stringify(c, null, 2));
  }
  const failed = checks.filter(c => !c.pass);
  console.log(`\nRESULT pass=${failed.length === 0} total=${checks.length} failed=${failed.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
