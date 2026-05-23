-- 008-oauth-pkce-refresh.sql
-- Brings the OAuth implementation in line with Anthropic's connector auth spec.
--
-- Adds:
--   1. PKCE columns on oauth_auth_codes (S256 required by the spec).
--   2. PKCE columns on magic_tokens (so the challenge survives the magic-link
--      round-trip between /authorize and /callback).
--   3. token_endpoint_auth_method on oauth_clients — Claude DCR-registers as a
--      public client (no secret) and authenticates the token call with PKCE
--      instead. Default keeps existing clients on client_secret_post.
--   4. expires_at on mcp_tokens — legacy URL tokens stay non-expiring (null);
--      OAuth-issued tokens get an explicit 24h expiry.
--   5. client_id on mcp_tokens — lets multiple OAuth clients (Claude hosted +
--      Claude Code + …) hold their own active token per user without fighting.
--   6. oauth_refresh_tokens table — proper rotating refresh tokens, separate
--      from access tokens, per the spec's "Rotate refresh tokens for public-
--      client connections" requirement.
--   7. Relaxes mcp_tokens_active_per_user_idx so the uniqueness is scoped
--      (user_id, client_id) for OAuth tokens — but legacy (client_id IS NULL)
--      tokens still enforce one-active-per-user.
--   8. Updates the seeded claude-desktop client row with the canonical
--      Anthropic callback URL + loopback callbacks for Claude Code, and flips
--      it to public-client auth.
--
-- Safe to re-run.

begin;

-- 1. PKCE on authorization codes
alter table oauth_auth_codes
  add column if not exists code_challenge        text,
  add column if not exists code_challenge_method text;

-- 2. PKCE round-trip on magic_tokens
alter table magic_tokens
  add column if not exists oauth_code_challenge        text,
  add column if not exists oauth_code_challenge_method text;

-- 3. Client auth method (public clients use 'none' + PKCE)
alter table oauth_clients
  add column if not exists token_endpoint_auth_method text not null default 'client_secret_post';

-- 4 + 5. Access-token expiry and per-client scoping
alter table mcp_tokens
  add column if not exists expires_at timestamptz,
  add column if not exists client_id  text;

-- 6. Refresh tokens — sha256 hashes at rest, rotation chain via rotated_to
create table if not exists oauth_refresh_tokens (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text unique not null,
  user_id       uuid not null references users(id)   on delete cascade,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  client_id     text not null,
  scope         text,
  expires_at    timestamptz,
  rotated_to    uuid references oauth_refresh_tokens(id),
  revoked_at    timestamptz,
  created_at    timestamptz default now()
);

create index if not exists oauth_refresh_tokens_active_idx
  on oauth_refresh_tokens(token_hash) where revoked_at is null and rotated_to is null;

alter table oauth_refresh_tokens enable row level security;

-- 7. Relax mcp_tokens uniqueness:
--    - Legacy (URL-paste) tokens have client_id NULL — keep one-active-per-user.
--    - OAuth tokens carry client_id — allow one active per (user_id, client_id).
drop index if exists mcp_tokens_active_per_user_idx;

create unique index if not exists mcp_tokens_legacy_active_idx
  on mcp_tokens(user_id)
  where revoked_at is null and client_id is null;

create unique index if not exists mcp_tokens_oauth_active_idx
  on mcp_tokens(user_id, client_id)
  where revoked_at is null and client_id is not null;

-- 8. Update the seeded claude-desktop client.
--    - Canonical hosted callback per docs: https://claude.ai/api/mcp/auth_callback
--    - Loopback callbacks for Claude Code (matcher is port-agnostic in lib/oauth.js)
--    - Public-client auth method (token endpoint accepts the call without a secret;
--      PKCE binds the exchange).
update oauth_clients
   set redirect_uris = ARRAY[
         'https://claude.ai/api/mcp/auth_callback',
         'https://claude.ai/oauth/callback',
         'claude://oauth/callback',
         'http://localhost/callback',
         'http://127.0.0.1/callback'
       ],
       token_endpoint_auth_method = 'none',
       name = 'Claude'
 where client_id = 'claude-desktop';

notify pgrst, 'reload schema';

commit;
