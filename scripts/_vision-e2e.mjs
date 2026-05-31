// Throwaway harness for the RC5/7A image-vision plumbing (May 2026 audit).
// Proves streamTwin accepts an image content block (base64) and the model
// responds — the new capability turn.js relies on for chat image attachments.
// Generates a real 32x32 PNG in-process (a 1x1 image is too small for the API).
// Run: node --import ./scripts/_loadenv.mjs scripts/_vision-e2e.mjs
// Delete after use.

import zlib from 'node:zlib';
import { streamTwin } from '../lib/anthropic.js';

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePngBase64(size = 32) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit depth, color type 2 (RGB)
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) { row[1 + x * 3] = 200; row[1 + x * 3 + 1] = 40; row[1 + x * 3 + 2] = 40; }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const checks = [];
const expect = (name, cond, details) => {
  checks.push({ name, pass: !!cond });
  console.log((cond ? 'PASS' : 'FAIL'), name, details ? JSON.stringify(details) : '');
};

try {
  const data = makePngBase64(32);
  let out = '';
  const final = await streamTwin({
    messages: [{
      role: 'user',
      content: [
        { type: 'text',  text: 'An image is attached. Name its dominant colour in one word.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      ],
    }],
    maxTokens: 50,
    effort: 'low',
    extraSystem: 'Reply tersely.',
    onText: t => { out += t; },
  });
  expect('vision_plumbing_returns_text', out.trim().length > 0, { out: out.slice(0, 120) });
  expect('vision_sees_red', /red|crimson|scarlet/i.test(out), { out: out.slice(0, 120) });
  expect('vision_finalMessage_ok', !!final, {});
} catch (err) {
  expect('vision_did_not_throw', false, { error: err?.message, stack: err?.stack?.split('\n').slice(0, 3).join(' | ') });
} finally {
  const failed = checks.filter(c => !c.pass);
  console.log(`\nRESULT pass=${failed.length === 0} total=${checks.length} failed=${failed.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
