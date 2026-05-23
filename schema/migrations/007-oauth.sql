-- 007-oauth.sql
-- Section 8 — OAuth 2.0 authorization code flow.
--
-- Design:
--   1. oauth_clients holds pre-registered (or dynamically-registered) clients,
--      identified by client_id and authenticated with sha256(client_secret).
--   2. oauth_auth_codes holds short-lived single-use authorization codes
--      created on /api/oauth/callback and consumed on /api/oauth/token.
--   3. magic_tokens gains optional OAuth context columns so the magic-link
--      click can hand back to the OAuth callback with the original state.
--   4. The Claude Desktop client is pre-registered inline; only the
--      sha256(client_secret) is stored at rest. The plaintext secret is
--      held by the client out-of-band and is not in this repo.

begin;

-- ── 1. oauth_clients ─────────────────────────────────────────────────────────
create table if not exists oauth_clients (
  id                 uuid primary key default gen_random_uuid(),
  client_id          text unique not null,
  client_secret_hash text not null,
  redirect_uris      text[] not null,
  name               text,
  created_at         timestamptz default now()
);

-- ── 2. oauth_auth_codes (short-lived, single-use) ────────────────────────────
create table if not exists oauth_auth_codes (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  user_id      uuid not null references users(id)   on delete cascade,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  client_id    text not null,
  redirect_uri text not null,
  state        text,
  scope        text,
  expires_at   timestamptz not null,
  used         boolean default false,
  created_at   timestamptz default now()
);

create index if not exists oauth_auth_codes_unused_idx
  on oauth_auth_codes(code) where used = false;

-- ── 3. OAuth context on magic_tokens ─────────────────────────────────────────
-- These columns let the magic-link click flow recover the OAuth state on
-- /api/oauth/callback. Null for normal (non-OAuth) magic links.
alter table magic_tokens add column if not exists oauth_client_id    text;
alter table magic_tokens add column if not exists oauth_redirect_uri text;
alter table magic_tokens add column if not exists oauth_state        text;
alter table magic_tokens add column if not exists oauth_scope        text;

-- ── 4. RLS posture (service_role bypasses; we still enable defence-in-depth) ─
alter table oauth_clients    enable row level security;
alter table oauth_auth_codes enable row level security;

-- ── 5. Pre-register Claude Desktop as a client ───────────────────────────────
-- client_secret plaintext is supplied to Anthropic out-of-band; only the
-- sha256 hash is stored at rest.
insert into oauth_clients (client_id, client_secret_hash, redirect_uris, name)
values (
  'claude-desktop',
  '96be233d78620996fde81b465adc20bfb1f1b531d92ef77e52456989b335f140',
  ARRAY['https://claude.ai/oauth/callback', 'claude://oauth/callback'],
  'Claude Desktop'
)
on conflict (client_id) do update set
  client_secret_hash = excluded.client_secret_hash,
  redirect_uris      = excluded.redirect_uris,
  name               = excluded.name;

notify pgrst, 'reload schema';

commit;
