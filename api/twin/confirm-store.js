// POST /api/twin/confirm-store
//
// Commits a proposal that the user has reviewed and confirmed. The /turn
// endpoint produced the proposal; the frontend rendered it as a card with
// action buttons; this endpoint runs only when the user explicitly says
// "yes, store it" (or "store as <alt-type>" / "store with these edits").
//
// Body shape:
//   {
//     title:       string,
//     type:        string,                          // user-chosen, defaults to proposal.type
//     content:     string,                          // exact user text
//     tags:        string[],
//     provenance?: 'personal'|'employer'|'client'|'external' ('organisational' legacy)
//   }
//
// Why a separate endpoint:
// The propose-clarify-confirm-store flow exists because silent storage
// destroys trust. By the time we hit /confirm-store, the user has actively
// agreed to the structured record. The storage cap is incremented HERE,
// not on /turn — proposals don't count against the cap.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { checkAndIncrementCap, capExceededBody } from '../../lib/caps.js';
import { addKnowledge } from '../../tools/storage.js';
import { listRecent } from '../../tools/management.js';
import { UserError } from '../../lib/errors.js';
import { HttpError } from '../../lib/twin-api.js';
import { generateAck } from '../../lib/ack.js';
import { runDriftCheck } from '../../lib/background-log.js';

// The full set of types the proposal card can offer (spec §3.2). The classifier
// now proposes a rich type and the user can correct it; an unknown or invalid
// value (e.g. a stray custom type not in this set) coerces to knowledge.
const VALID_TYPES = new Set([
  'knowledge', 'skill', 'idea', 'principle', 'voice',
  'brand', 'template', 'resource', 'meta-principle', 'reference-record',
]);

// Quality judgement — spec §3.4. Look at the content and tags and decide
// whether this is a strong record, a thin one, or somewhere in between.
// The ack then matches: strong gets honest recognition, thin gets a kind
// nudge with a path forward.
function judgeQuality({ content, tags, title }) {
  const text = String(content || '').trim();
  const sentenceCount = (text.match(/[.!?](?:\s|$)/g) || []).length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const realTags = (Array.isArray(tags) ? tags : []).filter(t => t && t !== 'untagged');
  const hasTitle = Boolean(title && title.trim().length >= 4);

  // Thin: very short, single sentence, or no meaningful tags
  if (wordCount < 15 || (sentenceCount <= 1 && wordCount < 30) || realTags.length === 0) {
    return 'thin';
  }
  // Strong: substantive length, multiple sentences, good tag coverage, has title
  if (wordCount >= 35 && sentenceCount >= 2 && realTags.length >= 3 && hasTitle) {
    return 'strong';
  }
  return 'typical';
}

function buildAcknowledgement({ type, title, totalAfter, quality }) {
  const t = String(type || 'item').toLowerCase();
  const topic = title ? ` "${title}"` : '';
  const first = totalAfter === 1;

  // Strong content — honest recognition. Spec §3.4.
  if (quality === 'strong') {
    if (first) {
      return `In. That's a strong ${t}${topic}. First one in your twin, and it'll come back well.`;
    }
    if (totalAfter >= 3) {
      return `Got it. ${capitalize(t)} ${totalAfter}, and this one is solid. Your thinking on this is building.`;
    }
    return `Filed${topic}. That ${t} will come back well.`;
  }

  // Thin content — kindly flag with a path forward. Spec §3.4.
  if (quality === 'thin') {
    return `In. Stored as ${article(t)} ${t}, but it's thin. Stronger with a sentence or two of context. Want to add some when you're back?`;
  }

  // Typical — warm, contextual, no hedging.
  if (first) {
    return `In. Stored as ${article(t)} ${t}${topic}. First one in your twin.`;
  }
  if (totalAfter >= 3) {
    return `Got it. ${capitalize(t)} ${totalAfter}. Your thinking on this is starting to build.`;
  }
  return `Filed${topic} as ${article(t)} ${t}. You'll find it in your library.`;
}

function article(noun) {
  return /^[aeiou]/i.test(noun) ? 'an' : 'a';
}
function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { title, type, content, tags, provenance, is_living_document, source_type: rawSourceType } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }
  const finalType = typeof type === 'string' && VALID_TYPES.has(type.toLowerCase())
    ? type.toLowerCase()
    : 'knowledge';
  const finalTags = Array.isArray(tags)
    ? tags.map(t => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 8)
    : [];
  const finalProvenance = ['personal', 'organisational', 'employer', 'client', 'external'].includes(provenance)
    ? provenance
    : 'personal';
  const finalIsLiving = is_living_document === true;

  return runTwin(req, res, {
    toolName: 'confirm_store',
    fn: async (ctx) => {
      // Cap is checked here, on the deliberate-store step. Proposals don't
      // count against the storage cap.
      const cap = await checkAndIncrementCap({
        tenantId:    ctx.tenantId,
        userId:      ctx.userId,
        kind:        'storage',
        isAnonymous: ctx.isAnonymous,
      });
      if (!cap.allowed) {
        throw new HttpError(429, capExceededBody({ kind: 'storage', cap: cap.cap }));
      }

      try {
        // Pass manual_tags + precomputed_auto_tags=[] so the existing
        // auto-tagger is bypassed entirely. The tags we send are the ones
        // the user just confirmed — no more "tag = 'twin' because they
        // said 'Hey twin'" lazy auto-tagging.
        const stored = await addKnowledge(ctx, {
          type:                  finalType,
          content,
          title:                 title || null,
          source_type:           rawSourceType === 'voice-capture' ? 'voice-capture' : 'typed',
          manual_tags:           finalTags,
          precomputed_auto_tags: [],
          provenance:            finalProvenance,
          is_living_document:    finalIsLiving,
        });

        // Count how many of this type the user has now (for the ack copy).
        let totalAfter = 1;
        try {
          const recent = await listRecent(ctx, { limit: 20, type: finalType });
          totalAfter = (recent.items || []).length;
        } catch { /* non-fatal; ack just won't have count */ }

        const quality = judgeQuality({ content, tags: finalTags, title });
        // Generate an in-voice ack via Sonnet, per spec §3.2 and the
        // "Chat behave like a chat" brief. Never a templated string.
        const ack = await generateAck({
          type: finalType,
          title,
          totalAfter,
          quality,
          stage: 'comfortable',  // could pass through from /turn if needed
        });

        // Concept compilation is now handled by the Inngest 'compile-concepts' job,
        // which fires via Supabase webhook → /api/webhooks/knowledge-inserted → Inngest.
        // No setTimeout needed here.

        // Drift detection still runs in-process (not yet an Inngest job).
        setTimeout(() => {
          runDriftCheck(ctx.tenantId)
            .catch(err => console.error('[confirm-store] drift check failed:', err.message));
        }, 200);

        return {
          kind: 'stored',
          item: stored,
          ack,
          quality,
        };
      } catch (err) {
        if (err instanceof UserError) throw err;
        throw err;
      }
    },
  });
}
