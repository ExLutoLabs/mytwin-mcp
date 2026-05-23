-- 004-audit-log.sql
-- Session 2, step 6 — append-only audit log.
--
-- What we log:
--   * Every tool call (success/failure + tool name + tenant + user)
--   * Auth events (magic_link_requested/verified, token_minted/regenerated)
--   * Account deletion (start + completed) — without the deleted content
--
-- What we do NOT log:
--   * Full private content (knowledge bodies, transcripts, etc). We record
--     identifiers and outcomes, never the data itself.
--   * Tokens, passwords, emails-in-clear (auth events log a user_id once we
--     have one; magic_link_requested records the bucket key indirectly).
--
-- The audit table has NO foreign key on user_id — we want history to survive
-- the user being deleted (the deletion event itself references the now-dead
-- user_id and is the trail of evidence).

begin;

create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid,
  tenant_id   uuid,
  event_type  text not null,
  tool_name   text,
  item_id     uuid,
  success     boolean not null default true,
  error_type  text,
  error_msg   text,
  context     jsonb,
  created_at  timestamptz default now()
);

create index if not exists audit_log_tenant_created_idx on audit_log(tenant_id, created_at desc);
create index if not exists audit_log_user_created_idx   on audit_log(user_id,   created_at desc);
create index if not exists audit_log_event_created_idx  on audit_log(event_type, created_at desc);

alter table audit_log enable row level security;

notify pgrst, 'reload schema';

commit;
