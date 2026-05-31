// Synthetic-grant fixtures for the Profile endpoints (Sub-phase 1 test setup,
// reused by Sub-phase 5 verification). Builds a self-contained world against the
// real DB and tears it down completely on cleanup().
//
//   alice  — owner of the target personal workspace. Holds four items:
//            three stamped with her workspace_id and one left workspace_id=NULL
//            (exercises the owner null-workspace fold-in).
//   bob    — share recipient. Granted can_use on one of alice's items and
//            can_view on another (exercises the USABLE_LEVELS threshold: the
//            can_use item is a visible node, the can_view item is not).
//   dave   — view-only recipient. Granted can_view on a third item only
//            (exercises access='granted' + empty graph → 200, never 403).
//   carol  — a DIFFERENT tenant's owner with her own workspace and item. She has
//            no relationship to alice's workspace (→ 403) and her item must never
//            leak into alice's or bob's graph (multi-tenant isolation).
//
// getOrCreateUser creates the user + tenant but NOT a personal workspace, and
// addKnowledge inserts without a workspace_id, so this module replicates the
// backfill: create workspace + owner membership, then stamp workspace_id itself.

import { getDB } from '../../lib/supabase.js';
import { getOrCreateUser } from '../../lib/auth.js';
import { deleteAccount } from '../../lib/account.js';
import { addKnowledge } from '../../tools/storage.js';

const ctxOf = (res) => ({ userId: res.user.id, tenantId: res.user.tenant_id, isAnonymous: false });

async function ensurePersonalWorkspace(db, user) {
  const { data: ws, error: wErr } = await db
    .from('workspaces')
    .insert({ tenant_id: user.tenant_id, type: 'personal', name: 'Personal', owner_id: user.id })
    .select('id')
    .single();
  if (wErr) throw new Error(`workspace insert: ${wErr.message}`);
  const { error: mErr } = await db
    .from('workspace_memberships')
    .insert({ workspace_id: ws.id, user_id: user.id, role: 'owner', invited_by: user.id });
  if (mErr) throw new Error(`membership insert: ${mErr.message}`);
  return ws.id;
}

async function addItem(ctx, { title, tags, provenance = 'personal' }) {
  const it = await addKnowledge(ctx, {
    type: 'knowledge',
    title,
    content: `${title} — synthetic fixture body for Profile tests. Tags: ${tags.join(', ')}.`,
    source_type: 'typed',
    manual_tags: tags,
    provenance,
  });
  return it.id;
}

async function stampWorkspace(db, itemId, workspaceId) {
  const { error } = await db.from('knowledge').update({ workspace_id: workspaceId }).eq('id', itemId);
  if (error) throw new Error(`stamp workspace_id: ${error.message}`);
}

async function grant(db, { ownerId, recipientId, itemId, level }) {
  const { error } = await db.from('permissions').insert({
    subject_user_id: recipientId,
    object_item_id:  itemId,
    level,
    granted_by:      ownerId,
  });
  if (error) throw new Error(`grant insert (${level}): ${error.message}`);
}

export async function setupProfileFixtures() {
  const db = getDB();
  const ts = Date.now();
  const emails = {
    alice: `pf-alice-${ts}@test.invalid`,
    bob:   `pf-bob-${ts}@test.invalid`,
    dave:  `pf-dave-${ts}@test.invalid`,
    carol: `pf-carol-${ts}@test.invalid`,
  };

  const createdUserIds = [];
  const cleanup = async () => {
    const out = {};
    for (const uid of createdUserIds) {
      try { await deleteAccount({ userId: uid }); out[uid] = 'deleted'; }
      catch (e) { out[uid] = `FAILED: ${e?.message}`; }
    }
    return out;
  };

  try {
    const aliceRes = await getOrCreateUser(emails.alice, { allowUninvited: true });
    const bobRes   = await getOrCreateUser(emails.bob,   { allowUninvited: true });
    const daveRes  = await getOrCreateUser(emails.dave,  { allowUninvited: true });
    const carolRes = await getOrCreateUser(emails.carol, { allowUninvited: true });
    createdUserIds.push(aliceRes.user.id, bobRes.user.id, daveRes.user.id, carolRes.user.id);

    const alice = ctxOf(aliceRes), carol = ctxOf(carolRes);
    const aliceWs = await ensurePersonalWorkspace(db, aliceRes.user);
    const carolWs = await ensurePersonalWorkspace(db, carolRes.user);

    // Alice's items. Three stamped to her workspace, one left NULL (fold-in).
    const iPricing = await addItem(alice, { title: 'Pricing strategy memo', tags: ['pricing', 'strategy', 'vision', 'positioning'] });
    const iArch    = await addItem(alice, { title: 'Twin architecture notes', tags: ['supabase', 'mcp', 'architecture', 'rag'] });
    const iVoice   = await addItem(alice, { title: 'Brand voice guide',       tags: ['voice', 'brand', 'design', 'typography'] });
    const iNull    = await addItem(alice, { title: 'Roadmap draft',           tags: ['roadmap', 'build', 'milestone'] });
    await stampWorkspace(db, iPricing, aliceWs);
    await stampWorkspace(db, iArch, aliceWs);
    await stampWorkspace(db, iVoice, aliceWs);
    // iNull intentionally left workspace_id = NULL (addKnowledge does not set it).

    // Carol's item lives in HER tenant/workspace — isolation probe.
    const iCarol = await addItem(carol, { title: 'Carol private pricing', tags: ['pricing', 'strategy'] });
    await stampWorkspace(db, iCarol, carolWs);

    // Grants on alice's items.
    await grant(db, { ownerId: aliceRes.user.id, recipientId: bobRes.user.id,  itemId: iPricing, level: 'can_use' });
    await grant(db, { ownerId: aliceRes.user.id, recipientId: bobRes.user.id,  itemId: iArch,    level: 'can_view' });
    await grant(db, { ownerId: aliceRes.user.id, recipientId: daveRes.user.id, itemId: iVoice,   level: 'can_view' });

    return {
      cleanup,
      users: {
        alice: { id: aliceRes.user.id, email: emails.alice, tenantId: aliceRes.user.tenant_id, workspaceId: aliceWs },
        bob:   { id: bobRes.user.id,   email: emails.bob,   tenantId: bobRes.user.tenant_id },
        dave:  { id: daveRes.user.id,  email: emails.dave,  tenantId: daveRes.user.tenant_id },
        carol: { id: carolRes.user.id, email: emails.carol, tenantId: carolRes.user.tenant_id, workspaceId: carolWs },
      },
      items: { iPricing, iArch, iVoice, iNull, iCarol },
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
