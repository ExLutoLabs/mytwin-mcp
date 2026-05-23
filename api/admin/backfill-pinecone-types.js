// POST /api/admin/backfill-pinecone-types
//
// One-shot Pinecone metadata backfill for the V2 additions.
//   * Adds `knowledge_type` to every existing vector's metadata
//     (derived from the source row's `type` column)
//   * Adds `provenance` to every existing vector's metadata
//     (defaults to 'personal' for rows that didn't have one)
//
// Pinecone supports metadata-only updates via `namespace.update({ id, metadata })`
// — no re-embed needed. Idempotent: re-running is a no-op once metadata is set.
//
// Auth: X-Admin-Token (constant-time compare against ADMIN_TOKEN env var).
// Re-runnable any time. DELETE THIS FILE after the migration is verified.

import { createHash, timingSafeEqual } from 'node:crypto';
import { getDB } from '../../lib/supabase.js';
import { getNamespace } from '../../lib/pinecone.js';

export const config = { maxDuration: 300 };

function authed(req) {
  const provided = String(req.headers['x-admin-token'] || '');
  const expected = String(process.env.ADMIN_TOKEN || '');
  if (expected.length < 32) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!authed(req))           return res.status(401).json({ error: 'Unauthorised' });

  const body = req.body || {};
  const mode = body.mode || 'dry-run';
  const db   = getDB();

  // ── Common: pull every knowledge row (we only need a handful of cols) ──
  const { data: rows, error } = await db
    .from('knowledge')
    .select('id, tenant_id, user_id, type, source_type, source_ref, created_at, pinecone_id, provenance')
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const withVector = (rows || []).filter(r => r.pinecone_id);

  if (mode === 'dry-run') {
    const byTenant = {};
    const byType   = {};
    for (const r of withVector) {
      byTenant[r.tenant_id] = (byTenant[r.tenant_id] || 0) + 1;
      byType[r.type]        = (byType[r.type]        || 0) + 1;
    }
    return res.json({
      mode: 'dry-run',
      total_rows:        rows?.length || 0,
      rows_with_vector:  withVector.length,
      tenants:           Object.keys(byTenant).length,
      counts_by_tenant:  byTenant,
      counts_by_type:    byType,
      note: 'No changes made. POST { "mode": "apply" } to backfill knowledge_type + provenance into Pinecone metadata.',
    });
  }

  if (mode === 'apply') {
    const report = { updated: 0, failed: 0, errors: [], per_tenant: {} };

    // Group by tenant so we can use one namespace per tenant
    const byTenant = {};
    for (const r of withVector) (byTenant[r.tenant_id] ||= []).push(r);

    for (const [tenantId, items] of Object.entries(byTenant)) {
      report.per_tenant[tenantId] = { updated: 0, failed: 0 };
      const ns = getNamespace(tenantId);
      for (const row of items) {
        const metadata = {
          knowledge_id:   row.id,
          user_id:        row.user_id,
          tenant_id:      tenantId,
          type:           row.type,
          knowledge_type: row.type || 'knowledge',
          provenance:     row.provenance || 'personal',
          source_type:    row.source_type || 'typed',
          source_ref:     row.source_ref || '',
          created_at:     row.created_at,
        };
        try {
          await ns.update({ id: row.pinecone_id, metadata });
          report.per_tenant[tenantId].updated++;
          report.updated++;
        } catch (err) {
          report.per_tenant[tenantId].failed++;
          report.failed++;
          report.errors.push({ pinecone_id: row.pinecone_id, error: err?.message });
        }
      }
    }
    return res.json({ mode: 'apply', ...report });
  }

  return res.status(400).json({ error: 'mode must be one of: dry-run | apply' });
}
