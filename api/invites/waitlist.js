// POST /api/invites/waitlist
// Body: { email }
//
// Used when the prelaunch cap is reached. We accept the email into the
// waitlist table and return a uniform 200 — same enumeration-safe shape as
// the other auth endpoints.

import { getDB } from '../../lib/supabase.js';
import { checkRateLimit, RATE_LIMITS } from '../../lib/rate-limit.js';
import { logAudit } from '../../lib/audit.js';

const MIN_RESPONSE_MS = 800;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { return res.status(405).json({ error: 'POST only' }); }

  const startedAt = Date.now();
  try {
    const email = String((req.body || {}).email || '').trim();
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const cleaned = email.toLowerCase();
      const rl = await checkRateLimit(`auth:${cleaned}`, RATE_LIMITS.AUTH_PER_HOUR);
      if (!rl.exceeded) {
        try {
          const db = getDB();
          await db.from('waitlist').insert({ email: cleaned, source: 'invite_full' });
          logAudit({ eventType: 'waitlist_signup', success: true });
        } catch (err) {
          console.error('[invites/waitlist] insert failed:', err && err.message);
          logAudit({ eventType: 'waitlist_signup', success: false, errorType: 'InsertFailed' });
        }
      }
    }
  } finally {
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_RESPONSE_MS) {
      await new Promise(r => setTimeout(r, MIN_RESPONSE_MS - elapsed));
    }
    res.status(200).json({ ok: true });
  }
}
