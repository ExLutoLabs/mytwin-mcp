// GET    /api/dashboard/shared-token  — check whether an active shared token exists
// POST   /api/dashboard/shared-token  — generate a new shared token (revokes old)
// DELETE /api/dashboard/shared-token  — revoke the active shared token
//
// GET never returns the raw token — only prefix, id, and timestamps.
// POST returns the raw token ONCE for the user to copy. After that only
// the prefix is ever shown again.
//
// Authentication: same session cookie as all other /api/dashboard/* routes.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import {
  getActiveSharedTokenInfo,
  mintSharedTokenForUser,
  revokeSharedTokenForUser,
} from '../../lib/auth.js';

// Base URL for the shared MCP endpoint
const SHARED_MCP_BASE = process.env.APP_BASE_URL || 'https://myaitwin.lutolearn.com';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST', 'DELETE'])) return;

  return runTwin(req, res, {
    toolName: 'dashboard_shared_token',
    fn: async (ctx) => {

      // ── GET — status check ─────────────────────────────────────────────────
      if (req.method === 'GET') {
        const info = await getActiveSharedTokenInfo(ctx.userId);
        if (!info) {
          return { exists: false };
        }
        return {
          exists:      true,
          id:          info.id,
          prefix:      info.prefix,
          createdAt:   info.createdAt,
          lastUsedAt:  info.lastUsedAt,
        };
      }

      // ── POST — generate (revoke old, mint new) ─────────────────────────────
      if (req.method === 'POST') {
        const { token, prefix, id, createdAt } = await mintSharedTokenForUser(ctx.userId);
        const sharedUrl = `${SHARED_MCP_BASE}/api/mcp/shared/${token}`;
        return {
          generated:  true,
          sharedUrl,          // raw URL — shown ONCE, then never again
          prefix,
          id,
          createdAt,
        };
      }

      // ── DELETE — revoke ────────────────────────────────────────────────────
      if (req.method === 'DELETE') {
        await revokeSharedTokenForUser(ctx.userId);
        return { revoked: true };
      }
    },
  });
}
