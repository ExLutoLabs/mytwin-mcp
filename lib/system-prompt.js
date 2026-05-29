// Default system prompt — the intelligence/voice layer the twin ships with.
//
// Loaded from the MYAITWIN_SYSTEM_PROMPT environment variable so the prompt
// content can live outside this repo (the repo is public; the prompt is
// proprietary IP). For production: set it via the Vercel UI.
//
// Local-dev fallback: if the env var is unset and `.system-prompt.local.md`
// exists in the repo root, load from there. The prompt contains 50+
// unescaped double quotes and 260+ newlines, which Vercel CLI's .env.local
// parser cannot represent cleanly — putting it in a sibling file is the
// pragmatic workaround for `vercel dev`.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function loadLocalPrompt() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const p = resolve(here, '..', '.system-prompt.local.md');
    if (existsSync(p)) return readFileSync(p, 'utf8');
  } catch {}
  return null;
}

const fromEnv = process.env.MYAITWIN_SYSTEM_PROMPT;
const fromFile = fromEnv ? null : loadLocalPrompt();

if (!fromEnv && !fromFile) {
  throw new Error(
    'MYAITWIN_SYSTEM_PROMPT env var is required (or place the prompt in .system-prompt.local.md for local dev).'
  );
}

export const SYSTEM_PROMPT = fromEnv || fromFile;
