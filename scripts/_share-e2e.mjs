// Throwaway e2e harness for Phase 1 personal sharing. Creates synthetic tenants
// and drives the full flow against the real DB/Pinecone:
//   share(existing user) -> immediate grant
//   share(new email)     -> pending invitation -> accept -> account + grant
//   permission resolution + cross-namespace retrieval (recipient sees it)
//   isolation (third party does NOT see it)
//   revoke
//   owner account deletion (validates the FK cascade story)
// Cleans up every synthetic account on exit. Delete this file after use.

import { getOrCreateUser } from '../lib/auth.js';
import { deleteAccount } from '../lib/account.js';
import { addKnowledge } from '../tools/storage.js';
import { searchTwin } from '../tools/retrieval.js';
import { getAccessibleSharedItems } from '../lib/permissions.js';
import {
  shareItemWithEmail, listItemPermissions, revokeAccess,
  getInvitationByToken, acceptInvitation,
} from '../lib/sharing.js';

const ts = Date.now();
const emails = {
  alice: `sh-alice-${ts}@test.invalid`, // owner
  carol: `sh-carol-${ts}@test.invalid`, // existing-user recipient (immediate grant)
  bob:   `sh-bob-${ts}@test.invalid`,   // brand-new email (invitation path)
  dave:  `sh-dave-${ts}@test.invalid`,  // third party, no grant (isolation)
};
const MARKER = `zarquon${ts}`;

const checks = [];
const expect = (name, cond, details) => {
  checks.push({ name, pass: !!cond });
  console.log((cond ? 'PASS' : 'FAIL'), name, details ? JSON.stringify(details) : '');
};
const ctxOf = (res) => ({ userId: res.user.id, tenantId: res.user.tenant_id, isAnonymous: false });

const createdUserIds = [];

try {
  const aliceRes = await getOrCreateUser(emails.alice, { allowUninvited: true });
  const carolRes = await getOrCreateUser(emails.carol, { allowUninvited: true });
  const daveRes  = await getOrCreateUser(emails.dave,  { allowUninvited: true });
  createdUserIds.push(aliceRes.user.id, carolRes.user.id, daveRes.user.id);
  const alice = ctxOf(aliceRes), carol = ctxOf(carolRes), dave = ctxOf(daveRes);

  const item = await addKnowledge(alice, {
    type: 'knowledge',
    title: 'Pricing strategy memo',
    content: `Our pricing strategy hinges on the ${MARKER} principle: value-based tiers, not cost-plus. Anchor high, discount deliberately.`,
    source_type: 'typed',
    provenance: 'personal',
  });
  const itemId = item.id;
  expect('owner_item_created', !!itemId, { itemId });

  // Give Pinecone a moment to index before retrieval probes.
  await new Promise(r => setTimeout(r, 1500));

  // 1) Immediate grant to existing user Carol.
  const g = await shareItemWithEmail({ ownerCtx: alice, itemId, email: emails.carol, level: 'can_use' });
  expect('share_existing_user_granted', g.mode === 'granted' && g.level === 'can_use', { mode: g.mode });

  // 2) Invitation to new email Bob.
  const inv = await shareItemWithEmail({ ownerCtx: alice, itemId, email: emails.bob, level: 'can_use' });
  expect('share_new_email_invited', inv.mode === 'invited' && !!inv.token, { mode: inv.mode });

  // 3) List shows Carol active + Bob pending.
  const list = await listItemPermissions({ ownerCtx: alice, itemId });
  expect('list_shows_active_grant', list.grants.some(x => x.email === emails.carol && x.level === 'can_use'));
  expect('list_shows_pending_invite', list.pending.some(x => x.email === emails.bob));

  // 4) Idempotent re-share: update Carol's level, no duplicate row.
  await shareItemWithEmail({ ownerCtx: alice, itemId, email: emails.carol, level: 'can_edit' });
  const list2 = await listItemPermissions({ ownerCtx: alice, itemId });
  const carolGrants = list2.grants.filter(x => x.email === emails.carol);
  expect('reshare_updates_level_no_dup', carolGrants.length === 1 && carolGrants[0].level === 'can_edit', { count: carolGrants.length, level: carolGrants[0]?.level });

  // 5) Owner-only: Carol cannot share Alice's item.
  let ownerOnly = false;
  try { await shareItemWithEmail({ ownerCtx: carol, itemId, email: emails.dave, level: 'can_use' }); }
  catch (e) { ownerOnly = e.status === 403; }
  expect('owner_only_enforced', ownerOnly);

  // 6) Invitation metadata exposes title/type only, never content.
  const meta = await getInvitationByToken(inv.token);
  expect('invitation_lookup_title_only',
    !!meta && meta.item.title === 'Pricing strategy memo' && meta.item.content === undefined,
    { title: meta?.item?.title });

  // 7) Accept invitation -> Bob's account + grant + session.
  const acc = await acceptInvitation(inv.token);
  createdUserIds.push(acc.user.id);
  const bob = { userId: acc.user.id, tenantId: acc.user.tenant_id, isAnonymous: false };
  expect('accept_creates_grant', acc.itemId === itemId && acc.level === 'can_use' && !!acc.sessionJwt);

  // 8) Single-use token.
  let singleUse = false;
  try { await acceptInvitation(inv.token); } catch (e) { singleUse = e.status === 410; }
  expect('accept_single_use', singleUse);

  // 9) Permission resolution for Bob.
  const bobAccess = await getAccessibleSharedItems(bob);
  expect('bob_access_resolves_item', bobAccess.idSet.has(itemId) && bobAccess.levelById.get(itemId) === 'can_use', { size: bobAccess.idSet.size });

  // 10) Cross-namespace retrieval: Bob's twin finds Alice's shared item.
  const bobSearch = await searchTwin(bob, { query: `${MARKER} pricing strategy` });
  const bobHit = bobSearch.results.find(r => r.id === itemId);
  expect('bob_retrieves_shared_item', !!bobHit && bobHit.shared === true && bobHit.access_level === 'can_use', { found: !!bobHit, shared: bobHit?.shared, level: bobHit?.access_level });

  // 11) Isolation: Dave (no grant) sees nothing.
  const daveAccess = await getAccessibleSharedItems(dave);
  const daveSearch = await searchTwin(dave, { query: `${MARKER} pricing strategy` });
  expect('dave_no_access', !daveAccess.idSet.has(itemId) && !daveSearch.results.some(r => r.id === itemId), { daveSize: daveAccess.idSet.size });

  // 12) Revoke Carol's grant.
  const rev = await revokeAccess({ ownerCtx: alice, itemId, id: carolGrants[0].permission_id });
  const list3 = await listItemPermissions({ ownerCtx: alice, itemId });
  expect('revoke_removes_grant', rev.revoked && !list3.grants.some(x => x.email === emails.carol), { grantsAfter: list3.grants.length });

  // 13) Carol can no longer access.
  const carolAfter = await getAccessibleSharedItems(carol);
  expect('carol_access_revoked', !carolAfter.idSet.has(itemId));

} catch (err) {
  expect('harness_did_not_throw', false, { error: err?.message, stack: err?.stack?.split('\n').slice(0, 3).join(' | ') });
} finally {
  const cleanup = {};
  for (const uid of createdUserIds) {
    try { await deleteAccount({ userId: uid }); cleanup[uid] = 'deleted'; }
    catch (e) { cleanup[uid] = `FAILED: ${e?.message}`; }
  }
  console.log('\nCLEANUP', JSON.stringify(cleanup, null, 2));
  const failed = checks.filter(c => !c.pass);
  console.log(`\nRESULT pass=${failed.length === 0} total=${checks.length} failed=${failed.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
