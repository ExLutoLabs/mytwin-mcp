// POST/GET/DELETE /mcp  (canonical, OAuth-authenticated MCP endpoint)
//
// This is the URL listed in the Anthropic Connectors Directory and in the
// MCP Registry: https://myaitwin.lutolearn.com/mcp. Authenticated via the
// OAuth 2.0 access token returned by /api/oauth/token, presented as
// Authorization: Bearer <token>.
//
// Anthropic spec requirements implemented here:
//   * 401 on unauthenticated requests with
//       WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"
//     Claude reads the resource_metadata URL to discover the auth server.
//   * Token MUST come from the Authorization header, never from a URL query
//     parameter — per the MCP spec.
//
// The legacy URL-paste endpoint at /api/mcp/[token] is left completely
// untouched; it continues to work for existing users.

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../lib/create-server.js';
import { verifyMcpToken } from '../lib/auth.js';
import { checkRateLimit, RATE_LIMITS } from '../lib/rate-limit.js';

function appUrl() {
  return (process.env.APP_URL || 'https://myaitwin.lutolearn.com').replace(/\/+$/, '');
}

function unauthorized(res, errorCode, errorDescription) {
  // WWW-Authenticate header per RFC 6750 Section 3, with Anthropic's required
  // resource_metadata pointer per their auth spec.
  const resourceMetadata = `${appUrl()}/.well-known/oauth-protected-resource`;
  const parts = [`Bearer resource_metadata="${resourceMetadata}"`];
  if (errorCode) parts.push(`error="${errorCode}"`);
  if (errorDescription) parts.push(`error_description="${errorDescription.replace(/"/g, '\\"')}"`);
  res.setHeader('WWW-Authenticate', parts.join(', '));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(401).json({
    error: errorCode || 'invalid_token',
    error_description: errorDescription || 'Authentication required. See WWW-Authenticate header for discovery.',
  });
}

function extractBearer(req) {
  const raw = req.headers && req.headers.authorization;
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  return token || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const token = extractBearer(req);
  if (!token) {
    return unauthorized(res, 'invalid_token', 'Missing or malformed Authorization header.');
  }

  const ctx = await verifyMcpToken(token);
  if (!ctx) {
    return unauthorized(res, 'invalid_token', 'Token is invalid, expired, or revoked.');
  }

  // Per-tenant rate limit — same bucket as the legacy URL path.
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
