// Shared plumbing for /api/twin/* REST endpoints.
//
// Every twin endpoint follows the same shape: method guard → requireTenant
// → optional cap check → call into a tools/* function → audit log + JSON
// response. This module owns that shape so the per-route files stay focused
// on the input/output mapping for one specific tool.

import { requireTenant } from './anon.js';
import { checkAndIncrementCap, capExceededBody } from './caps.js';
import { logAudit } from './audit.js';

export function methodGuard(req, res, methods) {
  if (!methods.includes(req.method)) {
    res.setHeader('Allow', methods.join(', '));
    res.status(405).json({ error: `${methods.join(' or ')} only` });
    return false;
  }
  return true;
}

/**
 * Resolve the tenant, check the cap if requested, run the handler, audit,
 * and respond. The handler returns the JSON body to send on success.
 *
 * @param {object} opts
 * @param {string} opts.toolName    — for audit logging
 * @param {'chat'|'storage'|'synthesise'} [opts.cap] — kind to count against
 * @param {(ctx) => Promise<any>} opts.fn — receives { userId, tenantId, isAnonymous }
 */
export async function runTwin(req, res, { toolName, cap, fn }) {
  const ctx = await requireTenant(req);
  if (!ctx) {
    return res.status(401).json({
      error: 'No session. Call POST /api/anon/init first to create an anonymous session.',
    });
  }

  if (cap) {
    const c = await checkAndIncrementCap({
      tenantId:    ctx.tenantId,
      userId:      ctx.userId,
      kind:        cap,
      isAnonymous: ctx.isAnonymous,
    });
    if (!c.allowed) {
      return res.status(429).json(capExceededBody({ kind: cap, cap: c.cap }));
    }
  }

  try {
    const result = await fn(ctx);
    logAudit({
      userId:    ctx.userId,
      tenantId:  ctx.tenantId,
      eventType: 'tool_call',
      toolName,
      itemId:    result && typeof result === 'object' && typeof result.id === 'string' ? result.id : null,
      success:   true,
    });
    return res.status(200).json(result);
  } catch (err) {
    const userFacing = !!err?.userFacing;
    // Handlers can throw an error with `.status` + `.body` to surface a
    // structured non-200 response (used by /api/twin/turn to surface
    // intent-specific cap exceedances without leaving runTwin).
    const explicitStatus = typeof err?.status === 'number' ? err.status : null;
    logAudit({
      userId:    ctx.userId,
      tenantId:  ctx.tenantId,
      eventType: 'tool_call',
      toolName,
      success:   false,
      errorType: explicitStatus ? `HTTP${explicitStatus}` : (userFacing ? 'UserError' : 'InternalError'),
      errorMsg:  err?.message,
    });
    if (explicitStatus) {
      return res.status(explicitStatus).json(err.body || { error: err.message });
    }
    if (userFacing) {
      return res.status(400).json({ error: err.message });
    }
    console.error(`[twin/${toolName}] error:`, {
      message: err?.message,
      stack:   err?.stack?.split('\n').slice(0, 4).join(' | '),
    });
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
}

/**
 * Throw to bail out of a runTwin handler with an explicit HTTP status + body.
 * Use for things like "cap exceeded for the specific intent we just classified".
 */
export class HttpError extends Error {
  constructor(status, body, message) {
    super(message || (body && body.error) || `HTTP ${status}`);
    this.status = status;
    this.body   = body;
  }
}
