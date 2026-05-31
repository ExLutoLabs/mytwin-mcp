// POST /api/invitations/:token/accept — accept a share invitation.
//
// Public, token-gated, single-use. Provisions the recipient's account if needed
// (bypassing the invite-only signup gate — the share is the invitation),
// materialises the grant, and signs the recipient in by setting the session
// cookie. Possessing the token proves control of the invited email, the same
// trust model as a magic link.

import { methodGuard } from '../../../lib/twin-api.js';
import { acceptInvitation } from '../../../lib/sharing.js';
import { setSessionCookie } from '../../../lib/auth.js';
import { logAudit } from '../../../lib/audit.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { token } = req.query;
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'token is required in the path' });
  }

  try {
    const result = await acceptInvitation(token);

    setSessionCookie(res, result.sessionJwt);
    logAudit({
      userId:    result.user.id,
      tenantId:  result.user.tenant_id || null,
      eventType: 'invitation_accepted',
      itemId:    result.itemId,
      success:   true,
      context:   { level: result.level },
    });

    return res.status(200).json({
      accepted: true,
      level:    result.level,
      item_id:  result.itemId,
      email:    result.user.email,
    });
  } catch (err) {
    const status  = typeof err?.status === 'number' ? err.status : (err?.userFacing ? 400 : 500);
    const message = status >= 500 ? 'Something went wrong. Try again.' : err.message;
    if (status >= 500) console.error('[invitations/accept] error:', err?.message);
    logAudit({ eventType: 'invitation_accepted', success: false, errorType: `HTTP${status}`, errorMsg: err?.message });
    return res.status(status).json({ error: message });
  }
}
