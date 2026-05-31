// Phase 1 workspace backfill. Observable, idempotent, reversible, scope-gated.
//
//   node --env-file=.env.local scripts/workspaces/backfill.mjs <cmd> (--tenant <uuid> | --all)
//
// Commands:
//   plan      READ-ONLY. Show what apply would do for the scope: users in scope,
//             how many already have a Personal workspace, how many knowledge and
//             concept_pages rows still have a null workspace_id.
//   apply     Idempotent backfill. For every user in scope:
//               1. ensure one Personal workspace (type=personal, owner=user),
//               2. ensure an owner workspace_membership,
//               3. set workspace_id on that user's knowledge + concept_pages rows
//                  that are still null (never overwrites a non-null assignment).
//             Re-running apply is safe and converges; it only fills gaps.
//   verify    READ-ONLY invariant check for the scope: no workspaceless items,
//             exactly one Personal workspace per user, exactly one owner
//             membership per Personal workspace, item counts reconcile.
//   rollback  Reverse the backfill for the scope: null out workspace_id on items
//             pointing at Personal workspaces, then delete the owner memberships
//             and the Personal workspaces. Refuses if any permissions/invitations
//             rows exist in scope (sharing has started) unless --force is given.
//
// Scope is mandatory and explicit: pass --tenant <uuid> to backfill one tenant's
// users (use this for the staging gate), or --all to process every user (use this
// for the production run). There is no implicit global default.
//
// Safety: this script only WRITES the new Phase 1 tables and the additive
// knowledge/concept_pages.workspace_id column. It never touches item content,
// type, provenance, or any pre-Phase-1 column. Migration 018 must be applied
// first (the new tables and column must exist).

import { getDB } from '../../lib/supabase.js';

// ── argv ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else { out._.push(a); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

function resolveScope() {
  const tenant = args.tenant;
  const all = Boolean(args.all);
  if (all && tenant) { console.error('ERROR: pass either --tenant <uuid> or --all, not both.'); process.exit(2); }
  if (!all && (!tenant || tenant === true)) {
    console.error('ERROR: scope required. Pass --tenant <uuid> (staging) or --all (production).');
    process.exit(2);
  }
  return { tenant: all ? null : tenant, all };
}

// Fetch every user in scope. Tenant model is 1:1 with users today, but we iterate
// users (not tenants) so a future multi-user tenant still backfills correctly:
// each user gets their OWN Personal workspace owned by them.
async function usersInScope(db, scope) {
  let q = db.from('users').select('id, tenant_id, email').order('created_at', { ascending: true });
  if (!scope.all) q = q.eq('tenant_id', scope.tenant);
  const { data, error } = await q;
  if (error) throw new Error(`fetch users failed: ${error.message}`);
  return data || [];
}

async function countNull(db, table, userId) {
  const { count, error } = await db.from(table)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId).is('workspace_id', null);
  if (error) throw new Error(`${table} null-count failed: ${error.message}`);
  return count || 0;
}

async function findPersonalWorkspace(db, userId) {
  const { data, error } = await db.from('workspaces')
    .select('id').eq('owner_id', userId).eq('type', 'personal')
    .order('created_at', { ascending: true }).limit(1);
  if (error) throw new Error(`workspace lookup failed: ${error.message}`);
  return data?.[0]?.id || null;
}

// ── plan ─────────────────────────────────────────────────────────────────────
async function cmdPlan(db, scope) {
  const users = await usersInScope(db, scope);
  let haveWs = 0, needWs = 0, kNull = 0, cNull = 0;
  for (const u of users) {
    const ws = await findPersonalWorkspace(db, u.id);
    if (ws) haveWs++; else needWs++;
    kNull += await countNull(db, 'knowledge', u.id);
    cNull += await countNull(db, 'concept_pages', u.id);
  }
  console.log(`\n=== PLAN — scope ${scope.all ? 'ALL users' : `tenant ${scope.tenant}`} ===`);
  console.log(`  users in scope:                 ${users.length}`);
  console.log(`  already have Personal workspace: ${haveWs}`);
  console.log(`  need a Personal workspace:       ${needWs}`);
  console.log(`  knowledge rows missing workspace_id:     ${kNull}`);
  console.log(`  concept_pages rows missing workspace_id: ${cNull}`);
  console.log(`\n  Nothing was written. Run "apply" with the same scope to backfill.`);
}

// ── apply ────────────────────────────────────────────────────────────────────
async function cmdApply(db, scope) {
  const users = await usersInScope(db, scope);
  console.log(`\n=== APPLY — scope ${scope.all ? 'ALL users' : `tenant ${scope.tenant}`} — ${users.length} users ===`);

  let wsCreated = 0, wsReused = 0, memberCreated = 0, kUpdated = 0, cUpdated = 0, errs = 0;
  let done = 0;
  for (const u of users) {
    try {
      // 1) Personal workspace (idempotent: reuse if present).
      let wsId = await findPersonalWorkspace(db, u.id);
      if (wsId) {
        wsReused++;
      } else {
        const { data, error } = await db.from('workspaces')
          .insert({ tenant_id: u.tenant_id, type: 'personal', name: 'Personal', owner_id: u.id })
          .select('id').single();
        if (error) throw new Error(`workspace insert: ${error.message}`);
        wsId = data.id;
        wsCreated++;
      }

      // 2) Owner membership (idempotent via unique(workspace_id,user_id)).
      const { error: mErr, count: mCount } = await db.from('workspace_memberships')
        .upsert(
          { workspace_id: wsId, user_id: u.id, role: 'owner', invited_by: u.id },
          { onConflict: 'workspace_id,user_id', ignoreDuplicates: true, count: 'exact' },
        );
      if (mErr) throw new Error(`membership upsert: ${mErr.message}`);
      if (mCount) memberCreated += mCount;

      // 3) Assign the user's still-null items to their Personal workspace.
      const { count: kc, error: kErr } = await db.from('knowledge')
        .update({ workspace_id: wsId }, { count: 'exact' })
        .eq('user_id', u.id).is('workspace_id', null);
      if (kErr) throw new Error(`knowledge update: ${kErr.message}`);
      kUpdated += kc || 0;

      const { count: cc, error: cErr } = await db.from('concept_pages')
        .update({ workspace_id: wsId }, { count: 'exact' })
        .eq('user_id', u.id).is('workspace_id', null);
      if (cErr) throw new Error(`concept_pages update: ${cErr.message}`);
      cUpdated += cc || 0;
    } catch (e) {
      errs++;
      console.error(`  ✗ user ${u.id} (${u.email}): ${e.message}`);
    }
    done++;
    process.stdout.write(`\r  ${done}/${users.length} users processed`);
  }
  process.stdout.write('\n');
  console.log(`  ✓ Personal workspaces:  created ${wsCreated}, reused ${wsReused}`);
  console.log(`  ✓ Owner memberships:    created ${memberCreated}`);
  console.log(`  ✓ knowledge reassigned: ${kUpdated}`);
  console.log(`  ✓ concept_pages reassigned: ${cUpdated}`);
  if (errs) console.log(`  ⚠ ${errs} users errored (see above). Re-run apply to converge.`);
  console.log(`\n  Next: verify with the same scope.`);
}

// ── verify ───────────────────────────────────────────────────────────────────
async function cmdVerify(db, scope) {
  const users = await usersInScope(db, scope);
  const userIds = new Set(users.map(u => u.id));

  let workspaceless = 0, multiPersonal = 0, noPersonal = 0, badMembership = 0;
  let kAssigned = 0, cAssigned = 0;

  for (const u of users) {
    const { data: wss, error: wErr } = await db.from('workspaces')
      .select('id').eq('owner_id', u.id).eq('type', 'personal');
    if (wErr) throw new Error(`verify workspaces: ${wErr.message}`);
    const personal = wss || [];
    if (personal.length === 0) noPersonal++;
    if (personal.length > 1) multiPersonal++;

    // exactly one owner membership on the (first) personal workspace
    if (personal.length >= 1) {
      const wsId = personal[0].id;
      const { count: owners, error: oErr } = await db.from('workspace_memberships')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', wsId).eq('user_id', u.id).eq('role', 'owner');
      if (oErr) throw new Error(`verify memberships: ${oErr.message}`);
      if ((owners || 0) !== 1) badMembership++;
    }

    workspaceless += await countNull(db, 'knowledge', u.id);
    workspaceless += await countNull(db, 'concept_pages', u.id);

    const { count: kc } = await db.from('knowledge')
      .select('id', { count: 'exact', head: true }).eq('user_id', u.id).not('workspace_id', 'is', null);
    const { count: cc } = await db.from('concept_pages')
      .select('id', { count: 'exact', head: true }).eq('user_id', u.id).not('workspace_id', 'is', null);
    kAssigned += kc || 0;
    cAssigned += cc || 0;
  }

  const pass = workspaceless === 0 && multiPersonal === 0 && noPersonal === 0 && badMembership === 0;
  console.log(`\n=== VERIFY — scope ${scope.all ? 'ALL users' : `tenant ${scope.tenant}`} — ${users.length} users ===`);
  console.log(`  users with no Personal workspace:        ${noPersonal}   ${noPersonal ? '✗' : '✓'}`);
  console.log(`  users with >1 Personal workspace:        ${multiPersonal} ${multiPersonal ? '✗' : '✓'}`);
  console.log(`  Personal workspaces w/o 1 owner member:  ${badMembership} ${badMembership ? '✗' : '✓'}`);
  console.log(`  workspaceless items (knowledge+concept): ${workspaceless} ${workspaceless ? '✗' : '✓'}`);
  console.log(`  knowledge rows assigned to a workspace:  ${kAssigned}`);
  console.log(`  concept_pages assigned to a workspace:   ${cAssigned}`);
  console.log(`\n  ${pass ? '✓ ALL INVARIANTS HOLD' : '✗ INVARIANTS FAILED — do not proceed'}`);
  if (!pass) process.exit(1);
}

// ── rollback ───────────────────────────────────────────────────────────────────
async function cmdRollback(db, scope) {
  const users = await usersInScope(db, scope);
  const force = Boolean(args.force);

  // Guard: refuse if sharing has begun (permissions/invitations rows exist),
  // because rolling back workspaces underneath live grants would strand them.
  const { count: permCount } = await db.from('permissions').select('id', { count: 'exact', head: true });
  const { count: invCount } = await db.from('invitations').select('id', { count: 'exact', head: true });
  if ((permCount || 0) + (invCount || 0) > 0 && !force) {
    console.error(`ERROR: ${permCount || 0} permissions and ${invCount || 0} invitations exist. Rolling back now could strand live grants. Re-run with --force only if you are certain.`);
    process.exit(2);
  }

  console.log(`\n=== ROLLBACK — scope ${scope.all ? 'ALL users' : `tenant ${scope.tenant}`} — ${users.length} users ===`);
  let kNulled = 0, cNulled = 0, memDeleted = 0, wsDeleted = 0, errs = 0;
  for (const u of users) {
    try {
      const { data: wss } = await db.from('workspaces')
        .select('id').eq('owner_id', u.id).eq('type', 'personal');
      for (const ws of wss || []) {
        const { count: kc } = await db.from('knowledge')
          .update({ workspace_id: null }, { count: 'exact' }).eq('workspace_id', ws.id);
        kNulled += kc || 0;
        const { count: cc } = await db.from('concept_pages')
          .update({ workspace_id: null }, { count: 'exact' }).eq('workspace_id', ws.id);
        cNulled += cc || 0;
        const { count: mc } = await db.from('workspace_memberships')
          .delete({ count: 'exact' }).eq('workspace_id', ws.id);
        memDeleted += mc || 0;
        const { count: wc } = await db.from('workspaces')
          .delete({ count: 'exact' }).eq('id', ws.id);
        wsDeleted += wc || 0;
      }
    } catch (e) {
      errs++;
      console.error(`  ✗ user ${u.id}: ${e.message}`);
    }
  }
  console.log(`  ✓ knowledge workspace_id nulled:     ${kNulled}`);
  console.log(`  ✓ concept_pages workspace_id nulled: ${cNulled}`);
  console.log(`  ✓ memberships deleted:               ${memDeleted}`);
  console.log(`  ✓ Personal workspaces deleted:       ${wsDeleted}`);
  if (errs) console.log(`  ⚠ ${errs} users errored (see above).`);
}

const COMMANDS = { plan: cmdPlan, apply: cmdApply, verify: cmdVerify, rollback: cmdRollback };

if (!COMMANDS[cmd]) {
  console.error('Usage: backfill.mjs <plan|apply|verify|rollback> (--tenant <uuid> | --all) [--force]');
  process.exit(2);
}

const scope = resolveScope();
const db = getDB();
COMMANDS[cmd](db, scope).catch(err => { console.error('\nFATAL:', err.message); process.exit(1); });
