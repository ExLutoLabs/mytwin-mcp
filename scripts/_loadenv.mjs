// Lenient .env.local preloader for local test harnesses (May 2026 audit).
// node's built-in --env-file silently drops the first KEY=VALUE pair in this
// repo's .env.local (the one right after the "# Created by Vercel CLI" comment),
// which happens to be ANTHROPIC_API_KEY. This preloader parses the file itself
// and never echoes any value. Use with:  node --import ./scripts/_loadenv.mjs <script>
import fs from 'node:fs';

const path = new URL('../.env.local', import.meta.url);
let txt = '';
try { txt = fs.readFileSync(path, 'utf8'); } catch { /* no env file — leave process.env as is */ }

for (const raw of txt.split(/\r?\n/)) {
  const line = raw.replace(/^﻿/, '');
  if (!line.trim() || line.trim().startsWith('#')) continue;
  const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/);
  if (!m) continue;
  let v = m[2];
  const q = v[0];
  if ((q === '"' || q === "'") && v[v.length - 1] === q) v = v.slice(1, -1);
  // File wins when the inherited shell value is missing OR empty. The shell in
  // this environment exports ANTHROPIC_API_KEY="" (empty), which would otherwise
  // shadow the real key from .env.local.
  const cur = process.env[m[1]];
  if (cur === undefined || cur === '') process.env[m[1]] = v;
}
