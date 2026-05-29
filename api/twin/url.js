// POST /api/twin/url — add a web page into the twin.
//
// This is ingestion, not a transient fetch. The page is fetched server-side
// (with SSRF protection + size caps inside addFromUrl), the readable text is
// analysed, and the worthwhile pieces are stored as knowledge — chunked,
// tagged, and given URL provenance, exactly like anything else in the library.
//
// Body:     { url: string, notes?: string }
// Response: { stored, url, summary, items_extracted, items, source_id, ack }
//           or { stored: false, url, reason, summary, ack } when nothing
//           worth storing was found.
//
// Multi-tenant safe: runTwin resolves the tenant and addFromUrl writes
// tenant_id + user_id on every row.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { addFromUrl } from '../../tools/storage.js';
import { generateAck } from '../../lib/ack.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { url, notes } = req.body || {};
  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'url is required' });
  }

  return runTwin(req, res, {
    toolName: 'add_from_url',
    cap:      'storage',
    fn: async (ctx) => {
      const result = await addFromUrl(ctx, { url: url.trim(), notes });

      if (!result.stored) {
        const reason = result.reason ? `${result.reason}.` : 'Nothing clear enough to store came through.';
        return { ...result, ack: `Read that page but did not store anything. ${reason}` };
      }

      const ack = await generateAck({
        type:           'document',
        title:          result.summary || result.url,
        extractedItems: result.items_extracted || 1,
        quality:        'typical',
      });

      return { ...result, ack };
    },
  });
}
