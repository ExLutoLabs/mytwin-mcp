// GET /api/profile?workspace_id={uuid}
//
// Profile chrome: identity card, twin stats, and Settings read-state. The page
// loads this first (fast) for the identity card + Settings, then loads the
// heavier /api/profile/hypergraph for the graph. Defaults to the requester's
// personal workspace.
//
// Settings MUTATIONS (generate / revoke shared MCP link, sign out, delete
// account) reuse the existing /api/account/* + /api/auth/* endpoints — this
// endpoint only returns the data needed to render them. Owner-only fields
// (shared_tokens) are omitted for non-owner viewers.

import { requireAuth } from '../../lib/auth.js';
import { getDB } from '../../lib/supabase.js';
import {
  getPersonalWorkspace,
  getWorkspaceById,
  resolveAccessibleItems,
  countConceptPages,
  getOwnerIdentity,
  isoDate,
} from '../../lib/profile.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const session = await requireAuth(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const db = getDB();

  try {
    const wsParam = req.query?.workspace_id;
    let workspace;
    if (wsParam) {
      workspace = await getWorkspaceById(db, wsParam);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    } else {
      workspace = await getPersonalWorkspace(db, session.userId);
      if (!workspace) return res.status(404).json({ error: 'No personal workspace' });
    }

    const { access, items } = await resolveAccessibleItems(db, {
      requesterId: session.userId,
      workspace,
    });
    if (access === 'none') return res.status(403).json({ error: 'Forbidden' });

    const isOwner = workspace.owner_id === session.userId;
    const owner = await getOwnerIdentity(db, workspace.owner_id);
    const conceptCount = await countConceptPages(db, { workspace, isOwner });

    // Owner-only Settings data: the requester's own active shared MCP tokens.
    let sharedTokens = [];
    if (isOwner) {
      const { data } = await db
        .from('shared_mcp_tokens')
        .select('id, token_prefix, created_at, last_used_at')
        .eq('user_id', session.userId)
        .eq('revoked', false)
        .order('created_at', { ascending: false });
      sharedTokens = (data || []).map(t => ({
        id:           t.id,
        prefix:       t.token_prefix,
        created_at:   t.created_at,
        last_used_at: t.last_used_at,
      }));
    }

    return res.status(200).json({
      workspace_id:    workspace.id,
      workspace_type:  workspace.type,
      viewer_is_owner: isOwner,
      access,
      owner: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
      member_since: isoDate(owner?.created_at),
      stats: { items: items.length, concept_pages: conceptCount },
      // Settings (owner-only). Empty array for non-owner viewers.
      shared_tokens: sharedTokens,
    });
  } catch (err) {
    console.error('[profile] error:', err?.message);
    return res.status(500).json({ error: 'Could not load profile. Try again.' });
  }
}
