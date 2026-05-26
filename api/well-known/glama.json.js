// GET /.well-known/glama.json
//
// Glama.ai's connector-claim discovery endpoint. The maintainer email here
// is matched against the email on a Glama account; when both line up,
// Glama marks the connector as claimed by that account. From that point on
// the maintainer can email support@glama.ai with test credentials so the
// scanner can authenticate, which moves the listing from Unhealthy to
// Healthy.
//
// Schema: https://glama.ai/mcp/schemas/connector.json
//
// Must be publicly reachable — no auth, no redirects, no auth-gated path.
// Same pattern as the existing OAuth well-known endpoints; Vercel serves
// this file from /api/well-known/glama.json and vercel.json rewrites the
// canonical /.well-known/glama.json path onto it.

export const config = { maxDuration: 5 };

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = {
    $schema:     'https://glama.ai/mcp/schemas/connector.json',
    maintainers: [{ email: 'team@lutolearn.com' }],
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).send(JSON.stringify(body));
}
