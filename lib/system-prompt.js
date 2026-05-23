// Default system prompt — the intelligence/voice layer the twin ships with.
//
// Loaded from the MYAITWIN_SYSTEM_PROMPT environment variable so the prompt
// content can live outside this repo (the repo is public; the prompt is
// proprietary IP). For local dev: set MYAITWIN_SYSTEM_PROMPT in .env.local
// with the markdown content. For production: set it via the Vercel UI.

if (!process.env.MYAITWIN_SYSTEM_PROMPT) {
  throw new Error(
    'MYAITWIN_SYSTEM_PROMPT env var is required. Set it on Vercel (Production + Preview + Development) with the markdown content.'
  );
}

export const SYSTEM_PROMPT = process.env.MYAITWIN_SYSTEM_PROMPT;
