// GET /api/invites/check?code=XXXXXXXX
//
// Validates an invite code and returns its current state, marking it as
// "visited" (bumps visit_count + sets first_visited_at). Used by the
// prelaunch page on initial load.
//
// Returns a generic-shape response so the client can render the right UI:
//   { valid, redeemed, cap_reached, spots_left, redemptions_total, visit_count }
// Or, on invalid/unknown code:
//   { valid: false, reason: 'no_code' | 'not_found' | 'lookup_failed' }

import { checkInvite } from '../../lib/invites.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }
  const code = String(req.query.code || '').trim().toUpperCase();
  const state = await checkInvite(code);
  return res.status(200).json(state);
}
