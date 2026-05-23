// POST /api/mcp/[token] — stateless MCP over StreamableHTTP, token-in-URL auth.
//
// Claude Desktop's "Add custom connector" dialog only accepts a URL (and OAuth
// fields). Custom request headers are not configurable. So the user's token
// lives in the URL path: one URL, fully self-contained, paste-and-go.
//
// Trade-off vs Bearer-in-header: URLs can surface in server logs and browser
// history. We mitigate by hashing the token at rest, supporting one-click
// regenerate (instant revoke of the old token), and bounding token entropy
// at 256 bits.
//
// Test account provisioned via POST /api/admin/mint-test-token

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../../lib/create-server.js';
import { verifyMcpToken } from '../../lib/auth.js';
import { checkRateLimit, RATE_LIMITS } from '../../lib/rate-limit.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // The token comes from the path: /api/mcp/<token>
  const token = req.query.token;
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'Missing token in URL. Get yours at https://myaitwin.lutolearn.com/create' });
  }

  // Resolve to { userId, tenantId }. Any failure → 401 (generic, no enumeration).
  const ctx = await verifyMcpToken(token);
  if (!ctx) {
    return res.status(401).json({ error: 'Invalid or revoked token. Generate a new URL at https://myaitwin.lutolearn.com/create' });
  }

  // Per-tenant rate limit (100 calls/hour). Fail-open on infra error so a
  // sick rate-limiter doesn't take down the API.
  const rl = await checkRateLimit(`mcp:${ctx.tenantId}`, RATE_LIMITS.MCP_PER_HOUR);
  if (rl.exceeded) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    const mins = Math.ceil(rl.retryAfterSeconds / 60);
    return res.status(429).json({
      error: `You have made too many requests in the last hour (limit: ${RATE_LIMITS.MCP_PER_HOUR}). Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
    });
  }

  try {
    const server    = createServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP handler error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}
