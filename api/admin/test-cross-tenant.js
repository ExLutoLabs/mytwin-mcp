// POST /api/admin/test-cross-tenant
//
// Cross-tenant isolation test suite — Session 2 step 8 (final gate).
//
// Creates two synthetic tenants (Alice + Bob) on test emails, inserts one
// knowledge item each through the real tool functions, then probes whether
// either tenant can read/update/delete the other's data via every retrieval
// and management path. Cleans up both test tenants on exit (success OR
// failure) via the production deleteAccount flow.
//
// Auth: X-Admin-Token header, constant-time compare against ADMIN_TOKEN.
// Costs a few cents in OpenAI embeddings per run. Re-runnable any time.

import { createHash, timingSafeEqual } from 'node:crypto';
import { getOrCreateUser } from '../../lib/auth.js';
import { getNamespace } from '../../lib/pinecone.js';
import { deleteAccount } from '../../lib/account.js';
import { addKnowledge, addReferenceRecord } from '../../tools/storage.js';
import { searchTwin, getByType, getByTag, synthesise, searchForCreation } from '../../tools/retrieval.js';
import { listRecent, updateKnowledge, deleteKnowledge } from '../../tools/management.js';
import { getSchema } from '../../tools/schema-tools.js';
import { findPatternsInKnowledge, getSources } from '../../tools/analysis.js';
import { getWelcome } from '../../tools/welcome.js';

export const config = { maxDuration: 120 };

function authed(req) {
  // Accept either X-Admin-Token (original) or X-Admin-Password (dashboard gate)
  // so this suite can be re-run with whichever credential is available.
  const providedToken = String(req.headers['x-admin-token']    || '');
  const providedPw    = String(req.headers['x-admin-password'] || '');
  const expectedToken = String(process.env.ADMIN_TOKEN              || '');
  const expectedPw    = String(process.env.ADMIN_DASHBOARD_PASSWORD || '');

  if (providedToken && expectedToken.length >= 32) {
    const a = createHash('sha256').update(providedToken).digest();
    const b = createHash('sha256').update(expectedToken).digest();
    if (timingSafeEqual(a, b)) return true;
  }
  if (providedPw && expectedPw.length >= 8) {
    const a = createHash('sha256').update(providedPw).digest();
    const b = createHash('sha256').update(expectedPw).digest();
    if (timingSafeEqual(a, b)) return true;
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!authed(req))           return res.status(401).json({ error: 'Unauthorised' });

  const ts = Date.now();
  const aliceEmail = `xt-alice-${ts}@test.invalid`;
  const bobEmail   = `xt-bob-${ts}@test.invalid`;

  const checks = [];
  const expect = (name, cond, details) => checks.push({ name, pass: !!cond, details: details ?? null });

  let alice = null, bob = null;
  let aliceItemId = null, bobItemId = null;

  try {
    // ── Setup: two test tenants ────────────────────────────────────────────
    // Synthetic test users bypass the invite gate — they exist only for
    // this run and get cleaned up via deleteAccount at the end.
    const aliceRes = await getOrCreateUser(aliceEmail, { allowUninvited: true });
    const bobRes   = await getOrCreateUser(bobEmail,   { allowUninvited: true });
    alice = { userId: aliceRes.user.id, tenantId: aliceRes.user.tenant_id, email: aliceEmail };
    bob   = { userId: bobRes.user.id,   tenantId: bobRes.user.tenant_id,   email: bobEmail };

    expect('tenants_are_distinct',
      alice.tenantId !== bob.tenantId,
      { alice: alice.tenantId, bob: bob.tenantId });

    // ── Seed: one knowledge item per tenant, full flow (embeds + Pinecone) ─
    const aliceItem = await addKnowledge(alice, {
      type: 'principle', title: 'Alice principle',
      content: 'Alice secret marker: pineapple-pizza-yes-3kj92.',
    });
    const bobItem = await addKnowledge(bob, {
      type: 'principle', title: 'Bob principle',
      content: 'Bob secret marker: pineapple-pizza-crime-9xz41.',
    });
    aliceItemId = aliceItem.id;
    bobItemId   = bobItem.id;
    expect('alice_item_stored', aliceItem.stored && aliceItem.id);
    expect('bob_item_stored',   bobItem.stored   && bobItem.id);

    // ── 1. search_twin: Alice cannot find Bob's content ─────────────────────
    // search_twin now returns `summary` (one-line) instead of full `content`
    // per Anthropic token-frugality policy. The unique probe strings are
    // short enough to land in the first ~280 chars and survive the trim.
    const aliceSearchForBob = await searchTwin(alice, { query: 'pineapple-pizza-crime-9xz41' });
    expect('search_twin_alice_excludes_bob',
      !aliceSearchForBob.results.some(r => (r.summary || '').includes('crime-9xz41')),
      { hits: aliceSearchForBob.results.length });

    const bobSearchForAlice = await searchTwin(bob, { query: 'pineapple-pizza-yes-3kj92' });
    expect('search_twin_bob_excludes_alice',
      !bobSearchForAlice.results.some(r => (r.summary || '').includes('yes-3kj92')),
      { hits: bobSearchForAlice.results.length });

    // ── 2. list_recent: tenant-scoped ───────────────────────────────────────
    const aliceList = await listRecent(alice, { limit: 50 });
    expect('list_recent_alice_excludes_bob_id', !aliceList.items.some(r => r.id === bobItemId));

    // ── 3. get_by_type: tenant-scoped ───────────────────────────────────────
    const aliceByType = await getByType(alice, { type: 'principle', limit: 50 });
    expect('get_by_type_alice_excludes_bob_id', !aliceByType.items.some(r => r.id === bobItemId));

    // ── 4. get_by_tag: tenant-scoped (use a tag we know exists) ─────────────
    // tags are auto-generated by autoTag, so we don't know the exact value.
    // Use 'pineapple' which the content includes — should be in auto-tags.
    const aliceByTag = await getByTag(alice, { tag: 'pineapple', limit: 50 });
    expect('get_by_tag_alice_excludes_bob_id', !aliceByTag.items.some(r => r.id === bobItemId));

    // ── 5. update_knowledge: Alice cannot update Bob's id ──────────────────
    let updateBlocked = false, updateErr = null;
    try { await updateKnowledge(alice, { id: bobItemId, content: 'HIJACKED' }); }
    catch (e) { updateBlocked = /not found/i.test(e.message); updateErr = e.message; }
    expect('update_knowledge_alice_blocked_on_bob_id', updateBlocked, { err: updateErr });

    // ── 6. delete_knowledge: Alice cannot delete Bob's id ──────────────────
    let deleteBlocked = false, deleteErr = null;
    try { await deleteKnowledge(alice, { id: bobItemId }); }
    catch (e) { deleteBlocked = /not found/i.test(e.message); deleteErr = e.message; }
    expect('delete_knowledge_alice_blocked_on_bob_id', deleteBlocked, { err: deleteErr });

    // ── 7. Bob's item must still exist after Alice's attacks ───────────────
    const bobListAfter = await listRecent(bob, { limit: 50 });
    expect('bob_item_intact_after_alice_attacks',
      bobListAfter.items.some(r => r.id === bobItemId));

    // ── 8. get_schema: counts only own items ────────────────────────────────
    const aliceSchema = await getSchema(alice);
    expect('get_schema_alice_only_own_items',
      aliceSchema.total_items === 1,
      { total_items: aliceSchema.total_items });

    // ── 9. get_sources: tenant-scoped (we have no sources for new tenants,
    //                                   but the call must succeed and return []) ─
    const aliceSources = await getSources(alice, {});
    expect('get_sources_alice_returns_array', Array.isArray(aliceSources.sources));

    // ── 10. find_patterns: needs >1 item; for new tenant should return note ─
    const alicePatterns = await findPatternsInKnowledge(alice, {});
    expect('find_patterns_alice_did_not_crash', alicePatterns && typeof alicePatterns === 'object');

    // ── 11. synthesise: tenant-scoped, won't include other tenant's items ──
    const aliceSynth = await synthesise(alice, { topic: 'pineapple', top_k: 10 });
    if (aliceSynth.synthesised) {
      // synthesis_prompt contains only Alice's knowledge — never Bob's
      expect('synthesise_alice_no_bob_content',
        !String(aliceSynth.synthesis_prompt || '').includes('crime-9xz41'));
    } else {
      // It's fine if there's nothing relevant — just confirm no leak via shape
      expect('synthesise_alice_safe_shape', !aliceSynth.knowledge?.some(k => k.id === bobItemId));
    }

    // ── 12. Pinecone refuses unscoped access ───────────────────────────────
    let pineconeRequiresTenant = false, pineconeMsg = '';
    try { getNamespace(null); }
    catch (e) { pineconeRequiresTenant = true; pineconeMsg = e.message; }
    expect('pinecone_namespace_requires_tenantId', pineconeRequiresTenant, { msg: pineconeMsg });

    // Also: null tenantId on the ctx variant
    let pineconeUndefinedRequiresTenant = false;
    try { getNamespace(undefined); } catch { pineconeUndefinedRequiresTenant = true; }
    expect('pinecone_namespace_requires_tenantId_undefined', pineconeUndefinedRequiresTenant);

    // ── 13. get_welcome injects the system prompt at session start ─────────
    const aliceWelcome = await getWelcome(alice);
    expect('get_welcome_contains_system_prompt',
      typeof aliceWelcome?.content === 'string' &&
        aliceWelcome.content.includes('SYSTEM PROMPT') &&
        aliceWelcome.content.includes("You are the user's twin"),
      { has_system_prompt_marker: aliceWelcome?.content?.includes('SYSTEM PROMPT') });
    expect('get_welcome_contains_welcome_message',
      typeof aliceWelcome?.content === 'string' &&
        aliceWelcome.content.includes('WELCOME MESSAGE'));

    // ── 14. Retrieval results carry source_ref + created_at ────────────────
    // Re-run a search against Alice's own item — the result must have both
    // canonical fields per the system prompt's "always cite" rule.
    const aliceSelfSearch = await searchTwin(alice, { query: 'pineapple-pizza-yes' });
    const aliceFirstHit = aliceSelfSearch.results[0];
    expect('search_twin_result_has_source_ref',
      aliceFirstHit && typeof aliceFirstHit.source_ref === 'string' && aliceFirstHit.source_ref.length > 0,
      { source_ref: aliceFirstHit?.source_ref });
    expect('search_twin_result_has_created_at',
      aliceFirstHit && typeof aliceFirstHit.created_at === 'string' && aliceFirstHit.created_at.length > 0,
      { created_at: aliceFirstHit?.created_at });

    // ── 15. skill type stores cleanly as a first-class type ────────────────
    const aliceSkillItem = await addKnowledge(alice, {
      type:    'skill',
      title:   'Alice LinkedIn voice',
      content: 'Open with a contrarian observation. Two short paragraphs. End with a question.',
    });
    expect('skill_type_stores_cleanly', aliceSkillItem.stored && aliceSkillItem.type === 'skill');

    // And: skill items come back via get_by_type
    const aliceSkills = await getByType(alice, { type: 'skill', limit: 10 });
    expect('skill_retrievable_by_type',
      aliceSkills.items.some(r => r.id === aliceSkillItem.id),
      { count: aliceSkills.count });

    // ══════════════════════════════════════════════════════════════════════
    // V2 additions — provenance, knowledge_type, search_for_creation,
    // reference records, skill-gap detector.
    // ══════════════════════════════════════════════════════════════════════

    // ── V2.1: provenance appears on stored records and retrievals ──────────
    expect('provenance_default_on_addKnowledge', aliceItem.provenance === 'personal',
      { provenance: aliceItem.provenance });

    const aliceItemList = await listRecent(alice, { limit: 50 });
    const aliceItemRow  = aliceItemList.items.find(r => r.id === aliceItemId);
    expect('provenance_surfaced_in_list_recent',
      aliceItemRow && typeof aliceItemRow.provenance === 'string',
      { provenance: aliceItemRow?.provenance });

    // Store with explicit non-default provenance and verify it persists
    const orgItem = await addKnowledge(alice, {
      type: 'brand', title: 'Alice org brand',
      content: 'Alice org colours: blue, white, gold.',
      provenance: 'organisational',
    });
    expect('provenance_organisational_persists', orgItem.provenance === 'organisational');

    // ── V2.2: Pinecone metadata carries knowledge_type ──────────────────────
    // We can't easily inspect Pinecone metadata from here without going
    // through the SDK, but search_for_creation's filter (knowledge_type IN […])
    // is the load-bearing path — verify it actually filters.
    const aliceCreationSearch = await searchForCreation(alice, {
      query:       'pineapple-pizza',
      output_type: 'xt-test-output',
    });
    expect('search_for_creation_returns_two_buckets',
      aliceCreationSearch.skills && aliceCreationSearch.knowledge &&
        typeof aliceCreationSearch.skills.count === 'number' &&
        typeof aliceCreationSearch.knowledge.count === 'number',
      { skills: aliceCreationSearch.skills?.count, knowledge: aliceCreationSearch.knowledge?.count });

    // Skill bucket should be filtered — Alice's principle item should NOT
    // appear in skills bucket
    expect('search_for_creation_skills_filtered_correctly',
      !aliceCreationSearch.skills.items.some(r => r.id === aliceItemId),
      { ids: aliceCreationSearch.skills.items.map(r => r.id) });

    // Knowledge bucket should NOT include the skill item we created earlier
    expect('search_for_creation_knowledge_filtered_correctly',
      !aliceCreationSearch.knowledge.items.some(r => r.id === aliceSkillItem.id),
      { ids: aliceCreationSearch.knowledge.items.map(r => r.id) });

    // ── V2.3: add_reference_record stores + is retrievable ─────────────────
    const refRecord = await addReferenceRecord(alice, {
      title:          'Test reference record',
      knowledge_ids:  [aliceItemId],
      skill_id:       aliceSkillItem.id,
      output_summary: 'A LinkedIn post about pineapple pizza, two paragraphs, contrarian opening.',
      nuance:         'Used a stronger hook than usual because the audience was already engaged.',
      tags:           ['linkedin', 'q-test'],
    });
    expect('add_reference_record_stores', refRecord.stored && refRecord.type === 'reference-record');

    // Reference record retrievable by type
    const aliceRefs = await getByType(alice, { type: 'reference-record', limit: 10 });
    expect('reference_record_retrievable',
      aliceRefs.items.some(r => r.id === refRecord.id),
      { count: aliceRefs.count });

    // Reference record carries the structural link tags
    const refItem = aliceRefs.items.find(r => r.id === refRecord.id);
    expect('reference_record_has_link_tags',
      refItem?.tags?.some(t => t === `ref-skill:${aliceSkillItem.id}`) &&
      refItem?.tags?.some(t => t === `ref-knowledge:${aliceItemId}`));

    // ── V2.4: skill-gap counter increments and flags at 3 ──────────────────
    // Probe through BOB — he has zero skills, so searchForCreation's skills
    // bucket will be empty and the counter increments. (Alice has a skill,
    // so Pinecone always returns it as a hit and the counter never fires.)
    const gapOutputType = `xt-gap-${Date.now()}`;
    const gap1 = await searchForCreation(bob, { query: 'something-bob-cannot-do', output_type: gapOutputType });
    const gap2 = await searchForCreation(bob, { query: 'something-bob-cannot-do', output_type: gapOutputType });
    const gap3 = await searchForCreation(bob, { query: 'something-bob-cannot-do', output_type: gapOutputType });

    expect('skill_gap_counter_first_call_not_threshold',
      gap1.skill_gap && gap1.skill_gap.count === 1 && gap1.skill_gap.skill_gap_threshold_reached === false,
      { count: gap1.skill_gap?.count, skills_seen: gap1.skills?.count });
    expect('skill_gap_counter_third_call_threshold_reached',
      gap3.skill_gap && gap3.skill_gap.count === 3 && gap3.skill_gap.skill_gap_threshold_reached === true,
      { count: gap3.skill_gap?.count, threshold: gap3.skill_gap?.skill_gap_threshold_reached });

    // ── V2.5: cross-tenant isolation still holds for V2 additions ──────────
    // Bob's search_for_creation must not return Alice's items
    const bobCreationSearch = await searchForCreation(bob, { query: 'pineapple-pizza-yes-3kj92' });
    const bobLeakIds = [
      ...bobCreationSearch.skills.items.map(r => r.id),
      ...bobCreationSearch.knowledge.items.map(r => r.id),
    ];
    expect('search_for_creation_cross_tenant_isolated',
      !bobLeakIds.includes(aliceItemId) && !bobLeakIds.includes(aliceSkillItem.id) && !bobLeakIds.includes(refRecord.id),
      { bob_saw: bobLeakIds });
  } catch (err) {
    expect('test_harness_did_not_throw', false, { error: err?.message, stack: err?.stack?.split('\n').slice(0, 3).join(' | ') });
  }

  // ── Cleanup: always delete both test tenants (uses production flow) ─────
  const cleanup = {};
  for (const t of [alice, bob]) {
    if (t?.userId) {
      try {
        await deleteAccount({ userId: t.userId });
        cleanup[t.email] = 'deleted';
      } catch (e) {
        cleanup[t.email] = `cleanup failed: ${e?.message}`;
      }
    }
  }

  const failed = checks.filter(c => !c.pass);
  const pass   = failed.length === 0;

  res.status(pass ? 200 : 500).json({
    pass,
    total:    checks.length,
    failed:   failed.length,
    checks,
    cleanup,
  });
}
