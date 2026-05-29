// POST /api/twin/skill-proposal-action
//
// Accept or dismiss a pending skill proposal shown in the "In the Background" panel.
//
// Body:
//   { id: string, action: 'accept' | 'dismiss' }
//
// On accept: stores the skill as a knowledge item and marks the proposal accepted.
// On dismiss: marks the proposal dismissed. Either way the line is removed from the panel.

import { methodGuard, runTwin, HttpError } from '../../lib/twin-api.js';
import { getDB }                            from '../../lib/supabase.js';
import { addKnowledge }                     from '../../tools/storage.js';
import { checkAndIncrementCap, capExceededBody } from '../../lib/caps.js';
import { generateAck }                      from '../../lib/ack.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { id, action } = req.body || {};
  if (!id || !['accept', 'dismiss'].includes(action)) {
    return res.status(400).json({ error: 'id and action (accept|dismiss) are required' });
  }

  return runTwin(req, res, {
    toolName: 'skill_proposal_action',
    fn: async (ctx) => {
      const db = getDB();

      // Load the proposal, verifying tenant + user ownership
      const { data: proposal, error: fetchErr } = await db
        .from('skill_proposals')
        .select('id, title, description, status')
        .eq('id', id)
        .eq('tenant_id', ctx.tenantId)
        .eq('user_id', ctx.userId)
        .single();

      if (fetchErr || !proposal) {
        throw new HttpError(404, { error: 'proposal not found' });
      }
      // Idempotent — already handled
      if (proposal.status !== 'pending') {
        return { ok: true, status: proposal.status };
      }

      if (action === 'dismiss') {
        await db.from('skill_proposals').update({ status: 'dismissed' }).eq('id', id);
        return { ok: true, status: 'dismissed' };
      }

      // accept — cap check, then store the skill, then mark accepted
      const cap = await checkAndIncrementCap({
        tenantId:    ctx.tenantId,
        userId:      ctx.userId,
        kind:        'storage',
        isAnonymous: ctx.isAnonymous,
      });
      if (!cap.allowed) {
        throw new HttpError(429, capExceededBody({ kind: 'storage', cap: cap.cap }));
      }

      const stored = await addKnowledge(ctx, {
        type:                  'skill',
        content:               proposal.description,
        title:                 proposal.title,
        source_type:           'typed',
        manual_tags:           [],
        precomputed_auto_tags: [],
        provenance:            'personal',
        is_living_document:    false,
      });

      await db.from('skill_proposals').update({ status: 'accepted' }).eq('id', id);

      const ack = await generateAck({
        type:       'skill',
        title:      proposal.title,
        totalAfter: 1,
        quality:    'typical',
        stage:      'comfortable',
      });

      return { ok: true, status: 'accepted', item: stored, ack };
    },
  });
}
