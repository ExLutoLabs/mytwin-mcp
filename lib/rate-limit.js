// Rate limiting backed by the rate_limits table + increment_rate_limit RPC.
//
// Fixed-window: counts are bucketed per hour. Atomic at the DB layer — the
// RPC does upsert+increment in a single statement so concurrent invocations
// can't race past the limit.
//
// Limits are decided by the caller via key + max. Examples used today:
//   MCP tool calls:        key=`mcp:${tenantId}`,  max=100  (per hour, per tenant)
//   Magic-link requests:   key=`auth:${email}`,    max=5    (per hour, per email)
//
// Failures (DB unreachable, RPC missing) FAIL OPEN: we don't 429 a user
// because the rate-limit infra is sick. Errors are logged for ops to act on.

import { getDB } from './supabase.js';

export const RATE_LIMITS = {
  MCP_PER_HOUR:         100,
  SHARED_MCP_PER_HOUR:  50,
  AUTH_PER_HOUR:        5,
};

/**
 * Atomically increment the bucket and check whether the configured max was crossed.
 * @param {string} key  Opaque bucket key, e.g. "mcp:<tenantId>"
 * @param {number} max  Maximum requests allowed in the current hour window
 * @returns {Promise<{ exceeded: boolean, newCount: number, retryAfterSeconds: number }>}
 *          On infra failure, returns { exceeded: false, newCount: 0, retryAfterSeconds: 0 }.
 */
export async function checkRateLimit(key, max) {
  try {
    const db = getDB();
    const { data, error } = await db.rpc('increment_rate_limit', {
      p_key: key,
      p_max: max,
    });
    if (error || !data || !data.length) {
      console.error('[rate-limit] RPC failed — failing open:', error?.message || 'no data');
      return { exceeded: false, newCount: 0, retryAfterSeconds: 0 };
    }
    // Postgres returns one row from the table-returning function
    const row = data[0];
    return {
      exceeded:           !!row.exceeded,
      newCount:           row.new_count || 0,
      // Seconds until the top of the next hour — same for everyone in the bucket.
      retryAfterSeconds:  secondsUntilNextHour(),
    };
  } catch (err) {
    console.error('[rate-limit] threw — failing open:', err && err.message);
    return { exceeded: false, newCount: 0, retryAfterSeconds: 0 };
  }
}

function secondsUntilNextHour() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(now.getHours() + 1, 0, 0, 0);
  return Math.max(1, Math.floor((next.getTime() - now.getTime()) / 1000));
}
