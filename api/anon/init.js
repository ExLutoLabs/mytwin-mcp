// POST /api/anon/init — mint a new anonymous tenant for the /twin page.
//
// Called from the browser when the page loads and finds no `mt_anon_token`
// in localStorage. Provisions: anonymous tenants row + placeholder users
// row + default schema types, then returns a signed JWT that the frontend
// stores and sends back via `X-Anon-Token` on every subsequent twin call.
//
// IP-rate-limited to slow trivial mass-provisioning. We cannot perfectly
// prevent abuse here (a new IP = a new bucket), but a small cap keeps the
// table from filling up from a single host.

import { createAnonymousTenant, createAnonToken } from '../../lib/anon.js';
import { checkRateLimit } from '../../lib/rate-limit.js';
import { logAudit } from '../../lib/audit.js';

const ANON_INIT_PER_HOUR = 10;

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const ip = clientIp(req);
  const rl = await checkRateLimit(`anon-init:${ip}`, ANON_INIT_PER_HOUR);
  if (rl.exceeded) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    return res.status(429).json({
      error: `Too many anonymous sessions from this network. Try again in ${Math.ceil(rl.retryAfterSeconds / 60)} minute${rl.retryAfterSeconds >= 120 ? 's' : ''}.`,
    });
  }

  try {
    const { tenantId, userId } = await createAnonymousTenant();
    const anonToken = await createAnonToken({ tenantId, userId });

    logAudit({
      userId,
      tenantId,
      eventType: 'anon_tenant_init',
      success: true,
    });

    return res.status(200).json({
      ok: true,
      anonToken,
      tenantId,
      userId,
    });
  } catch (err) {
    console.error('[anon/init] failed:', err?.message);
    logAudit({
      eventType: 'anon_tenant_init',
      success: false,
      errorType: 'InternalError',
      errorMsg: err?.message,
    });
    return res.status(500).json({ error: 'Could not start a session. Try again.' });
  }
}
