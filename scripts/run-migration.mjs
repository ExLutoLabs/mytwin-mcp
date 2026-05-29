// Migration runner. Two execution paths, in priority order:
//
//   1. Supabase Management API  — used when SUPABASE_ACCESS_TOKEN +
//      SUPABASE_PROJECT_REF are present. Runs arbitrary SQL via
//      POST /v1/projects/{ref}/database/query. This is the recommended
//      production path: works for any DDL/DML, no in-DB helpers needed.
//
//   2. Supabase JS client RPC   — fallback. Tries rpc('exec_sql', { query }).
//      Only works if you've manually created an exec_sql() function in the
//      database. Listed second because it requires a one-time setup step.
//
// If neither path is available, prints the SQL with manual-application
// instructions and exits non-zero.
//
// Usage:
//   node scripts/run-migration.mjs schema/migrations/001-tenants.sql
//
// Env vars (set in shell, NOT committed to .env files):
//   SUPABASE_ACCESS_TOKEN   — your Supabase Personal Access Token (sbp_...)
//   SUPABASE_PROJECT_REF    — the project ref (e.g. mpiuqzrfaejsqzveepve)
// Falls back to .env.local values if those aren't set.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

if (!globalThis.WebSocket) globalThis.WebSocket = ws;

// Load .env.local if present (won't have access tokens — those should come
// from the shell env — but useful for SUPABASE_URL / SERVICE_ROLE_KEY).
function loadDotenv(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split('\n')) {
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

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/run-migration.mjs <path-to-sql>');
  process.exit(2);
}
const sql = readFileSync(resolve(file), 'utf8');

console.log(`\n── Applying migration: ${file} ──`);

// ── Path 1: Management API ────────────────────────────────────────────────────
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;

async function mgmtQuery(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PAT}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} — ${body.slice(0, 400)}`);
  }
}

if (PAT && REF) {
  // Safety check: refuse to apply if the configured project ref doesn't match
  // the one in SUPABASE_URL. Without this guard, a PAT that has access to
  // multiple sibling projects (with identical table names) can silently
  // migrate the wrong database — exactly what happened in Session 2.
  const envUrl = process.env.SUPABASE_URL || '';
  const envRef = envUrl.match(/https?:\/\/([^.]+)\./)?.[1];
  if (envRef && envRef !== REF) {
    console.error(`
  ✗ Refusing to apply: project ref mismatch
    SUPABASE_PROJECT_REF: ${REF}
    SUPABASE_URL ref:     ${envRef}

  These must match. The runner targets the project ref you set, but the
  app reads from SUPABASE_URL — if they're different projects, you'd
  migrate one database while the live app uses another.

  Fix: set SUPABASE_PROJECT_REF=${envRef} to target the live project,
  or update SUPABASE_URL if you genuinely meant to migrate elsewhere.
`);
    process.exit(2);
  }

  try {
    await mgmtQuery(sql);
    console.log(`  ✓ Applied via Management API (project ${REF})`);
    // ── Reload PostgREST schema cache ─────────────────────────────────────────
    // PostgREST caches table/column metadata. After DDL it stays stale until
    // we send NOTIFY pgrst, 'reload schema' — otherwise the JS client reports
    // "column does not exist" even though it does. Always send this after a
    // migration, since cost is zero if no DDL changed.
    try {
      await mgmtQuery(`notify pgrst, 'reload schema';`);
      console.log(`  ✓ PostgREST schema cache reloaded`);
    } catch (err) {
      console.error(`  ⚠ Migration applied but schema-cache reload failed: ${err.message}`);
      console.error(`    Trigger manually: Supabase Dashboard → Project Settings → API → Reload schema`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`  ✗ Management API rejected the migration — ${err.message}`);
    process.exit(1);
  }
}

// ── Path 2: JS client RPC ─────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error(`
  ✗ No execution path available.

  Set ONE of:
    A. SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF
       (Personal Access Token from supabase.com/dashboard/account/tokens
       and your project ref from URL or 'vercel env'.)
    B. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY  (plus an exec_sql RPC in your DB)
`);
  process.exit(2);
}

const db = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
const RPC_CANDIDATES = ['exec_sql', 'query', 'execute_sql', 'run_sql'];
let succeeded = false;
let lastError = null;

// Supabase JS v2 returns a thenable from .rpc() that doesn't support .catch();
// wrap each call in try/catch so an exception (or rejection) is surfaced the
// same as an error response.
async function tryRpc(name, params) {
  try { return await db.rpc(name, params); }
  catch (e) { return { error: e }; }
}

for (const name of RPC_CANDIDATES) {
  const r = await tryRpc(name, { query: sql });
  if (!r.error) { console.log(`  ✓ Applied via rpc('${name}', { query })`); succeeded = true; break; }
  lastError = r.error;
  const r2 = await tryRpc(name, { sql });
  if (!r2.error) { console.log(`  ✓ Applied via rpc('${name}', { sql })`); succeeded = true; break; }
  lastError = r2.error;
}

if (succeeded) { console.log('\n  Migration complete.'); process.exit(0); }

console.error(`
  ✗ JS-client RPC path didn't succeed either.
    Last error: ${lastError?.message || lastError}

  Easiest fix: set SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF in your shell
  and re-run. The Management API works for any SQL without in-DB setup.
`);
process.exit(1);
