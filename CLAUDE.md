# MyAITwin — guide for Claude / agents

## The canonical reference: read this first

**[`docs/twin-behaviour-spec.md`](docs/twin-behaviour-spec.md)** is the source of truth for how the twin should behave.

Before changing any user-facing behaviour, voice, retrieval, storage, or chat surface — read it end to end. If the implementation disagrees with the spec, the spec wins. Fix the implementation, not the spec.

Quick map:
- **§1–2** — what the twin is, what it stores (knowledge / skills / meta-principles)
- **§3** — storage behaviour (intent classification + propose-clarify-confirm-store)
- **§4** — retrieval behaviour (inline provenance citations, temporal awareness, anti-AI-soup, dual retrieval for creation)
- **§5** — conversational behaviour (voice, energy reciprocation, forbidden phrases)
- **§6** — skill gap detection + meta-principle surfacing
- **§7–9** — workflow prompts, spells, progressive user stages
- **§12.4** — 12 acceptance criteria a conforming v1 implementation must pass

## Architecture in one paragraph

Vanilla Vercel-serverless project. `/api/*.js` are functions, `/lib/*.js` are shared helpers, `/tools/*.js` are the MCP tool implementations (also called directly from web endpoints), `/schema/migrations/*.sql` is the DB layout, `/public/*.html` is the static frontend. The `/twin` page is the v1 web mini-interface that anonymous users land on at `myaitwin.lutolearn.com/twin`. Anonymous tenants are real tenants with a placeholder users row and a signed JWT (`mt_anon_token` in localStorage). Migrations are applied via `node scripts/run-migration.mjs <file>` against the Supabase Management API (needs `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF`) or via the SQL editor in the dashboard.

## Local dev quickstart

```bash
cd /Users/piotrkurzepa/mytwin
npm install
# .env.local must be populated — Vercel CLI's vercel dev ignores it, so:
node --env-file=.env.local "$(which vercel)" dev --listen 3000
# open http://localhost:3000/twin
```

Required env vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`, `JWT_SECRET`, `APP_URL`. The system prompt is loaded from `.system-prompt.local.md` if present (since `vercel env pull` cannot return Sensitive env vars), otherwise from `MYAITWIN_SYSTEM_PROMPT`.

## Anti-patterns to avoid

- **Never silently store.** Storage is the propose-clarify-confirm-store flow (§3.2) — never a side-effect of a chat turn.
- **Never use em dashes in twin output.** It is the single most common Luto-voice failure mode.
- **Never use "Kept." / "Stored." / "Done."** Generate warm contextual acknowledgements.
- **Never tag with the user's literal opener words.** Tags come from semantic content (§3.7).
- **Never invent knowledge the user has not stored.** Honesty about gaps (§4.5).
- **Never use the banned phrase list in §5.4.** ("unlock", "master", "transformative", "leverage" as verb, etc.)
