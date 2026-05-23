// POST /api/admin/seed-invites
// Body: { count?: number }   (default 50)
//
// One-shot helper. Generates N invite codes and inserts them into the
// `invites` table with no generated_by_user_id (= seed invites). Returns
// the codes so they can be copied and distributed.
//
// Gated by X-Admin-Token (constant-time compare against ADMIN_TOKEN env var).
// Safe to re-run — every call appends N more seed codes; this does NOT
// modify or remove existing codes. Decide carefully if you re-run.

import { createHash, timingSafeEqual } from 'node:crypto';
import { seedInvites } from '../../lib/invites.js';

export const config = { maxDuration: 60 };

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

  const requested = Number((req.body || {}).count) || 50;
  const count     = Math.max(1, Math.min(500, requested));

  try {
    const codes = await seedInvites(count);
    return res.status(200).json({
      seeded: codes.length,
      codes,
      note:   'These are seed invites (no generated_by_user_id). Distribute and watch them get redeemed. Each redemption mints exactly one new invite for the redeemer to pass on.',
    });
  } catch (err) {
    console.error('[admin/seed-invites] failed:', err && err.message);
    return res.status(500).json({ error: 'Could not seed invites. Try again.' });
  }
}
