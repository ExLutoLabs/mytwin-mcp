-- 009-anonymous-tenants.sql
-- Web mini-interface v1: anonymous tenants for the /twin landing page.
--
-- Adds:
--   1. Anonymous-tenant marker columns on `tenants`:
--        is_anonymous        — true for tenants created by /api/anon/init
--        anon_created_at     — timestamp for retention/cleanup policy
--        claimed_by_user_id  — links an anonymous tenant to the real user
--                              that claimed it on signup (future enhancement)
--   2. Per-tenant cap counters used only while is_anonymous = true:
--        chat_count          — POST /api/twin/chat invocations
--        storage_count       — combined add_knowledge + add_document + add_voice_note
--        synthesise_count    — POST /api/twin/synthesise invocations
--      Caps live in code (lib/caps.js); counters live here so increments
--      are atomic across concurrent requests.
--   3. Atomic increment RPC `increment_anon_cap(p_tenant_id, p_kind, p_cap)`:
--        - Increments the counter for the named kind
--        - Returns table(new_count integer, exceeded boolean)
--        - Same shape as increment_rate_limit so callers stay symmetric
--
-- Note: we deliberately do NOT touch users.tenant_id (still NOT NULL).
-- Anonymous tenants get a placeholder users row (email
-- 'anon+<tenant_id>@mytwin.local'), keeping every existing
-- tenant_id + user_id query path working unchanged.
--
-- Safe to re-run.

begin;

-- 1. Anonymous-tenant columns
alter table tenants
  add column if not exists is_anonymous       boolean     not null default false,
  add column if not exists anon_created_at    timestamptz,
  add column if not exists claimed_by_user_id uuid        references users(id) on delete set null;

-- Cleanup index: lets a future retention job scan
-- `where is_anonymous = true and claimed_by_user_id is null`
-- ordered by anon_created_at without a full table scan.
create index if not exists tenants_anon_unclaimed_idx
  on tenants(anon_created_at)
  where is_anonymous = true and claimed_by_user_id is null;

-- 2. Cap counters
alter table tenants
  add column if not exists chat_count       integer not null default 0,
  add column if not exists storage_count    integer not null default 0,
  add column if not exists synthesise_count integer not null default 0;

-- 3. Atomic increment + cap check.
--   - Only enforces the cap for is_anonymous tenants; authenticated tenants
--     pass straight through (returns exceeded=false, new_count=0).
--   - Increments BEFORE checking, then returns the post-increment value so
--     two concurrent callers racing the last slot still observe distinct counts.
--   - p_kind must be one of 'chat' | 'storage' | 'synthesise'. Any other
--     value raises an exception (caught + surfaced as 500 by the caller).
create or replace function increment_anon_cap(
  p_tenant_id uuid,
  p_kind      text,
  p_cap       integer
)
returns table(new_count integer, exceeded boolean) as $$
declare
  v_is_anonymous boolean;
  v_new_count    integer;
begin
  select is_anonymous into v_is_anonymous
    from tenants where id = p_tenant_id;

  if v_is_anonymous is null then
    raise exception 'tenant % not found', p_tenant_id;
  end if;

  if not v_is_anonymous then
    -- Authenticated tenants are uncapped at this layer (the per-hour
    -- MCP rate limit in rate_limits still applies elsewhere).
    return query select 0, false;
    return;
  end if;

  if p_kind = 'chat' then
    update tenants set chat_count = chat_count + 1
      where id = p_tenant_id
      returning chat_count into v_new_count;
  elsif p_kind = 'storage' then
    update tenants set storage_count = storage_count + 1
      where id = p_tenant_id
      returning storage_count into v_new_count;
  elsif p_kind = 'synthesise' then
    update tenants set synthesise_count = synthesise_count + 1
      where id = p_tenant_id
      returning synthesise_count into v_new_count;
  else
    raise exception 'unknown cap kind: %', p_kind;
  end if;

  return query select v_new_count, (v_new_count > p_cap);
end;
$$ language plpgsql security definer;

notify pgrst, 'reload schema';

commit;
