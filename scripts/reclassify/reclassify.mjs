// v2 type/provenance reclassification CLI. Tenant-scoped, reversible.
//
//   node --env-file=.env.local scripts/reclassify/reclassify.mjs <cmd> --tenant <uuid> [opts]
//
// Commands:
//   classify   Run Haiku over the tenant's items, write a local proposals cache.
//              READ-ONLY against the DB (no writes). Calls the Anthropic API.
//   sample     Show before/after for a sample (default 15) from the cache.
//              READ-ONLY. Use this as the human review gate.
//   bulk       Apply the cached proposals. Writes knowledge_migration_log FIRST
//              (backup), then updates rows, then syncs Pinecone metadata.
//              Requires --batch <label>. Honours --dry-run and --no-pinecone.
//   rollback   Restore type+provenance from the log for a --batch <label>.
//              Reverses the row updates and the Pinecone metadata. Marks the
//              log entries rolled_back=true.
//   verify     Print the tenant's current type/provenance breakdown.
//
// Safety: bulk/rollback require migrations 016 + 017 to be applied. If the
// provenance CHECK constraint or knowledge_migration_log table is missing, the
// write fails loudly and nothing partial is left (logs are written before rows).

import {
  getDB, getNamespace, parseArgs, requireTenant,
  classifyTenant, saveProposals, loadProposals,
} from './common.mjs';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

async function syncPineconeMeta(tenant, pineconeId, { type, provenance }) {
  if (!pineconeId) return false;
  await getNamespace(tenant).update({
    id: pineconeId,
    metadata: { type, knowledge_type: type, provenance },
  });
  return true;
}

async function cmdClassify() {
  const tenant = requireTenant(args);
  console.log(`\nClassifying tenant ${tenant} …`);
  const { count, decisions } = await classifyTenant(tenant, {
    onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total} classified`),
  });
  process.stdout.write('\n');
  const changed = decisions.filter(d => d.type_changed || d.provenance_changed);
  const review  = decisions.filter(d => d.needs_review);
  saveProposals(tenant, { tenant, generated_at: new Date().toISOString(), count, decisions });
  console.log(`\n  Items:            ${count}`);
  console.log(`  Would change:     ${changed.length}`);
  console.log(`  Flagged review:   ${review.length}`);
  console.log(`  Cache written:    scripts/reclassify/.out/proposals-${tenant}.json`);
  console.log(`\n  Next: sample --tenant ${tenant}`);
}

function fmtChange(d) {
  const t = d.type_changed ? `${d.old_type} → ${d.new_type}` : `${d.old_type} (kept)`;
  const p = d.provenance_changed ? `${d.old_provenance} → ${d.new_provenance}` : `${d.old_provenance} (kept)`;
  const conf = d.confidence == null ? '—' : d.confidence.toFixed(2);
  const flags = d.flags.length ? `  [${d.flags.join(', ')}]` : '';
  return `  • "${d.title}"\n      type:       ${t}\n      provenance: ${p}\n      rule: ${d.rule}   conf: ${conf}${flags}\n      why: ${d.reason}`;
}

async function cmdSample() {
  const tenant = requireTenant(args);
  const n = Number(args.n || args.sample || 15);
  const { decisions } = loadProposals(tenant);
  const changed = decisions.filter(d => d.type_changed || d.provenance_changed);

  // Stratified sample: ensure flagged-for-review items are represented.
  const review = changed.filter(d => d.needs_review);
  const clean  = changed.filter(d => !d.needs_review);
  const pick = [...review.slice(0, Math.ceil(n / 2)), ...clean].slice(0, n);

  console.log(`\n=== SAMPLE (${pick.length} of ${changed.length} changing; ${decisions.length} total) — tenant ${tenant} ===\n`);
  for (const d of pick) console.log(fmtChange(d) + '\n');

  // Summary tallies.
  const typeMoves = {}, provMoves = {};
  for (const d of changed) {
    if (d.type_changed) typeMoves[`${d.old_type}→${d.new_type}`] = (typeMoves[`${d.old_type}→${d.new_type}`] || 0) + 1;
    if (d.provenance_changed) provMoves[`${d.old_provenance}→${d.new_provenance}`] = (provMoves[`${d.old_provenance}→${d.new_provenance}`] || 0) + 1;
  }
  console.log('--- type moves across the full set ---');
  console.log('  ' + (Object.entries(typeMoves).map(([k, v]) => `${k}: ${v}`).join('\n  ') || '(none)'));
  console.log('--- provenance moves across the full set ---');
  console.log('  ' + (Object.entries(provMoves).map(([k, v]) => `${k}: ${v}`).join('\n  ') || '(none)'));
  console.log(`\n  Flagged for review: ${review.length}. Nothing is written until you run "bulk".`);
}

async function cmdBulk() {
  const tenant = requireTenant(args);
  const batch = args.batch;
  if (!batch || batch === true) { console.error('ERROR: --bulk requires --batch <label> (e.g. staging-2026-05-29).'); process.exit(2); }
  const dryRun = Boolean(args['dry-run']);
  const doPinecone = !args['no-pinecone'];
  const db = getDB();

  const { decisions } = loadProposals(tenant);
  const changed = decisions.filter(d => d.type_changed || d.provenance_changed);
  console.log(`\n=== BULK ${dryRun ? '(DRY RUN) ' : ''}— tenant ${tenant} — batch "${batch}" ===`);
  console.log(`  ${changed.length} rows will change. Pinecone sync: ${doPinecone ? 'on' : 'off'}.`);

  if (dryRun) {
    console.log('  Dry run — no writes. Re-run without --dry-run to apply.');
    return;
  }

  // 1) Backup FIRST — write every log row before mutating anything.
  const logRows = changed.map(d => ({
    knowledge_id: d.id, tenant_id: tenant,
    old_type: d.old_type, new_type: d.new_type,
    old_provenance: d.old_provenance, new_provenance: d.new_provenance,
    rule: d.rule, batch,
  }));
  const { error: logErr } = await db.from('knowledge_migration_log').insert(logRows);
  if (logErr) { console.error(`  ✗ Backup log insert failed (is migration 017 applied?): ${logErr.message}`); process.exit(1); }
  console.log(`  ✓ Backup: ${logRows.length} rows written to knowledge_migration_log.`);

  // 2) Apply row updates (tenant-scoped).
  let updated = 0, rowErrs = 0;
  for (const d of changed) {
    const { error } = await db.from('knowledge')
      .update({ type: d.new_type, provenance: d.new_provenance })
      .eq('id', d.id).eq('tenant_id', tenant);
    if (error) { rowErrs++; console.error(`  ✗ row ${d.id}: ${error.message}`); }
    else updated++;
  }
  console.log(`  ✓ Rows updated: ${updated}${rowErrs ? `  (${rowErrs} errors — see above)` : ''}`);

  // 3) Sync Pinecone metadata (knowledge_type + provenance) for changed rows.
  if (doPinecone) {
    let synced = 0, skipped = 0, pErrs = 0;
    for (const d of changed) {
      try {
        const ok = await syncPineconeMeta(tenant, d.pinecone_id, { type: d.new_type, provenance: d.new_provenance });
        ok ? synced++ : skipped++;
      } catch (e) { pErrs++; console.error(`  ✗ pinecone ${d.pinecone_id}: ${e.message}`); }
    }
    console.log(`  ✓ Pinecone metadata synced: ${synced} (skipped no-vector: ${skipped}${pErrs ? `, errors: ${pErrs}` : ''})`);
  }
  console.log(`\n  Done. Rollback with: rollback --tenant ${tenant} --batch ${batch}`);
}

async function cmdRollback() {
  const tenant = requireTenant(args);
  const batch = args.batch;
  if (!batch || batch === true) { console.error('ERROR: --rollback requires --batch <label>.'); process.exit(2); }
  const doPinecone = !args['no-pinecone'];
  const db = getDB();

  const { data: logs, error } = await db.from('knowledge_migration_log')
    .select('*').eq('tenant_id', tenant).eq('batch', batch).eq('rolled_back', false);
  if (error) { console.error(`  ✗ Could not read log: ${error.message}`); process.exit(1); }
  if (!logs?.length) { console.log(`  Nothing to roll back for batch "${batch}".`); return; }

  console.log(`\n=== ROLLBACK — tenant ${tenant} — batch "${batch}" — ${logs.length} rows ===`);
  let restored = 0, errs = 0;
  for (const l of logs) {
    const { error: uErr } = await db.from('knowledge')
      .update({ type: l.old_type, provenance: l.old_provenance })
      .eq('id', l.knowledge_id).eq('tenant_id', tenant);
    if (uErr) { errs++; console.error(`  ✗ row ${l.knowledge_id}: ${uErr.message}`); continue; }
    if (doPinecone) {
      const { data: row } = await db.from('knowledge').select('pinecone_id').eq('id', l.knowledge_id).single();
      try { await syncPineconeMeta(tenant, row?.pinecone_id, { type: l.old_type, provenance: l.old_provenance }); }
      catch (e) { console.error(`  ⚠ pinecone restore ${l.knowledge_id}: ${e.message}`); }
    }
    await db.from('knowledge_migration_log').update({ rolled_back: true }).eq('id', l.id);
    restored++;
  }
  console.log(`  ✓ Restored ${restored} rows to original type+provenance${errs ? `  (${errs} errors)` : ''}.`);
}

async function cmdVerify() {
  const tenant = requireTenant(args);
  const db = getDB();
  const { data: rows, error } = await db.from('knowledge').select('type, provenance').eq('tenant_id', tenant);
  if (error) { console.error(error.message); process.exit(1); }
  const types = {}, prov = {};
  for (const r of rows || []) {
    types[r.type] = (types[r.type] || 0) + 1;
    prov[r.provenance || '(null)'] = (prov[r.provenance || '(null)'] || 0) + 1;
  }
  console.log(`\n=== VERIFY — tenant ${tenant} — ${rows.length} items ===`);
  console.log(`  types:      ${JSON.stringify(types)}`);
  console.log(`  provenance: ${JSON.stringify(prov)}`);
}

const COMMANDS = { classify: cmdClassify, sample: cmdSample, bulk: cmdBulk, rollback: cmdRollback, verify: cmdVerify };

if (!COMMANDS[cmd]) {
  console.error(`Usage: reclassify.mjs <classify|sample|bulk|rollback|verify> --tenant <uuid> [opts]`);
  process.exit(2);
}
COMMANDS[cmd]().catch(err => { console.error('\nFATAL:', err.message); process.exit(1); });
