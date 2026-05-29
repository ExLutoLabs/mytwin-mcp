// lib/background-log.js
//
// Lightweight persistence for async background job results.
// Jobs write their outcome here; turn.js reads recent results to surface
// actionable prompts (e.g. drift detection for living documents).
//
// All functions are non-fatal — callers are expected to .catch(() => ...).

import { getDB } from './supabase.js';

const STALE_DAYS = 7;

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Persist a background job result.
 * @param {string} tenantId
 * @param {string} jobName     — e.g. 'drift-detection', 'compile-concepts'
 * @param {string} status      — e.g. 'completed', 'failed', 'skipped'
 * @param {object} meta        — arbitrary JSON payload
 */
export async function writeBackgroundLog(tenantId, jobName, status, meta = {}) {
  const db = getDB();
  const { error } = await db.from('background_log').insert({
    tenant_id: tenantId,
    job_name:  jobName,
    status,
    meta,
  });
  if (error) {
    console.error('[background-log] write failed:', error.message);
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Fetch the most recent log entry for a job within the given age window.
 * Returns null if nothing found or if the query fails.
 *
 * @param {string} tenantId
 * @param {string} jobName
 * @param {number} maxAgeHours — how far back to look (default 24h)
 * @returns {Promise<{ status: string, meta: object, created_at: string } | null>}
 */
export async function getRecentBackgroundLog(tenantId, jobName, maxAgeHours = 24) {
  const db = getDB();
  const since = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();

  const { data, error } = await db
    .from('background_log')
    .select('status, meta, created_at')
    .eq('tenant_id', tenantId)
    .eq('job_name', jobName)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('[background-log] read failed:', error.message);
    return null;
  }
  return data?.[0] || null;
}

// ── Drift detection ───────────────────────────────────────────────────────────

/**
 * Checks all living documents for a tenant, writes stale ones to background_log.
 * "Stale" = not updated in >= STALE_DAYS (7) days.
 * Non-fatal — caller should .catch(() => ...).
 *
 * @param {string} tenantId
 * @returns {Promise<{ checked: number, stale: number }>}
 */
export async function runDriftCheck(tenantId) {
  const db = getDB();

  const { data: docs, error } = await db
    .from('knowledge')
    .select('id, title, updated_at')
    .eq('tenant_id',          tenantId)
    .eq('is_living_document', true);

  if (error) throw new Error(error.message);

  const threshold = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  const staleDocs = (docs || []).filter(d =>
    (d.updated_at ? new Date(d.updated_at).getTime() : 0) < threshold
  );

  if (staleDocs.length > 0) {
    await writeBackgroundLog(tenantId, 'drift-detection', 'completed', {
      stale_document_ids: staleDocs.map(d => d.id),
      stale_titles:       staleDocs.map(d => d.title || 'Untitled'),
    });
  }

  return { checked: (docs || []).length, stale: staleDocs.length };
}
