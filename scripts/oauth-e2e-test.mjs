// scripts/oauth-e2e-test.mjs
//
// Full end-to-end OAuth test pass against a running server. Validates the
// 7-test checklist from the OAuth-for-MCP-connector-directory work:
//
//   1. /mcp without Authorization → 401 + WWW-Authenticate(resource_metadata)
//   2. /.well-known/oauth-protected-resource shape
//   3. /.well-known/oauth-authorization-server shape (PKCE, scopes, methods)
//   4. POST /api/oauth/register (DCR) → client created
//   5. End-to-end PKCE auth-code flow → access_token + refresh_token,
//      then code-reuse → invalid_grant, then access token works at /mcp
//   6. Refresh-token rotation → new pair issued, old refresh → invalid_grant
//   7. Legacy /api/mcp/<mt_…> token URL still works
//
// At the end, cleans up everything it created (test user, tenant, magic
// tokens, mcp tokens, refresh tokens, DCR'd client).
//
// Usage:
//   BASE_URL=http://localhost:3000 \
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/oauth-e2e-test.mjs
//
// Requires the running server to share the same Supabase project (so the
// script can peek at magic_tokens to grab the link).

import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Bootstrap env ─────────────────────────────────────────────────────────────
// Same dotenv loader as scripts/run-migration.mjs (won't overwrite shell env).
function loadDotenv(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val && !(key in process.env)) process.env[key] = val;
  }
}
loadDotenv(resolve(process.cwd(), '.env.local'));
loadDotenv(resolve(process.cwd(), '.env'));

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const PAT  = process.env.SUPABASE_ACCESS_TOKEN;
const REF  = process.env.SUPABASE_PROJECT_REF;
if (!PAT || !REF) {
  console.error('Need SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF in env (Supabase Management API path).');
  process.exit(2);
}

// SQL via the Supabase Management API — one credential, same scope as the
// migration runner. Single-quote escape values (no parameterisation in the
// API); the script only inlines values it controls (UUIDs, hex, fixed emails).
function sq(v) { if (v === null || v === undefined) return 'null'; return `'${String(v).replace(/'/g, "''")}'`; }
async function mgmtQuery(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`mgmt ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const TEST_EMAIL    = `oauth-e2e-${Date.now()}-${randomBytes(3).toString('hex')}@oauth-test.invalid`;
const TEST_CLIENT_ID = 'claude-desktop'; // seeded public client after migration 008

// Track created resources for cleanup
const cleanup = {
  userId:        null,
  tenantId:      null,
  dcrClientIds:  [],
  legacyTokenId: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  const sym = status === 'PASS' ? '✓' : '✗';
  console.log(`  ${sym} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function assertJson(res, name) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, body, headers: res.headers, raw: text };
}

// Form-encode an object — token endpoint expects application/x-www-form-urlencoded
function form(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function test1_unauthMcp() {
  const name = 'T1: POST /mcp without Authorization → 401 + WWW-Authenticate(resource_metadata)';
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  });
  if (res.status !== 401) return record(name, 'FAIL', `expected 401, got ${res.status}`);
  const www = res.headers.get('www-authenticate') || '';
  if (!/^Bearer\b/.test(www)) return record(name, 'FAIL', `WWW-Authenticate not Bearer: ${www}`);
  if (!/resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/.test(www)) {
    return record(name, 'FAIL', `WWW-Authenticate missing resource_metadata pointer: ${www}`);
  }
  record(name, 'PASS', `WWW-Authenticate: ${www.slice(0, 120)}…`);
}

async function test2_protectedResource() {
  const name = 'T2: /.well-known/oauth-protected-resource';
  const res = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
  const { status, body } = await assertJson(res);
  if (status !== 200) return record(name, 'FAIL', `status ${status}`);
  if (!body || typeof body !== 'object') return record(name, 'FAIL', 'no JSON body');
  if (!body.resource || !body.resource.endsWith('/mcp')) return record(name, 'FAIL', `resource: ${body.resource}`);
  if (!Array.isArray(body.authorization_servers) || body.authorization_servers.length < 1) {
    return record(name, 'FAIL', 'authorization_servers missing');
  }
  if (!Array.isArray(body.scopes_supported) || !body.scopes_supported.includes('offline_access')) {
    return record(name, 'FAIL', 'offline_access not in scopes_supported');
  }
  if (!Array.isArray(body.bearer_methods_supported) || !body.bearer_methods_supported.includes('header')) {
    return record(name, 'FAIL', 'bearer_methods_supported missing "header"');
  }
  record(name, 'PASS', `resource=${body.resource}`);
}

async function test3_asMetadata() {
  const name = 'T3: /.well-known/oauth-authorization-server';
  const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  const { status, body } = await assertJson(res);
  if (status !== 200) return record(name, 'FAIL', `status ${status}`);
  const must = ['issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint'];
  for (const k of must) if (!body?.[k]) return record(name, 'FAIL', `missing ${k}`);
  if (!Array.isArray(body.code_challenge_methods_supported) || !body.code_challenge_methods_supported.includes('S256')) {
    return record(name, 'FAIL', 'S256 not advertised');
  }
  if (!Array.isArray(body.token_endpoint_auth_methods_supported) || !body.token_endpoint_auth_methods_supported.includes('none')) {
    return record(name, 'FAIL', '"none" auth method not advertised');
  }
  if (!Array.isArray(body.grant_types_supported) || !body.grant_types_supported.includes('refresh_token')) {
    return record(name, 'FAIL', 'refresh_token grant not advertised');
  }
  if (!Array.isArray(body.scopes_supported) || !body.scopes_supported.includes('offline_access')) {
    return record(name, 'FAIL', 'offline_access scope not advertised');
  }
  record(name, 'PASS', `S256 ✓, none ✓, offline_access ✓`);
}

async function test4_dcr() {
  const name = 'T4: POST /api/oauth/register (DCR)';
  const res = await fetch(`${BASE}/api/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `e2e-test-${Date.now()}`,
      redirect_uris: ['https://example.test/cb'],
    }),
  });
  const { status, body } = await assertJson(res);
  if (status !== 201) return record(name, 'FAIL', `status ${status}: ${JSON.stringify(body)}`);
  if (!body.client_id || !body.client_secret) return record(name, 'FAIL', 'client_id/secret missing');
  cleanup.dcrClientIds.push(body.client_id);
  record(name, 'PASS', `client_id=${body.client_id}`);
}

async function test5_fullPkceFlow() {
  const name = 'T5: PKCE auth-code flow (authorize → magic → callback → token → /mcp)';
  const { verifier, challenge } = pkce();
  const redirectUri = 'http://localhost:54321/callback'; // exercises loopback port-agnostic match
  const state = randomBytes(8).toString('hex');
  const scope = 'mcp offline_access';

  // Step a — POST /authorize (acts on the form). Magic email send may fail
  // silently (Resend has no verified delivery for .invalid domain); the
  // magic_tokens row is still inserted before the send.
  const postRes = await fetch(`${BASE}/api/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      client_id:             TEST_CLIENT_ID,
      redirect_uri:          redirectUri,
      state,
      scope,
      code_challenge:        challenge,
      code_challenge_method: 'S256',
      email:                 TEST_EMAIL,
    }),
    redirect: 'manual',
  });
  if (postRes.status !== 200) {
    return record(name, 'FAIL', `T5a /authorize POST got ${postRes.status}`);
  }

  // Step b — peek at the magic_tokens row to find the token issued for this email
  const mtRows = await mgmtQuery(
    `select token, oauth_client_id, oauth_redirect_uri, oauth_state, oauth_code_challenge, oauth_code_challenge_method
       from magic_tokens
      where email = ${sq(TEST_EMAIL)}
      order by created_at desc
      limit 1`
  );
  const mt = mtRows[0];
  if (!mt) return record(name, 'FAIL', `T5b magic_tokens row not found`);
  if (mt.oauth_code_challenge !== challenge) return record(name, 'FAIL', `T5b stored code_challenge mismatch`);

  // Step c — GET /api/oauth/callback?token=…  (simulates the magic-link click)
  const cbRes = await fetch(`${BASE}/api/oauth/callback?token=${encodeURIComponent(mt.token)}`, { redirect: 'manual' });
  if (cbRes.status !== 302) {
    return record(name, 'FAIL', `T5c callback expected 302, got ${cbRes.status}`);
  }
  const loc = cbRes.headers.get('location') || '';
  const locUrl = new URL(loc);
  if (!locUrl.searchParams.get('code')) return record(name, 'FAIL', `T5c no code in redirect: ${loc}`);
  if (locUrl.searchParams.get('state') !== state) return record(name, 'FAIL', 'T5c state mismatch on callback');
  const authCode = locUrl.searchParams.get('code');

  // Snapshot the user we just created (for cleanup at the end)
  const userRows = await mgmtQuery(`select id, tenant_id from users where email = ${sq(TEST_EMAIL)} limit 1`);
  if (userRows[0]) { cleanup.userId = userRows[0].id; cleanup.tenantId = userRows[0].tenant_id; }

  // Step d — POST /api/oauth/token with code_verifier (form-encoded)
  const tokRes = await fetch(`${BASE}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type:    'authorization_code',
      code:          authCode,
      code_verifier: verifier,
      redirect_uri:  redirectUri,
      client_id:     TEST_CLIENT_ID, // public client — no secret needed
    }),
  });
  const tok = await assertJson(tokRes, 'token');
  if (tok.status !== 200) return record(name, 'FAIL', `T5d /token expected 200, got ${tok.status}: ${JSON.stringify(tok.body)}`);
  if (!tok.body.access_token) return record(name, 'FAIL', 'T5d access_token missing');
  if (!tok.body.refresh_token) return record(name, 'FAIL', 'T5d refresh_token missing (offline_access was in scope)');
  if (tok.body.token_type !== 'Bearer') return record(name, 'FAIL', 'T5d token_type not Bearer');
  if (!tok.body.expires_in || tok.body.expires_in < 60) return record(name, 'FAIL', `T5d expires_in unreasonable: ${tok.body.expires_in}`);
  const accessToken  = tok.body.access_token;
  const refreshToken = tok.body.refresh_token;

  // Step e — code reuse must fail
  const reuseRes = await fetch(`${BASE}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type:    'authorization_code',
      code:          authCode,
      code_verifier: verifier,
      redirect_uri:  redirectUri,
      client_id:     TEST_CLIENT_ID,
    }),
  });
  const reuse = await assertJson(reuseRes);
  if (reuse.status !== 400 || reuse.body?.error !== 'invalid_grant') {
    return record(name, 'FAIL', `T5e code-reuse expected 400 invalid_grant, got ${reuse.status} ${JSON.stringify(reuse.body)}`);
  }

  // Step f — Use the access token at /mcp (full initialize handshake)
  const mcpRes = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Accept':        'application/json, text/event-stream',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
    }),
  });
  if (mcpRes.status !== 200) {
    const t = await mcpRes.text();
    return record(name, 'FAIL', `T5f /mcp with bearer expected 200, got ${mcpRes.status}: ${t.slice(0, 200)}`);
  }
  const mcpText = await mcpRes.text();
  if (!/myaitwin/i.test(mcpText)) return record(name, 'FAIL', `T5f /mcp response missing server name: ${mcpText.slice(0, 200)}`);

  // Carry the refresh token forward so test 6 can rotate it
  return record(name, 'PASS', `access_token ✓, refresh_token ✓, reuse-rejected ✓, /mcp ✓`) ?? { accessToken, refreshToken };
}

async function test6_refreshRotation(refreshToken) {
  const name = 'T6: refresh_token rotation';
  if (!refreshToken) return record(name, 'SKIP', 'no refresh token from T5');

  const res1 = await fetch(`${BASE}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     TEST_CLIENT_ID,
    }),
  });
  const r1 = await assertJson(res1);
  if (r1.status !== 200 || !r1.body.refresh_token) {
    return record(name, 'FAIL', `refresh failed: ${r1.status} ${JSON.stringify(r1.body)}`);
  }
  if (r1.body.refresh_token === refreshToken) return record(name, 'FAIL', 'refresh_token not rotated');

  // Reuse the OLD refresh token — must be rejected
  const res2 = await fetch(`${BASE}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     TEST_CLIENT_ID,
    }),
  });
  const r2 = await assertJson(res2);
  if (r2.status !== 400 || r2.body?.error !== 'invalid_grant') {
    return record(name, 'FAIL', `old refresh reuse should be invalid_grant, got ${r2.status} ${JSON.stringify(r2.body)}`);
  }
  record(name, 'PASS', `rotated ✓, replay rejected ✓`);
}

async function test7_legacyTokenUrl() {
  const name = 'T7: legacy /api/mcp/<mt_…> token URL still works';
  if (!cleanup.userId) return record(name, 'SKIP', 'no test user available');

  // Mint a legacy (client_id NULL) token directly via DB
  const raw  = 'mt_' + randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 11);
  try {
    const out = await mgmtQuery(
      `insert into mcp_tokens (user_id, tenant_id, token_hash, token_prefix, client_id, expires_at)
       values (${sq(cleanup.userId)}, ${sq(cleanup.tenantId)}, ${sq(hash)}, ${sq(prefix)}, null, null)
       returning id`
    );
    cleanup.legacyTokenId = out[0]?.id;
  } catch (err) {
    return record(name, 'FAIL', `legacy mint failed: ${err.message}`);
  }

  const res = await fetch(`${BASE}/api/mcp/${raw}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } },
    }),
  });
  if (res.status !== 200) {
    const t = await res.text();
    return record(name, 'FAIL', `legacy URL expected 200, got ${res.status}: ${t.slice(0, 200)}`);
  }
  record(name, 'PASS', `legacy token URL still works`);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
async function cleanupArtefacts() {
  console.log('\n── Cleanup ───────────────────────────────────────────');
  try {
    // Delete in FK-safe order (children before parents). A single SQL batch is
    // simpler and atomic enough for cleanup — order of statements is preserved.
    const stmts = [];
    if (cleanup.userId) {
      stmts.push(`delete from oauth_refresh_tokens where user_id = ${sq(cleanup.userId)}`);
      stmts.push(`delete from oauth_auth_codes where user_id = ${sq(cleanup.userId)}`);
      stmts.push(`delete from mcp_tokens where user_id = ${sq(cleanup.userId)}`);
      stmts.push(`delete from schema_types where user_id = ${sq(cleanup.userId)}`);
    }
    stmts.push(`delete from magic_tokens where email = ${sq(TEST_EMAIL)}`);
    if (cleanup.userId)   stmts.push(`delete from users where id = ${sq(cleanup.userId)}`);
    if (cleanup.tenantId) stmts.push(`delete from tenants where id = ${sq(cleanup.tenantId)}`);
    for (const cid of cleanup.dcrClientIds) {
      stmts.push(`delete from oauth_clients where client_id = ${sq(cid)}`);
    }
    if (stmts.length) await mgmtQuery(stmts.join(';\n'));
    console.log(`  ✓ Cleaned: user=${cleanup.userId || '-'}, tenant=${cleanup.tenantId || '-'}, dcr_clients=[${cleanup.dcrClientIds.join(',')}]`);
  } catch (err) {
    console.error(`  ✗ Cleanup failed (manual review needed): ${err.message}`);
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n── OAuth E2E test pass ──`);
  console.log(`   BASE_URL: ${BASE}`);
  console.log(`   email:    ${TEST_EMAIL}`);
  console.log(`   client:   ${TEST_CLIENT_ID}\n`);

  await test1_unauthMcp();
  await test2_protectedResource();
  await test3_asMetadata();
  await test4_dcr();
  const t5out = await test5_fullPkceFlow();
  await test6_refreshRotation(t5out?.refreshToken);
  await test7_legacyTokenUrl();

  await cleanupArtefacts();

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;

  console.log(`\n── Result ──────────────────────────────────────────────`);
  console.log(`   PASS:    ${passed}/${results.length}`);
  console.log(`   FAIL:    ${failed}`);
  console.log(`   SKIP:    ${skipped}`);
  if (failed) {
    console.log(`\nFailures:`);
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`   ✗ ${r.name}\n     ${r.detail}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nUNCAUGHT:', err);
  await cleanupArtefacts().catch(() => {});
  process.exit(2);
});
