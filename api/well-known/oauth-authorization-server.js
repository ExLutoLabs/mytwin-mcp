// GET /.well-known/oauth-authorization-server  (RFC 8414)
//
// OAuth Authorization Server Metadata for the MyAITwin connector. Claude
// reads this to discover endpoints, supported grant types, PKCE methods,
// and auth methods. Required by the MCP authorization spec.
//
// Anthropic spec requirements:
//   * `code_challenge_methods_supported` MUST advertise ["S256"]
//   * `offline_access` in `scopes_supported` is what Claude uses to request
//     a refresh token at /token
//   * `token_endpoint_auth_methods_supported` must include "none" because
//     DCR-registered Claude clients are public and authenticate via PKCE
//
// Vercel serves this from /api/well-known/oauth-authorization-server and
// vercel.json rewrites the canonical /.well-known/... path onto it.

export const config = { maxDuration: 5 };

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const APP_URL = (process.env.APP_URL || 'https://myaitwin.lutolearn.com').replace(/\/+$/, '');

  const body = {
    issuer:                                 APP_URL,
    authorization_endpoint:                 `${APP_URL}/api/oauth/authorize`,
    token_endpoint:                         `${APP_URL}/api/oauth/token`,
    registration_endpoint:                  `${APP_URL}/api/oauth/register`,
    response_types_supported:               ['code'],
    grant_types_supported:                  ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported:       ['S256'],
    token_endpoint_auth_methods_supported:  ['client_secret_post', 'none'],
    scopes_supported:                       ['mcp', 'offline_access'],
    service_documentation:                  `${APP_URL}/docs`,
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).send(JSON.stringify(body));
}
