// POST /api/auth/signout — clear the session cookie and log the sign-out.
//
// Doesn't invalidate the underlying magic token (it's already single-use).
// Simply expires the cookie so future requests are treated as anonymous.

import { clearSessionCookie } from '../../lib/auth.js';
import { logAudit }           from '../../lib/audit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  clearSessionCookie(res);
  logAudit({ eventType: 'signed_out', success: true });
  return res.status(200).json({ ok: true });
}
