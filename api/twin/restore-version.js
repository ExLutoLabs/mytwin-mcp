// POST /api/twin/restore-version
//
// Restores a previously saved version of a knowledge item. Restoration works
// by calling the standard update flow with the old content — so the current
// state is snapshotted to history first, then the old content is written as a
// new version. History is never rewritten: v1 → v2 → v3 → restore to v1
// creates v4 (content identical to v1). The full chain is always preserved.
//
// Body: { item_id: string, version_number: number }
// Response: { restored: true, new_version_number: number }

import { methodGuard, runTwin, HttpError } from '../../lib/twin-api.js';
import { getDB }                            from '../../lib/supabase.js';
import { updateKnowledge }                  from '../../tools/management.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { item_id, version_number } = req.body || {};
  if (!item_id || typeof item_id !== 'string') {
    return res.status(400).json({ error: 'item_id is required' });
  }
  const vNum = Number(version_number);
  if (!Number.isInteger(vNum) || vNum < 1) {
    return res.status(400).json({ error: 'version_number must be a positive integer' });
  }

  return runTwin(req, res, {
    toolName: 'restore_version',
    fn: async (ctx) => {
      const db = getDB();

      // Fetch the requested historical version
      const { data: version, error: vErr } = await db
        .from('knowledge_versions')
        .select('title, content, version_number')
        .eq('knowledge_id', item_id)
        .eq('tenant_id',    ctx.tenantId)
        .eq('version_number', vNum)
        .maybeSingle();

      if (vErr) throw new Error(vErr.message);
      if (!version) throw new HttpError(404, { error: `Version ${vNum} not found for item ${item_id}` });

      // Restore = update with old content. updateKnowledge will:
      //   1. Snapshot the CURRENT state to knowledge_versions
      //   2. Write the restored content as the new current state
      //   3. Increment version_number (so restoring v1 from v3 creates v4)
      const result = await updateKnowledge(ctx, {
        id:      item_id,
        title:   version.title,
        content: version.content,
      });

      return {
        restored:           true,
        new_version_number: result.version_number,
        restored_from:      vNum,
      };
    },
  });
}
