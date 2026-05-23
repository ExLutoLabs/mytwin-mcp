// GET /.well-known/oauth-protected-resource  (RFC 9728)
//
// Tells OAuth clients (Claude) where the MCP server's authorization server lives
// and how to obtain tokens for this resource. Pointed to from the
// WWW-Authenticate header on the 401 emitted by /mcp.
//
// Anthropic spec requirements:
//   * `resource` MUST equal the MCP server URL exactly, including path
//   * `authorization_servers` MUST list our AS issuer URL (first entry is used)
//
// Vercel doesn't serve files from dot-directories, so this is at
// /api/well-known/oauth-protected-resource and exposed at the canonical
// /.well-known/oauth-protected-resource via a rewrite in vercel.json.

export const config = { maxDuration: 5 };

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const APP_URL = (process.env.APP_URL || 'https://myaitwin.lutolearn.com').replace(/\/+$/, '');

  const body = {
    resource:                 `${APP_URL}/mcp`,
    authorization_servers:    [APP_URL],
    scopes_supported:         ['mcp', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_documentation:   `${APP_URL}/docs`,
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).send(JSON.stringify(body));
}
