// Per-tenant message caps for anonymous tenants on the /twin web interface.
//
// Caps live here in code, counters live on tenants.{chat_count,
// storage_count, synthesise_count} (migration 009), and the
// increment_anon_cap(p_tenant_id, p_kind, p_cap) RPC handles atomic
// increment + cap check.
//
// Authenticated tenants pass through (the RPC short-circuits and returns
// exceeded=false). Anonymous tenants get capped per kind:
//   * 'chat'       — POST /api/twin/chat invocations
//   * 'storage'    — combined add_knowledge + add_document + add_voice_note
//   * 'synthesise' — POST /api/twin/synthesise invocations
//
// When the cap is hit, the endpoint should return 429 with a JSON body the
// frontend can use to render a sign-up CTA — caller handles the response
// shape; this module only enforces.

import { getDB } from './supabase.js';
import { logAudit } from './audit.js';

export const CAPS = {
  chat:       20,
  storage:    30,
  synthesise: 3,
};

/**
 * Atomically increment the named cap counter for a tenant and check whether
 * the cap was exceeded.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.userId      — only used for audit logging on cap-hit
 * @param {'chat'|'storage'|'synthesise'} args.kind
 * @param {boolean} args.isAnonymous — short-circuits to allowed for auth'd tenants
 * @returns {Promise<{ allowed: boolean, cap: number, used: number, remaining: number }>}
 *          On infra failure: fails OPEN (allowed=true). A logged error tells ops.
 */
export async function checkAndIncrementCap({ tenantId, userId, kind, isAnonymous }) {
  const cap = CAPS[kind];
  if (typeof cap !== 'number') {
    throw new Error(`unknown cap kind: ${kind}`);
  }

  // Authenticated tenants are uncapped at this layer. We still call through
  // to the RPC for symmetry and to keep all "cap state" in one place, but the
  // RPC returns exceeded=false without touching the counter columns.
  if (!isAnonymous) {
    return { allowed: true, cap, used: 0, remaining: Infinity };
  }

  try {
    const db = getDB();
    const { data, error } = await db.rpc('increment_anon_cap', {
      p_tenant_id: tenantId,
      p_kind:      kind,
      p_cap:       cap,
    });
    if (error || !data || !data.length) {
      console.error('[caps] RPC failed — failing open:', error?.message || 'no data');
      return { allowed: true, cap, used: 0, remaining: cap };
    }

    const row      = data[0];
    const used     = row.new_count || 0;
    const exceeded = !!row.exceeded;
    const remaining = Math.max(0, cap - used);

    if (exceeded) {
      logAudit({
        userId,
        tenantId,
        eventType: 'anon_cap_exceeded',
        success: false,
        errorType: 'CapExceeded',
        context: { kind, cap, used },
      });
    }

    return { allowed: !exceeded, cap, used, remaining };
  } catch (err) {
    console.error('[caps] threw — failing open:', err?.message);
    return { allowed: true, cap, used: 0, remaining: cap };
  }
}

/**
 * Standard 429 response body for a cap-hit. Endpoints serialise this so the
 * frontend can render the sign-up CTA with consistent fields.
 */
export function capExceededBody({ kind, cap }) {
  const labels = {
    chat:       'chat messages',
    storage:    'captures',
    synthesise: 'reflections',
  };
  return {
    error: `You've reached the ${cap}-${labels[kind] || kind} limit for this anonymous session.`,
    cap_kind: kind,
    cap,
    signup_required: true,
    signup_url: '/create',
  };
}
