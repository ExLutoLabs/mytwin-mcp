-- 001-tenants.sql
-- Session 2, step 2 — introduce tenants table and tenant_id columns.
--
-- Design: tenant_id is a separate UUID from user_id. Today the relationship
-- is 1:1 (one tenant per user) for MVP, but the structure is ready for
-- multi-user-per-tenant ("team", "workspace") without a future schema migration.
--
-- Safe to re-run: every step is idempotent (CREATE IF NOT EXISTS, ADD COLUMN
-- IF NOT EXISTS, backfills filter on tenant_id IS NULL). Wrapped in a
-- transaction so a mid-run failure leaves the schema consistent.

begin;

-- ── 1. Tenants table ──────────────────────────────────────────────────────────
create table if not exists tenants (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz default now()
);

alter table tenants enable row level security;

-- ── 2. Add tenant_id columns (nullable for now, NOT NULL after backfill) ─────
alter table users        add column if not exists tenant_id uuid references tenants(id) on delete cascade;
alter table knowledge    add column if not exists tenant_id uuid references tenants(id) on delete cascade;
alter table sources      add column if not exists tenant_id uuid references tenants(id) on delete cascade;
alter table schema_types add column if not exists tenant_id uuid references tenants(id) on delete cascade;

-- ── 3. Backfill: one new tenant per existing user (1:1 for MVP) ───────────────
do $$
declare
  u record;
  new_tenant_id uuid;
begin
  for u in select id from users where tenant_id is null loop
    insert into tenants default values returning id into new_tenant_id;
    update users set tenant_id = new_tenant_id where id = u.id;
  end loop;
end $$;

-- ── 4. Backfill dependent tables from users.tenant_id ─────────────────────────
update knowledge    k set tenant_id = u.tenant_id from users u where u.id = k.user_id    and k.tenant_id is null;
update sources      s set tenant_id = u.tenant_id from users u where u.id = s.user_id    and s.tenant_id is null;
update schema_types t set tenant_id = u.tenant_id from users u where u.id = t.user_id    and t.tenant_id is null;

-- ── 5. Enforce NOT NULL going forward ─────────────────────────────────────────
alter table users        alter column tenant_id set not null;
alter table knowledge    alter column tenant_id set not null;
alter table sources      alter column tenant_id set not null;
alter table schema_types alter column tenant_id set not null;

-- ── 6. Compound indexes for tenant-scoped queries ─────────────────────────────
-- Old (user_id, ...) indexes remain for now — they're still queried alongside
-- tenant_id as defence-in-depth. Drop them only after we're confident.
create index if not exists knowledge_tenant_created_idx on knowledge(tenant_id, created_at desc);
create index if not exists knowledge_tenant_type_idx    on knowledge(tenant_id, type);
create index if not exists sources_tenant_ingested_idx  on sources(tenant_id, ingested_at desc);
create index if not exists schema_types_tenant_name_idx on schema_types(tenant_id, name);
create index if not exists users_tenant_idx             on users(tenant_id);

commit;
