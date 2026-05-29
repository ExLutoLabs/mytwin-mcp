-- 014_visibility.sql
-- Adds per-item visibility (private / sharable) and shared MCP tokens.
--
-- Every knowledge item and concept page is private by default. The owner
-- can opt individual items into the 'sharable' pool. A read-only MCP
-- endpoint exposed via shared_mcp_tokens reveals only sharable items to
-- whoever holds the shared URL.

begin;

-- ── knowledge visibility ──────────────────────────────────────────────────────

alter table knowledge
  add column if not exists visibility text not null default 'private'
    check (visibility in ('private', 'sharable'));

-- ── concept_pages visibility ──────────────────────────────────────────────────
-- Derived on every concept compile: 'sharable' only when ALL source items are.

alter table concept_pages
  add column if not exists visibility text not null default 'private'
    check (visibility in ('private', 'sharable'));

-- ── shared_mcp_tokens ─────────────────────────────────────────────────────────
-- One active token per user (enforced by unique index below on !revoked rows).
-- Token format: 'smt_' + 64 lowercase hex chars (raw). We store SHA-256 hash only.

create table if not exists shared_mcp_tokens (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null,
  tenant_id     uuid        not null,
  token_hash    text        not null unique,
  token_prefix  text        not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked       boolean     not null default false
);

-- Fast lookup by hash on active tokens
create index if not exists shared_mcp_tokens_hash_idx
  on shared_mcp_tokens (token_hash) where not revoked;

-- Fast lookup by user for status checks
create index if not exists shared_mcp_tokens_user_idx
  on shared_mcp_tokens (user_id) where not revoked;

-- Fast lookup by tenant for rate limiting
create index if not exists shared_mcp_tokens_tenant_idx
  on shared_mcp_tokens (tenant_id) where not revoked;

commit;
