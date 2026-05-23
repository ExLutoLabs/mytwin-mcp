-- 005-provenance-and-skill-gaps.sql
-- V2 fork additions (shipped on main):
--   1. provenance column on knowledge — personal / organisational / external
--   2. skill_gaps table — track output_types the user keeps asking for
--      without a matching skill, so we can prompt them to codify one
--   3. increment_skill_gap RPC — atomic upsert+increment per (tenant, output_type)
--
-- Safe to re-run.

begin;

-- 1. provenance on knowledge
alter table knowledge
  add column if not exists provenance text default 'personal';

-- CHECK constraint — applied separately so the IF NOT EXISTS on the column
-- handles re-runs safely without conflicting on the constraint name.
do $$ begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'knowledge_provenance_check' and table_name = 'knowledge'
  ) then
    alter table knowledge
      add constraint knowledge_provenance_check
      check (provenance in ('personal', 'organisational', 'external'));
  end if;
end $$;

-- 2. skill_gaps
create table if not exists skill_gaps (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  output_type text not null,
  count       integer not null default 1,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  unique(tenant_id, output_type)
);

create index if not exists skill_gaps_tenant_idx on skill_gaps(tenant_id);

alter table skill_gaps enable row level security;

-- 3. increment_skill_gap — atomic upsert+increment.
-- Returns the new count after the operation, so the caller can check
-- whether the threshold (>=3) has been reached.
create or replace function increment_skill_gap(p_tenant_id uuid, p_output_type text)
returns integer as $$
declare
  v_count integer;
begin
  insert into skill_gaps(tenant_id, output_type, count)
  values (p_tenant_id, p_output_type, 1)
  on conflict (tenant_id, output_type)
    do update set count = skill_gaps.count + 1, last_seen = now()
  returning skill_gaps.count into v_count;
  return v_count;
end;
$$ language plpgsql security definer;

notify pgrst, 'reload schema';

commit;
