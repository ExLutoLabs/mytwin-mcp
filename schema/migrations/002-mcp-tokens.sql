-- 002-mcp-tokens.sql
-- Session 2, step 4 — bearer-token auth for the MCP endpoint.
--
-- Design:
--   * One active token per user (enforced by partial unique index).
--   * Tokens are stored as SHA-256 hashes; raw value is only ever shown to
--     the user once (on first issue or after regenerate).
--   * `token_prefix` stores the first 8 chars of the raw token for UI display
--     (so the user can recognise their own token without seeing the secret).
--   * Revoked tokens are kept for audit history; the partial index lets us
--     issue a new active token while preserving the old row.
--
-- Safe to re-run.

begin;

create table if not exists mcp_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id)   on delete cascade,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  token_hash    text not null,
  token_prefix  text not null,
  created_at    timestamptz default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- Enforce one active token per user. Revoked rows are excluded so history
-- can accumulate without conflicting with the live token.
create unique index if not exists mcp_tokens_active_per_user_idx
  on mcp_tokens(user_id) where revoked_at is null;

-- Fast lookup at MCP request time: hash → row, only matching active tokens.
create index if not exists mcp_tokens_hash_active_idx
  on mcp_tokens(token_hash) where revoked_at is null;

-- Defence in depth (service role bypasses RLS but the policy is here for
-- when/if we ever expose this to anon).
alter table mcp_tokens enable row level security;

-- Tell PostgREST about the new table.
notify pgrst, 'reload schema';

commit;
