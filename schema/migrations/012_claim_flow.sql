-- 012_claim_flow.sql
-- Supports the anonymous-session claim flow used by POST /api/auth/claim
-- and GET /api/auth/verify?token=...
--
-- When an anonymous user on /twin wants to save their twin, they enter their
-- email in the claim modal.  The claim endpoint creates a magic_token with
-- claim_tenant_id pointing at their anonymous tenant.  The verify endpoint
-- reads claim_tenant_id and either:
--   a) New email   — upgrades the placeholder user + marks tenant real.
--   b) Known email — merges anon knowledge into the existing user's tenant.
--
-- Schema change: one nullable FK column on magic_tokens.
-- Safe to re-run (IF NOT EXISTS guard).

begin;

alter table magic_tokens
  add column if not exists claim_tenant_id uuid
    references tenants(id) on delete set null;

-- Index for admin / retention jobs to find orphaned claim tokens.
create index if not exists magic_tokens_claim_tenant_idx
  on magic_tokens(claim_tenant_id)
  where claim_tenant_id is not null;

commit;
