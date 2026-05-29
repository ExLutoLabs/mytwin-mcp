// Shared logic for the v2 type/provenance reclassification pipeline.
// Run scripts with: node --env-file=.env.local scripts/reclassify/<file>.mjs
//
// Design guarantees (build brief 2026-05-29 + user's non-negotiables):
//   * Tenant-scoped: every query is filtered by --tenant. No cross-tenant writes.
//   * Reversible: bulk writes the knowledge_migration_log BEFORE touching a row.
//   * Never overwrites deliberate human values: a field the user clearly set by
//     hand is preserved and flagged for review, never guessed over. See
//     isDeliberate* below — enforced in CODE, not just the prompt.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDB } from '../../lib/supabase.js';
import { getNamespace } from '../../lib/pinecone.js';
import { callFastJson } from '../../lib/anthropic.js';

export { getDB, getNamespace };

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '.out');

export function proposalsPath(tenant) {
  mkdirSync(OUT_DIR, { recursive: true });
  return resolve(OUT_DIR, `proposals-${tenant}.json`);
}
export function saveProposals(tenant, payload) {
  writeFileSync(proposalsPath(tenant), JSON.stringify(payload, null, 2));
}
export function loadProposals(tenant) {
  const p = proposalsPath(tenant);
  if (!existsSync(p)) throw new Error(`No proposals cache for ${tenant}. Run "classify" first.`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ── argv helpers ──────────────────────────────────────────────────────────────
export function parseArgs(argv) {
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

export function requireTenant(args) {
  const t = args.tenant;
  if (!t || t === true) { console.error('ERROR: --tenant <uuid> is required.'); process.exit(2); }
  return t;
}

// ── The "deliberate human value" guards (user non-negotiable) ───────────────────
// Type: migration 011 bulk-coerced every non-skill row to 'knowledge'. So a
// current type of 'knowledge' is NOT a deliberate call — it is the thing we are
// fixing. Any other current type was set deliberately after 011 and must be kept.
export function isDeliberateType(currentType) {
  return String(currentType || '').toLowerCase() !== 'knowledge';
}
// Provenance: 'personal' is the column default; 'organisational' is the legacy
// value we are explicitly splitting into employer/client. Both are in scope.
// 'external' is a specific, non-default call the user made by hand — keep it.
export function isDeliberateProvenance(currentProv) {
  const p = String(currentProv || '').toLowerCase();
  return p === 'external';
}

export const TYPE_ENUM = ['knowledge', 'skill', 'idea', 'principle', 'voice', 'brand', 'template', 'resource'];
export const PROV_ENUM = ['personal', 'employer', 'client', 'external'];

// Confidence floors. Any change below CONF_MIN is NOT applied (kept + flagged):
// we do not guess over the user's data. Moving an item OFF 'personal' is the
// trust-critical direction (mislabelling Piotr's own thinking as employer/client
// is the exact failure provenance partitioning exists to prevent), so it needs a
// higher bar.
export const CONF_MIN = 0.70;
export const PERSONAL_MOVE_MIN = 0.85;

// ── Classifier ──────────────────────────────────────────────────────────────
const CLASSIFY_SYSTEM = `You are reclassifying items in Piotr's personal knowledge twin (MyAITwin).

CONTEXT. Piotr works at CFTE (an education company; CFTE is his EMPLOYER). He produces work for CLIENTS (for example Miraval, and other named client organisations). He also stores his own PERSONAL thinking, and EXTERNAL material from third parties.

A past migration collapsed almost everything to type "knowledge". Your job is to propose the correct TYPE and PROVENANCE for each item from its content, title, tags and source.

TYPE — pick the best fit:
- knowledge: what Piotr knows. Facts, decisions, observations, research, transcripts, domain expertise.
- skill: how Piotr expresses something. A writing voice, an email style, a proposal structure, a feedback framework. The craft layer.
- voice: tone and style of communication (a voice guide, a "how X writes" description).
- template: a reusable structure, format, or scaffold (e.g. a "Strategy House", an "Expert Profiles" layout, a deck skeleton).
- principle: a rule or value applied repeatedly.
- idea: a concept or hypothesis being explored.
- brand: visual or aesthetic rules.
- resource: a link, document, or reference relied on.

PROVENANCE — where it originates:
- personal: Piotr's own thinking, ideas, voice notes, principles.
- employer: CFTE's own materials, internal programme content, colleague contributions, company resources.
- client: from or about a specific client (their brief, their voice, their deliverables). Miraval material is client.
- external: articles, books, reports, third-party authors, public material Piotr ingested.

RULES:
- Return a short "rule" string naming what fired, e.g. "retype-template", "split-org-to-client", "split-org-to-employer", "refine-personal-to-client", "keep-knowledge", "external-source".
- Return "confidence" 0..1. Be honest. If the item is ambiguous or you are guessing, use a low value (<0.6).
- Keep the user's voice (personal) and a client's or employer's voice strictly distinct. Never label Piotr's own thinking as client/employer unless the content clearly belongs to that org.
- Do not invent. Judge only from the text given.`;

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:         { type: 'string' },
          type:       { type: 'string', enum: TYPE_ENUM },
          provenance: { type: 'string', enum: PROV_ENUM },
          rule:       { type: 'string' },
          confidence: { type: 'number' },
          reason:     { type: 'string' },
        },
        required: ['id', 'type', 'provenance', 'rule', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// Classify a batch of rows in one Haiku call. Returns a map id -> raw proposal.
async function classifyBatch(rows) {
  const payload = rows.map(r => ({
    id: r.id,
    current_type: r.type,
    current_provenance: r.provenance,
    title: r.title || '(untitled)',
    tags: r.tags || [],
    source_ref: r.source_ref || '',
    source_type: r.source_type || '',
    content: truncate(r.content, 800),
  }));
  const { data } = await callFastJson({
    system: CLASSIFY_SYSTEM,
    schema: CLASSIFY_SCHEMA,
    maxTokens: 2048,
    messages: [{
      role: 'user',
      content: `Classify each item. Return one entry per id.\n\n${JSON.stringify(payload, null, 2)}`,
    }],
  });
  const map = {};
  for (const it of data.items || []) map[it.id] = it;
  return map;
}

// Run classification over all of a tenant's items, batched. Applies the
// deliberate-value guards in code so a hand-set field is never overwritten.
// Returns an array of decision records.
export async function classifyTenant(tenant, { batchSize = 8, onProgress } = {}) {
  const db = getDB();
  const { data: rows, error } = await db
    .from('knowledge')
    .select('id, type, title, content, tags, source_ref, source_type, provenance, pinecone_id, created_at')
    .eq('tenant_id', tenant)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`fetch failed: ${error.message}`);

  const decisions = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const raw = await classifyBatch(batch);
    for (const r of batch) {
      const p = raw[r.id] || null;
      const dtypeDeliberate = isDeliberateType(r.type);
      const dprovDeliberate = isDeliberateProvenance(r.provenance);

      // Start from the model proposal, then enforce guards.
      let newType = p?.type ?? r.type;
      let newProv = p?.provenance ?? r.provenance;
      const flags = [];

      if (dtypeDeliberate) { newType = r.type; flags.push('kept-deliberate-type'); }
      if (dprovDeliberate) { newProv = r.provenance; flags.push('kept-deliberate-provenance'); }
      if (!p) flags.push('no-model-output');

      const conf = p?.confidence ?? 0;
      // Confidence floor on type changes.
      if (newType !== r.type && conf < CONF_MIN) { newType = r.type; flags.push('type-below-threshold'); }
      // Provenance: higher bar to move OFF personal; normal floor otherwise.
      if (newProv !== r.provenance) {
        const offPersonal = String(r.provenance || '').toLowerCase() === 'personal';
        const bar = offPersonal ? PERSONAL_MOVE_MIN : CONF_MIN;
        if (conf < bar) { newProv = r.provenance; flags.push(offPersonal ? 'kept-personal-below-bar' : 'prov-below-threshold'); }
      }
      if (p && conf < CONF_MIN) flags.push('low-confidence');

      const typeChanged = newType !== r.type;
      const provChanged = newProv !== r.provenance;

      decisions.push({
        id: r.id,
        title: r.title || '(untitled)',
        pinecone_id: r.pinecone_id || null,
        old_type: r.type,
        new_type: newType,
        old_provenance: r.provenance,
        new_provenance: newProv,
        type_changed: typeChanged,
        provenance_changed: provChanged,
        rule: p?.rule || 'none',
        confidence: p?.confidence ?? null,
        reason: p?.reason || '',
        flags,
        needs_review: ['low-confidence', 'no-model-output', 'type-below-threshold', 'kept-personal-below-bar', 'prov-below-threshold'].some(f => flags.includes(f)),
      });
    }
    if (onProgress) onProgress(Math.min(i + batchSize, rows.length), rows.length);
  }
  return { count: rows.length, decisions };
}
