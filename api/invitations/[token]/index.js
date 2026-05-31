// GET /api/invitations/:token — look up a pending share invitation.
//
// Public: the token is the bearer secret. Returns only the item TITLE and TYPE
// (never its content) so the token alone cannot leak the owner's data. The
// accept page renders from this, then POSTs to .../accept.

import { methodGuard } from '../../../lib/twin-api.js';
import { getInvitationByToken } from '../../../lib/sharing.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  const { token } = req.query;
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'token is required in the path' });
  }

  try {
    const inv = await getInvitationByToken(token);
    if (!inv) return res.status(404).json({ error: 'Invitation not found.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(inv);
  } catch (err) {
    console.error('[invitations/get] error:', err?.message);
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
}
