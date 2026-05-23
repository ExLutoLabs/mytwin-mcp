// POST /api/dashboard/regenerate-token — revoke the current MCP token and
// issue a new one. Used by the /create page's "Regenerate" button.
//
// Returns the new token value exactly once, in the response body. After this
// response we can never retrieve the raw value again — only the SHA-256 hash
// is stored.

import { requireAuth, mintMcpTokenForUser } from '../../lib/auth.js';
import { logAudit } from '../../lib/audit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const session = await requireAuth(req);
  if (!session) {
    return res.status(401).json({ error: 'Not signed in' });
  }

  try {
    const minted     = await mintMcpTokenForUser(session.userId);
    const mcpUrlBase = `${process.env.APP_URL || 'https://myaitwin.lutolearn.com'}/api/mcp`;
    logAudit({ userId: session.userId, eventType: 'token_regenerated', success: true });
    res.status(200).json({
      prefix:      minted.prefix,
      value:       minted.token,
      mcpUrl:      `${mcpUrlBase}/${minted.token}`,
      mcpUrlBase,
      created_at:  minted.createdAt,
    });
  } catch (err) {
    console.error('regenerate-token error:', err);
    logAudit({ userId: session.userId, eventType: 'token_regenerated', success: false, errorType: 'Internal', errorMsg: err?.message });
    res.status(500).json({ error: 'Could not generate a new token. Try again.' });
  }
}
