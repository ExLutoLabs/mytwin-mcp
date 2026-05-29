import dns from 'node:dns/promises';
import net from 'node:net';
import { getDB } from '../lib/supabase.js';
import { getNamespace } from '../lib/pinecone.js';
import { embed, autoTag, analyseUrl, extractFromVoiceNote } from '../lib/embed.js';
import { UserError } from '../lib/errors.js';
import { formatDisplayRef } from '../lib/display-ref.js';

// ── Input size limits ─────────────────────────────────────────────────────────
// Per the security brief. Each limit produces a UserError surfaced to the
// caller; we never silently truncate.
const MAX_KNOWLEDGE_CHARS = 50_000;
const MAX_VOICE_NOTE_CHARS = 50_000;
const MAX_DOCUMENT_CHARS  = 500_000;
const MAX_TITLE_CHARS     = 500;
const MAX_URL_FETCH_BYTES = 1_000_000;
const URL_FETCH_TIMEOUT_MS = 15_000;

function assertLength(field, value, max) {
  if (typeof value === 'string' && value.length > max) {
    throw new UserError(`${field} exceeds the ${max.toLocaleString()} character limit (got ${value.length.toLocaleString()}). Trim it down and try again.`);
  }
}

// ── SSRF guard ────────────────────────────────────────────────────────────────
// Blocks: non-https schemes, private/reserved IPv4 + IPv6 ranges, cloud
// metadata endpoints, localhost. Resolves DNS up-front and validates the
// resulting IP, then disables redirect following so a 30x can't escape the
// check. Note: this does not defend against full DNS rebinding (server may
// re-resolve at TCP time); acceptable trade-off for MVP.
function isPrivateOrReservedIp(ip) {
  if (/^0\./.test(ip)) return true;                                    // 0.0.0.0/8
  if (/^10\./.test(ip)) return true;                                   // 10.0.0.0/8
  if (/^127\./.test(ip)) return true;                                  // loopback
  if (/^169\.254\./.test(ip)) return true;                             // link-local incl. AWS/GCP metadata
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true;           // 172.16/12
  if (/^192\.168\./.test(ip)) return true;                             // 192.168/16
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(ip)) return true; // 100.64/10 CGN
  if (ip === '::1' || ip === '::') return true;                        // IPv6 loopback / unspecified
  const lo = ip.toLowerCase();
  if (/^fc[0-9a-f]{2}:/.test(lo) || /^fd[0-9a-f]{2}:/.test(lo)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(lo)) return true;                            // fe80::/10
  if (lo.startsWith('::ffff:')) return isPrivateOrReservedIp(lo.slice(7));   // IPv4-mapped
  return false;
}

async function validateUrlForFetch(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch {
    throw new UserError('That URL is not valid. Provide a fully qualified https:// URL.');
  }
  if (url.protocol !== 'https:') {
    throw new UserError('Only https:// URLs are supported.');
  }
  let host = url.hostname;
  // URL parser wraps IPv6 literals in brackets — unwrap for IP checks/DNS
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || /^(localhost|0\.0\.0\.0)$/i.test(host)) {
    throw new UserError('That URL resolves to a private or reserved network address and was blocked.');
  }
  // Literal IP (no DNS needed) — validate directly
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new UserError('That URL resolves to a private or reserved network address and was blocked.');
    }
    return url.toString();
  }
  // Hostname — resolve DNS and validate every returned address
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UserError(`Could not resolve ${host}. Check the URL and try again.`);
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new UserError('That URL resolves to a private or reserved network address and was blocked.');
    }
  }
  return url.toString();
}

async function fetchWithSizeCap(safeUrl) {
  const res = await fetch(safeUrl, {
    headers: { 'User-Agent': 'MyTwin-MCP/2.0' },
    signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
    redirect: 'error', // redirects could escape SSRF check
  });
  if (!res.ok) {
    throw new UserError(`Could not fetch URL: server returned HTTP ${res.status}.`);
  }
  const declared = parseInt(res.headers.get('content-length') || '0', 10);
  if (declared && declared > MAX_URL_FETCH_BYTES) {
    throw new UserError(`That page is ${(declared / 1_000_000).toFixed(1)} MB — exceeds the 1 MB cap.`);
  }
  // Stream-cap regardless of declared content-length
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_URL_FETCH_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new UserError('That page exceeds the 1 MB cap.');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder('utf-8').decode(all);
}

function pineconeId() {
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sbError(op, error) {
  console.error(`[mytwin/supabase] ${op} failed:`, {
    message: error.message,
    code:    error.code,
    details: error.details,
    hint:    error.hint,
    status:  error.status,
  });
  const err = new Error(error.message);
  err.code    = error.code;
  err.details = error.details;
  err.hint    = error.hint;
  err.status  = error.status;
  return err;
}

// ── add_knowledge ─────────────────────────────────────────────────────────────

const VALID_PROVENANCE = new Set(['personal', 'organisational', 'employer', 'client', 'external']);

export async function addKnowledge(ctx, { type, content, title, source_type = 'typed', source_ref, tags, manual_tags, provenance, precomputed_auto_tags, is_living_document }) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new UserError('Content is required.');
  }
  assertLength('Content', content, MAX_KNOWLEDGE_CHARS);
  assertLength('Title',   title,   MAX_TITLE_CHARS);

  // Default to 'personal' — matches the DB column default. The system prompt
  // guides Claude to propose the correct provenance per record; this is the
  // fallback if the proposal sequence didn't supply one.
  const prov = provenance && VALID_PROVENANCE.has(provenance) ? provenance : 'personal';

  const db = getDB();

  // precomputed_auto_tags lets addDocument run one doc-level autoTag pass and
  // share the result across every chunk — avoids ~40 sequential gpt-4o-mini
  // round-trips on a long document. When not provided (typical path), behave
  // as before: tag the content directly.
  const autoTags = Array.isArray(precomputed_auto_tags)
    ? precomputed_auto_tags
    : await autoTag(content, manual_tags || []);
  const allTags  = [...new Set([...(manual_tags || []), ...autoTags])];

  const pid       = pineconeId();
  const embedding = await embed(content);

  const { data, error } = await db
    .from('knowledge')
    .insert({ user_id: ctx.userId, tenant_id: ctx.tenantId, type, title, content, source_type, source_ref: source_ref || null, tags: allTags, pinecone_id: pid, provenance: prov, is_living_document: Boolean(is_living_document) })
    .select()
    .single();

  if (error) throw sbError('knowledge.insert', error);

  await getNamespace(ctx.tenantId).upsert([{
    id: pid,
    values: embedding,
    // knowledge_type duplicates `type` for filtered retrieval (search_for_creation
    // queries by knowledge_type). The Pinecone wrapper would auto-fill this if
    // we forgot — being explicit here keeps reads + writes symmetric.
    metadata: {
      knowledge_id:   data.id,
      user_id:        ctx.userId,
      tenant_id:      ctx.tenantId,
      type,
      knowledge_type: type,
      provenance:     prov,
      source_type,
      source_ref:     source_ref || '',
      created_at:     data.created_at,
    },
  }]);

  return {
    stored: true,
    id: data.id,
    display_ref: formatDisplayRef({ id: data.id, title }),
    type,
    title: title || null,
    tags: allTags,
    auto_tagged: autoTags,
    provenance: prov,
    source: source_type === 'typed' ? 'typed directly' : `${source_type}: ${source_ref}`,
  };
}

// ── add_from_url ──────────────────────────────────────────────────────────────

export async function addFromUrl(ctx, { url, notes }) {
  // Validate URL + resolve DNS + block private/reserved IPs FIRST, before
  // allocating any resources (DB, embeddings, etc). Fail fast on bad input.
  const safeUrl = await validateUrlForFetch(url);

  const db = getDB();

  let html;
  try {
    html = await fetchWithSizeCap(safeUrl);
  } catch (err) {
    if (err?.userFacing) throw err;
    throw new UserError(`Could not fetch ${url}: ${err.message}`);
  }

  const text = stripHtml(html);
  if (text.length < 100) throw new UserError('Page has too little readable content.');

  const { data: types } = await db.from('schema_types').select('name').eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId);
  const typeNames = (types || []).map(t => t.name);

  const analysis = await analyseUrl(text, typeNames);

  if (!analysis.items?.length) {
    return { stored: false, url, reason: 'No knowledge worth storing found in this page', summary: analysis.summary };
  }

  const { data: source } = await db.from('sources')
    .insert({ user_id: ctx.userId, tenant_id: ctx.tenantId, source_type: 'url', reference: url, summary: analysis.summary, item_count: analysis.items.length })
    .select().single();

  const stored = [];
  for (const item of analysis.items) {
    const result = await addKnowledge(ctx, {
      type: item.type || 'knowledge',
      title: item.title,
      content: item.content,
      source_type: 'url',
      source_ref: url,
      manual_tags: item.tags || [],
    });
    stored.push(result);
  }

  return {
    stored: true,
    url,
    summary: analysis.summary,
    items_extracted: analysis.items.length,
    items: stored,
    source_id: source?.id,
  };
}

// ── add_document ──────────────────────────────────────────────────────────────
//
// `type` controls the storage strategy:
//   - 'skill'     → stored as ONE record (no chunking). Skills are reusable
//                   writing guides, templates, voice frameworks — they are most
//                   useful when retrieved whole in creation mode.
//   - 'knowledge' → chunked for fine-grained retrieval (default).

export async function addDocument(ctx, { filename, content, notes, type = 'knowledge' }) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new UserError('Document content is required.');
  }
  assertLength('Document', content, MAX_DOCUMENT_CHARS);

  const db = getDB();
  const knowledgeType = type === 'skill' ? 'skill' : 'knowledge';

  // Single doc-level autoTag pass shared across all storage paths.
  // autoTag truncates to 2000 chars internally — the doc head is the
  // representative sample. Avoids O(N) sequential gpt-4o-mini calls.
  const docAutoTags = await autoTag(content, []);

  const { data: source } = await db.from('sources')
    .insert({ user_id: ctx.userId, tenant_id: ctx.tenantId, source_type: 'document', reference: filename, item_count: 0 })
    .select().single();

  const stored = [];

  if (knowledgeType === 'skill') {
    // Skills are stored as a single whole record so that creation-mode retrieval
    // always returns the complete content, not a partial excerpt.
    const result = await addKnowledge(ctx, {
      type:                  'skill',
      content,
      title:                 filename,
      source_type:           'document',
      source_ref:            filename,
      precomputed_auto_tags: docAutoTags,
    });
    stored.push(result.id);
  } else {
    // Knowledge documents: chunk for fine-grained retrieval.
    // Chunk size 2500: ~3× fewer chunks than the old 800 without hurting quality.
    const chunks = chunkText(content, 2500, 100);

    // Parallelize chunks in batches of 8. Sequential batches bound peak
    // concurrency to ~8 simultaneous embed + insert + upsert pipelines.
    const BATCH_SIZE = 8;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((chunk, idx) =>
        addKnowledge(ctx, {
          type:                  'knowledge',
          content:               chunk,
          title:                 chunks.length > 1 ? `${filename} — part ${i + idx + 1}` : filename,
          source_type:           'document',
          source_ref:            filename,
          precomputed_auto_tags: docAutoTags,
        })
      ));
      for (const r of results) stored.push(r.id);
    }
  }

  if (source) await db.from('sources').update({ item_count: stored.length }).eq('id', source.id);

  return { stored: true, filename, chunks: stored.length, source_id: source?.id };
}

// ── add_reference_record ──────────────────────────────────────────────────────
//
// Captures a creation event: knowledge used + skill applied + output produced +
// the nuance of the case. The record is embedded so `find_patterns` can walk
// across reference records and surface meta-principles. Knowledge + skill IDs
// are encoded as structural tags so we can join back to source items later.

export async function addReferenceRecord(ctx, { title, knowledge_ids, skill_id, output_summary, nuance, tags }) {
  if (typeof output_summary !== 'string' || !output_summary.trim()) {
    throw new UserError('output_summary is required.');
  }
  assertLength('Output summary', output_summary, MAX_KNOWLEDGE_CHARS);
  assertLength('Nuance',         nuance || '',   MAX_KNOWLEDGE_CHARS);
  assertLength('Title',          title  || '',   MAX_TITLE_CHARS);

  // Compose a single embeddable record — markdown-ish, content-only.
  const parts = [];
  if (title)          parts.push(`# ${title}`);
  parts.push('## Output');
  parts.push(output_summary.trim());
  if (nuance && nuance.trim()) {
    parts.push('\n## Nuance');
    parts.push(nuance.trim());
  }
  const content = parts.join('\n\n');

  // Structural tags — let the LLM (and future queries) recover the linked
  // knowledge + skill ids from the reference record itself.
  const structuralTags = [];
  for (const kid of (Array.isArray(knowledge_ids) ? knowledge_ids : [])) {
    if (typeof kid === 'string' && kid) structuralTags.push(`ref-knowledge:${kid}`);
  }
  if (typeof skill_id === 'string' && skill_id) structuralTags.push(`ref-skill:${skill_id}`);

  // Hand off to addKnowledge — same provenance default (personal), same
  // embedding pipeline, same Pinecone metadata enrichment.
  const stored = await addKnowledge(ctx, {
    type:        'reference-record',
    title:       title || null,
    content,
    source_type: 'typed',
    manual_tags: [...(Array.isArray(tags) ? tags : []), ...structuralTags],
    provenance:  'personal',
  });

  return {
    stored:        true,
    id:            stored.id,
    display_ref:   stored.display_ref,
    type:          'reference-record',
    title:         stored.title,
    knowledge_ids: Array.isArray(knowledge_ids) ? knowledge_ids : [],
    skill_id:      skill_id || null,
    tags:          stored.tags,
  };
}

// ── add_voice_note ────────────────────────────────────────────────────────────

export async function addVoiceNote(ctx, { transcript, date, notes }) {
  if (typeof transcript !== 'string' || !transcript.trim()) {
    throw new UserError('Transcript is required.');
  }
  assertLength('Transcript', transcript, MAX_VOICE_NOTE_CHARS);

  const db = getDB();

  const sourceRef = `voice note${date ? ` — ${date}` : ''}`;

  const { data: source } = await db.from('sources')
    .insert({ user_id: ctx.userId, tenant_id: ctx.tenantId, source_type: 'voice-note', reference: sourceRef, item_count: 0 })
    .select().single();

  const items = await extractFromVoiceNote(transcript);

  if (!items.length) {
    return { stored: false, reason: 'Could not extract structured knowledge from transcript', source_ref: sourceRef };
  }

  const stored = [];
  for (const item of items) {
    const result = await addKnowledge(ctx, {
      type: item.type || 'principle',
      title: item.title,
      content: item.content,
      source_type: 'voice-note',
      source_ref: sourceRef,
      manual_tags: item.tags || [],
    });
    stored.push(result);
  }

  if (source) await db.from('sources').update({ item_count: stored.length }).eq('id', source.id);

  return {
    stored: true,
    source_ref: sourceRef,
    items_extracted: stored.length,
    items: stored.map(s => ({ id: s.id, type: s.type, title: s.title })),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, '\n\n').trim();
}

function chunkText(text, size = 800, overlap = 100) {
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = '';
  for (const p of paragraphs) {
    if ((current + p).length > size) {
      if (current) chunks.push(current.trim());
      current = p;
    } else {
      current += (current ? '\n\n' : '') + p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.slice(0, size)];
}
