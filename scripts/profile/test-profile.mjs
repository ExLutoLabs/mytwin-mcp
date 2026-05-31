// Sub-phase 1 smoke test for the GET /api/profile chrome endpoint. Shares the
// permission resolution with the hypergraph endpoint (lib/profile.js), so this
// only asserts the chrome-specific shape: identity card + stats render, and the
// owner-only shared_tokens field is present for the owner and empty for a
// recipient viewer.
//
//   node --env-file=.env.local scripts/profile/test-profile.mjs

import { createSessionToken } from '../../lib/auth.js';
import handler from '../../api/profile/index.js';
import { setupProfileFixtures } from './fixtures.mjs';

const checks = [];
const expect = (name, cond, details) => {
  checks.push({ name, pass: !!cond });
  console.log((cond ? 'PASS' : 'FAIL'), name, details ? JSON.stringify(details) : '');
};

function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
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
  const { users } = fx;
  const aliceJwt = await createSessionToken(users.alice.id, users.alice.email);
  const bobJwt   = await createSessionToken(users.bob.id,   users.bob.email);

  const r401 = await call({ jwt: null });
  expect('no_session_401', r401.statusCode === 401, { status: r401.statusCode });

  const rOwner = await call({ jwt: aliceJwt });
  const b = rOwner.body || {};
  expect('owner_200_is_owner', rOwner.statusCode === 200 && b.viewer_is_owner === true && b.access === 'full',
    { status: rOwner.statusCode, owner: b.viewer_is_owner, access: b.access });
  expect('owner_identity_card', !!b.owner?.name && b.owner?.email === users.alice.email && !!b.member_since,
    { name: b.owner?.name, member_since: b.member_since });
  expect('owner_stats', b.stats?.items === 4 && typeof b.stats?.concept_pages === 'number', { stats: b.stats });
  expect('owner_shared_tokens_array', Array.isArray(b.shared_tokens), { type: typeof b.shared_tokens });

  const rBob = await call({ jwt: bobJwt, workspaceId: users.alice.workspaceId });
  const bb = rBob.body || {};
  expect('recipient_200_not_owner', rBob.statusCode === 200 && bb.viewer_is_owner === false && bb.access === 'granted',
    { status: rBob.statusCode, owner: bb.viewer_is_owner, access: bb.access });
  expect('recipient_no_shared_tokens', Array.isArray(bb.shared_tokens) && bb.shared_tokens.length === 0,
    { len: bb.shared_tokens?.length });
  expect('recipient_stats_scoped', bb.stats?.items === 1 && bb.stats?.concept_pages === 0, { stats: bb.stats });

} catch (err) {
  expect('harness_did_not_throw', false, { error: err?.message, stack: err?.stack?.split('\n').slice(0, 4).join(' | ') });
} finally {
  if (fx) { const c = await fx.cleanup(); console.log('\nCLEANUP', JSON.stringify(c, null, 2)); }
  const failed = checks.filter(c => !c.pass);
  console.log(`\nRESULT pass=${failed.length === 0} total=${checks.length} failed=${failed.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
