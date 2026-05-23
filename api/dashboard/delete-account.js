// POST /api/dashboard/delete-account
//
// Irreversible. Two-step confirm via explicit string match in the request body —
// the client must POST { "confirm": "DELETE-MY-ACCOUNT" } verbatim. We also
// require a live session (the magic-link verify must have succeeded) so a
// stolen URL alone can't trigger deletion.
//
// On success: session cookie is cleared, response includes the deleted
// tenant_id (for the client's own audit if it wants).

import { requireAuth, clearSessionCookie } from '../../lib/auth.js';
import { deleteAccount } from '../../lib/account.js';

const CONFIRM_PHRASE = 'DELETE-MY-ACCOUNT';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const session = await requireAuth(req);
  if (!session) {
    return res.status(401).json({ error: 'Not signed in' });
  }

  if (!req.body || req.body.confirm !== CONFIRM_PHRASE) {
    return res.status(400).json({
      error: `Confirmation required. POST { "confirm": "${CONFIRM_PHRASE}" } to proceed.`,
    });
  }

  try {
    const result = await deleteAccount({ userId: session.userId });
    clearSessionCookie(res);
    return res.status(200).json({
      deleted: true,
      tenant_id: result.tenantId,
      pinecone_deleted: result.pineconeDeleted,
    });
  } catch (err) {
    console.error('delete-account error:', err && err.message);
    return res.status(500).json({ error: 'Could not complete deletion. Try again.' });
  }
}
