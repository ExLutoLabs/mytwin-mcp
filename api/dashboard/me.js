// GET /api/dashboard/me — return session user + MCP URL + token info + stats.
//
// Token lifecycle: if the user has no active MCP token, one is minted on first
// call to this endpoint. The raw token value is returned exactly once at that
// moment — `token.value` is non-null on first issue, null on every subsequent
// call (we only stored the hash). For accidental leaks the user uses the
// regenerate endpoint, which mints a new one and returns its value once.

import { requireAuth, getActiveMcpTokenInfo, mintMcpTokenForUser } from '../../lib/auth.js';
import { getDB } from '../../lib/supabase.js';
import { logAudit } from '../../lib/audit.js';
import { getUserOutboundInvite } from '../../lib/invites.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).end(); return; }

  const session = await requireAuth(req);
  if (!session) {
    return res.status(401).json({ error: 'Not signed in' });
  }

  const { userId, email } = session;
  const db = getDB();

  // Ensure the user has an active MCP token. Mint one if not.
  let tokenInfo  = await getActiveMcpTokenInfo(userId);
  let freshValue = null;
  if (!tokenInfo) {
    const minted = await mintMcpTokenForUser(userId);
    tokenInfo  = { prefix: minted.prefix, createdAt: minted.createdAt, lastUsedAt: null };
    freshValue = minted.token; // ONLY surfaced on first issue
    // Audit: token was just minted (first-issue path)
    logAudit({ userId, eventType: 'token_minted', success: true, context: { reason: 'first_issue' } });
  }

  const [
    { count: knowledgeCount },
    { count: typeCount },
    { data: recentItems },
  ] = await Promise.all([
    db.from('knowledge').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    db.from('schema_types').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    db.from('knowledge').select('type, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1),
  ]);

  const mcpUrlBase = `${process.env.APP_URL || 'https://myaitwin.lutolearn.com'}/api/mcp`;
  // Full URL is only constructible when we have the raw token value (just minted).
  // Subsequent calls return value: null and the client must show "regenerate to view".
  const fullMcpUrl = freshValue ? `${mcpUrlBase}/${freshValue}` : null;

  // User's outbound invite (the one minted to them on redemption). Null for
  // pre-existing users who didn't come through the invite flow.
  const outbound  = await getUserOutboundInvite(userId);
  const inviteUrlBase = `${process.env.APP_URL || 'https://myaitwin.lutolearn.com'}/invite`;
  const myInvite  = outbound ? {
    code:               outbound.code,
    invite_url:         `${inviteUrlBase}/${outbound.code}`,
    redeemed:           outbound.redeemed,
    redeemed_by_email:  outbound.redeemed_by_email,
    redeemed_at:        outbound.redeemed_at,
    visit_count:        outbound.visit_count,
  } : null;

  res.status(200).json({
    userId,
    email,
    mcpUrlBase,           // constant base — useful for docs / display
    mcpUrl: fullMcpUrl,   // null unless we just minted a token in this request
    token: {
      prefix:       tokenInfo.prefix,
      created_at:   tokenInfo.createdAt,
      last_used_at: tokenInfo.lastUsedAt,
      value:        freshValue, // null on subsequent calls
    },
    stats: {
      total_items: knowledgeCount || 0,
      total_types: typeCount || 0,
      last_added:  recentItems?.[0]?.created_at || null,
    },
    my_invite: myInvite,
  });
}
