import { getDB } from '../lib/supabase.js';
import { findPatterns } from '../lib/embed.js';
import { formatDisplayRef } from '../lib/display-ref.js';

// ── find_patterns ─────────────────────────────────────────────────────────────

export async function findPatternsInKnowledge(ctx, { focus } = {}) {
  const db = getDB();

  // Three-layer analysis:
  //   1. Reference records — what the user *did* (nuance, adaptation).
  //   2. Skills            — the craft layer (shared structural elements).
  //   3. Everything else   — broader knowledge corpus (only if no narrower focus).
  // When the focus param is provided we constrain to that type only (back-compat
  // with the old behaviour). With no focus, we slice each layer and combine them.

  if (focus) {
    const { data, error } = await db.from('knowledge')
      .select('type, title, content, source_type, tags, provenance')
      .eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId)
      .eq('type', focus)
      .order('created_at', { ascending: false }).limit(100);
    if (error) {
      console.error('[mytwin/supabase] analysis failed:', { message: error.message, code: error.code });
      throw new Error(error.message);
    }
    if (!data?.length) {
      return { patterns: [], note: `Nothing of type "${focus}" yet — add more items before re-running.` };
    }
    const patterns = await findPatterns(data);
    return {
      patterns,
      items_analysed: data.length,
      layers:         { focus },
      note: patterns.length
        ? 'Recurring themes inside this slice. Use add_knowledge with type "principle" to formalise any that resonate.'
        : 'No strong patterns found yet.',
    };
  }

  // No focus — sample each layer separately and combine, so the LLM can spot
  // patterns that span "what the user has done" + "how they like to do it".
  const [{ data: refs }, { data: skills }, { data: knowledge }] = await Promise.all([
    db.from('knowledge').select('type, title, content, tags, provenance')
      .eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId)
      .eq('type', 'reference-record')
      .order('created_at', { ascending: false }).limit(50),
    db.from('knowledge').select('type, title, content, tags, provenance')
      .eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId)
      .in('type', ['skill', 'voice', 'template'])
      .order('created_at', { ascending: false }).limit(50),
    db.from('knowledge').select('type, title, content, tags, provenance')
      .eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId)
      .in('type', ['knowledge', 'principle', 'brand', 'idea', 'resource'])
      .order('created_at', { ascending: false }).limit(50),
  ]);

  const total = (refs?.length || 0) + (skills?.length || 0) + (knowledge?.length || 0);
  if (total === 0) {
    return { patterns: [], note: 'Add more knowledge first — voice notes and reference records work especially well for pattern detection.' };
  }

  // Annotate each chunk with its layer so the LLM can reason about provenance
  // of the pattern (does it come from what the user did, vs how they like to
  // do things, vs what they know).
  const tag = (rows, layer) => (rows || []).map(r => ({ ...r, _layer: layer }));
  const all = [...tag(refs, 'reference-record'), ...tag(skills, 'skill'), ...tag(knowledge, 'knowledge')];

  const patterns = await findPatterns(all);
  // Filter to "appears 3+ times" per the brief — the LLM returns an evidence
  // array per pattern; we keep only those with >=3 evidence items.
  const strongPatterns = (patterns || []).filter(p => Array.isArray(p.evidence) && p.evidence.length >= 3);

  // Token frugality: cap patterns_all to 8 and trim per-pattern description /
  // evidence so the whole response stays under ~1500 tokens.
  const trim = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
  const slim = (p) => ({
    theme:                p.theme,
    description:          trim(p.description, 240),
    evidence:             (p.evidence || []).slice(0, 5).map(e => trim(String(e), 120)),
    suggested_principle:  trim(p.suggested_principle, 200),
  });

  return {
    patterns:        strongPatterns.slice(0, 8).map(slim),
    patterns_all:    (patterns || []).slice(0, 8).map(slim),
    items_analysed:  total,
    layers: {
      reference_records: refs?.length || 0,
      skills:            skills?.length || 0,
      knowledge:         knowledge?.length || 0,
    },
    note: strongPatterns.length
      ? 'Candidate meta-principles — patterns that appear 3 or more times across your reference records, skills, and knowledge. Worth confirming with the user before storing.'
      : 'No strong (3+ evidence) meta-principles yet. Surface anything from patterns_all softly, with care.',
  };
}

// ── get_sources ───────────────────────────────────────────────────────────────

export async function getSources(ctx, { source_type } = {}) {
  const db = getDB();

  let query = db.from('sources').select('*').eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId).order('ingested_at', { ascending: false }).limit(50);
  if (source_type) query = query.eq('source_type', source_type);

  const { data, error } = await query;
  if (error) { console.error('[mytwin/supabase] analysis failed:', { message: error.message, code: error.code, details: error.details }); throw new Error(error.message); }

  return {
    sources: (data || []).map(s => ({
      id: s.id,
      display_ref:  formatDisplayRef({ id: s.id, title: s.reference }),
      type: s.source_type,
      // source_ref + created_at are the canonical retrieval fields — Claude
      // uses these to cite "Source: [name] — added [date]" per the system
      // prompt. Fall back to "source not recorded" on empty values.
      source_ref:   s.reference || 'source not recorded',
      created_at:   s.ingested_at || 'source not recorded',
      summary:      s.summary || null,
      items_stored: s.item_count || 0,
    })),
    count: (data || []).length,
  };
}
