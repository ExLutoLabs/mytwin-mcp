import { getDB } from '../lib/supabase.js';
import { getNamespace } from '../lib/pinecone.js';
import { formatDisplayRef } from '../lib/display-ref.js';

function sbError(op, error) {
  console.error(`[mytwin/supabase] ${op} failed:`, {
    message: error.message, code: error.code, details: error.details, hint: error.hint, status: error.status,
  });
  const err = new Error(error.message);
  err.code = error.code; err.details = error.details; err.hint = error.hint; err.status = error.status;
  return err;
}

// ── list_recent ───────────────────────────────────────────────────────────────

export async function listRecent(ctx, { limit = 10, type } = {}) {
  const db = getDB();

  let query = db.from('knowledge').select('*').eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }).limit(limit);
  if (type) query = query.eq('type', type);

  const { data, error } = await query;
  if (error) throw sbError('management', error);

  return {
    items: (data || []).map(row => ({
      id: row.id,
      display_ref: formatDisplayRef({ id: row.id, title: row.title }),
      type: row.type,
      title: row.title,
      content: row.content.slice(0, 200) + (row.content.length > 200 ? '…' : ''),
      tags: row.tags || [],
      provenance: row.provenance || 'personal',
      source_ref: formatSource(row) || 'source not recorded',
      created_at: row.created_at || 'source not recorded',
    })),
    count: data?.length || 0,
  };
}

// ── update_knowledge ──────────────────────────────────────────────────────────

export async function updateKnowledge(ctx, { id, content, title, tags, type, provenance }) {
  const db = getDB();

  const updates = {};
  if (content    !== undefined) updates.content    = content;
  if (title      !== undefined) updates.title      = title;
  if (tags       !== undefined) updates.tags       = tags;
  if (type       !== undefined) updates.type       = type;
  if (provenance !== undefined) {
    if (!['personal', 'organisational', 'external'].includes(provenance)) {
      throw new Error(`provenance must be one of: personal, organisational, external`);
    }
    updates.provenance = provenance;
  }

  if (!Object.keys(updates).length) throw new Error('Nothing to update — provide at least one of: content, title, tags, type, provenance');

  // .maybeSingle() returns data=null on 0 rows (instead of throwing the
  // "Cannot coerce" error .single() raises). Cleaner cross-tenant story —
  // an attacker trying to update someone else's id gets the same friendly
  // "Item not found" message as delete_knowledge.
  const { data, error } = await db.from('knowledge').update(updates).eq('id', id).eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId).select().maybeSingle();
  if (error) throw sbError('management', error);
  if (!data) throw new Error(`Item ${id} not found`);

  // Re-embed if content changed; or update metadata-only if only type/provenance
  // changed so Pinecone filters stay consistent with the source-of-truth row.
  if (data.pinecone_id) {
    const ns = getNamespace(ctx.tenantId);
    const newMetadata = {
      knowledge_id:   data.id,
      user_id:        ctx.userId,
      tenant_id:      ctx.tenantId,
      type:           data.type,
      knowledge_type: data.type,
      provenance:     data.provenance || 'personal',
      source_type:    data.source_type || 'typed',
      source_ref:     data.source_ref || '',
      created_at:     data.created_at,
    };
    if (content) {
      const { embed } = await import('../lib/embed.js');
      const embedding = await embed(content);
      await ns.upsert([{ id: data.pinecone_id, values: embedding, metadata: newMetadata }]);
    } else if (updates.type !== undefined || updates.provenance !== undefined) {
      // Metadata-only update — no re-embed needed.
      try { await ns.update({ id: data.pinecone_id, metadata: newMetadata }); }
      catch (err) { console.error('[update_knowledge] Pinecone metadata update failed:', err?.message); }
    }
  }

  return {
    updated: true,
    id,
    display_ref:    formatDisplayRef({ id: data.id, title: data.title }),
    fields_changed: Object.keys(updates),
  };
}

// ── delete_knowledge ──────────────────────────────────────────────────────────

export async function deleteKnowledge(ctx, { id }) {
  const db = getDB();

  const { data, error } = await db.from('knowledge').select('pinecone_id, title').eq('id', id).eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId).single();
  if (error || !data) throw new Error(`Item ${id} not found`);

  await db.from('knowledge').delete().eq('id', id).eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId);

  if (data.pinecone_id) {
    try { await getNamespace(ctx.tenantId).deleteOne(data.pinecone_id); } catch {}
  }

  return {
    deleted: true,
    id,
    display_ref: formatDisplayRef({ id, title: data.title }),
  };
}

// ── helper ─────────────────────────────────────────────────────────────────────

function formatSource(row) {
  if (!row) return 'source not recorded';
  if (!row.source_type || row.source_type === 'typed') return 'typed directly';
  const ref = (row.source_ref || '').trim();
  return ref ? `${row.source_type}: ${ref}` : `${row.source_type} (no reference)`;
}
