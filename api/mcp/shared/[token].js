// POST /api/mcp/shared/[token] — read-only shared MCP endpoint.
//
// Anyone with a valid smt_... shared token gets access to the owner's
// SHARABLE items only. No writes, no personal context, no usage caps.
//
// The token is in the URL path — same pattern as the private /api/mcp/[token]
// endpoint. Suitable for Claude Desktop "Add custom connector".
//
// Rate limit: 50 calls/hour per token (keyed by token id, not tenant).

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createSharedServer } from '../../../lib/create-server.js';
import { verifySharedMcpToken } from '../../../lib/auth.js';
import { checkRateLimit, RATE_LIMITS } from '../../../lib/rate-limit.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const token = req.query.token;
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'Missing shared token in URL.' });
  }

  // Verify — generic 401 regardless of failure reason (no enumeration)
  const ctx = await verifySharedMcpToken(token);
  if (!ctx) {
    return res.status(401).json({ error: 'Invalid or revoked shared token.' });
  }

  // Rate limit keyed on the token id (50/hour) — not the tenant, so
  // a busy shared consumer can't crowd out the owner's private MCP calls.
  const rl = await checkRateLimit(`shared_mcp:${ctx.tokenId}`, RATE_LIMITS.SHARED_MCP_PER_HOUR);
  if (rl.exceeded) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    const mins = Math.ceil(rl.retryAfterSeconds / 60);
    return res.status(429).json({
      error: `Rate limit reached (${RATE_LIMITS.SHARED_MCP_PER_HOUR} calls/hour). Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
    });
  }

  // Inject visibilityFilter — the DAL checks this and restricts all queries
  // to items where visibility = 'sharable'.
  ctx.visibilityFilter = 'sharable';

  try {
    const server    = createSharedServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[shared-mcp] handler error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}
