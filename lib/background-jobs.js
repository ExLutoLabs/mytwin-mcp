// lib/background-jobs.js
//
// Three durable Inngest background jobs:
//
//   1. compile-concepts  — fires on every item store; replaces the old setTimeout
//   2. detect-skill      — fires on every item store; writes to skill_proposals when a
//                          repeatable pattern is visible across recent craft items
//   3. nightly-lint      — cron at 2am UTC; checks twin health across active tenants
//
// All failures are caught, logged to background_log, and never surfaced to users.
// Inngest handles retries automatically per each function's `retries` setting.

import { inngest } from './inngest.js';

// ── Job 1 — Concept compilation ───────────────────────────────────────────────
// Triggered by every knowledge INSERT via Supabase webhook → Inngest event.
// Replaces the setTimeout in confirm-store.js.

export const compileConceptsJob = inngest.createFunction(
  { id: 'compile-concepts', retries: 2 },
  { event: 'twin/item.stored' },
  async ({ event, step }) => {
    const { tenant_id, user_id } = event.data;

    // compileConceptsForTenant writes its own 'concept-compile' background_log
    // entry (completed/failed/skipped, with a meta summary) and THROWS on fatal
    // failure — so a stalled compile shows up as a failed Inngest run (retried)
    // rather than an eternal "still compiling". No separate log step here, or it
    // would shadow the function's richer entry as the most-recent record.
    await step.run('compile', async () => {
      // Dynamic import keeps the Inngest payload lean and avoids circular deps.
      const { compileConceptsForTenant } = await import('./compile-concepts.js');
      // compileConceptsForTenant expects a destructured { userId, tenantId } object.
      await compileConceptsForTenant({ userId: user_id, tenantId: tenant_id });
    });
  },
);

// ── Job 2 — Skill detection ───────────────────────────────────────────────────
// Runs on every store. Looks for a repeatable skill pattern across recent
// craft-oriented items. When found, writes a proposal to skill_proposals.

export const detectSkillJob = inngest.createFunction(
  { id: 'detect-skill', retries: 1 },
  { event: 'twin/item.stored' },
  async ({ event, step }) => {
    const { tenant_id, user_id } = event.data;

    const proposal = await step.run('detect', async () => {
      const { getDB } = await import('./supabase.js');
      const db = getDB();

      // Only look at craft-type items — the raw material for skill detection.
      const { data: items } = await db
        .from('knowledge')
        .select('id, title, content, type, created_at')
        .eq('tenant_id', tenant_id)
        .eq('user_id', user_id)
        .in('type', ['skill', 'knowledge'])  // knowledge items can also contribute to craft skills
        .order('created_at', { ascending: false })
        .limit(20);

      // Need at least 3 items before a pattern can form.
      if (!items || items.length < 3) return null;

      // Ask Haiku if a repeatable skill is forming across these items.
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      let responseText;
      try {
        const response = await client.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: `These are recent items from a personal knowledge base:
${items.map(i => `- ${i.title || '(no title)'}: ${(i.content || '').slice(0, 100)}`).join('\n')}

Is there a clear reusable skill visible across these items?
A skill is a repeatable pattern for creating a specific type of output.
Only return true if the skill is unmistakably evident across multiple items.

Return JSON only, no markdown:
{"detected": true, "skill_title": "...", "description": "one sentence"}
or
{"detected": false}`,
          }],
        });
        responseText = response.content?.[0]?.text?.trim() || '{"detected":false}';
      } catch {
        return null;
      }

      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        return null;
      }
      return result?.detected ? result : null;
    });

    if (!proposal) return;

    await step.run('store-proposal', async () => {
      const { getDB } = await import('./supabase.js');
      const db = getDB();

      // Idempotent — skip if a pending proposal with the same title already exists.
      const { data: existing } = await db
        .from('skill_proposals')
        .select('id')
        .eq('tenant_id', tenant_id)
        .eq('title', proposal.skill_title)
        .eq('status', 'pending')
        .maybeSingle();

      if (existing) return;

      await db.from('skill_proposals').insert({
        tenant_id,
        user_id,
        title:       proposal.skill_title,
        description: proposal.description,
        status:      'pending',
      });
    });

    await step.run('log', async () => {
      const { writeBackgroundLog } = await import('./background-log.js');
      await writeBackgroundLog(tenant_id, 'skill-detect', 'completed');
    });
  },
);

// ── Job 3 — Nightly lint ──────────────────────────────────────────────────────
// Runs every night at 2am UTC. Checks twin health across all active tenants.
// Writes orphaned item counts and thin concept pages to background_log.

export const nightlyLintJob = inngest.createFunction(
  { id: 'nightly-lint', retries: 1 },
  { cron: '0 2 * * *' },
  async ({ step }) => {
    const { getDB } = await import('./supabase.js');
    const db = getDB();

    // Tenants active in the last 30 days.
    const { data: tenants } = await db
      .from('tenants')
      .select('id')
      .gte('updated_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    if (!tenants?.length) return;

    for (const tenant of tenants) {
      await step.run(`lint-${tenant.id}`, async () => {
        try {
          const { getDB: getDB2 }     = await import('./supabase.js');
          const { writeBackgroundLog } = await import('./background-log.js');
          const db2 = getDB2();

          const [{ data: items }, { data: pages }] = await Promise.all([
            db2.from('knowledge').select('id, type, title').eq('tenant_id', tenant.id),
            db2.from('concept_pages').select('id, title, source_ids').eq('tenant_id', tenant.id),
          ]);

          if (!items?.length) return;

          // Orphaned = items not referenced in any concept page.
          const allSourceIds = new Set((pages || []).flatMap(p => p.source_ids || []));
          const orphanedCount = items.filter(i => !allSourceIds.has(i.id)).length;

          // Thin = concept pages with only 1 source item.
          const thinCount = (pages || []).filter(p => (p.source_ids || []).length <= 1).length;

          await writeBackgroundLog(tenant.id, 'lint', 'completed', {
            orphaned_item_count:      orphanedCount,
            thin_concept_page_count:  thinCount,
            total_items:              items.length,
          });
        } catch (err) {
          const { writeBackgroundLog } = await import('./background-log.js');
          await writeBackgroundLog(tenant.id, 'lint', 'failed', { error: err?.message });
        }
      });
    }
  },
);
