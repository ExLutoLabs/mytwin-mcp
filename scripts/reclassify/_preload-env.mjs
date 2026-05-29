// Robust .env.local loader, run via `node --import`. Node's built-in --env-file
// drops at least one quoted key in this project's .env.local; this parser reads
// every KEY=VALUE line (stripping surrounding quotes) and fills any missing
// process.env entry. Runs before the main module graph, so it beats load-time
// env checks (e.g. lib/anthropic.js throwing on a missing ANTHROPIC_API_KEY).
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const path = resolve(process.cwd(), '.env.local');
if (existsSync(path)) {
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!raw || raw.trimStart().startsWith('#')) continue;
    const eq = raw.indexOf('=');
    if (eq < 1) continue;
    const key = raw.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = raw.slice(eq + 1);
    if (val.length >= 2 &&
        ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    // Fill if absent OR empty: the shell may export an empty ANTHROPIC_API_KEY,
    // which would otherwise mask the real value here. Never clobber a non-empty
    // shell value.
    if (!process.env[key]) process.env[key] = val;
  }
}
