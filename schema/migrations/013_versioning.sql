-- 013_versioning.sql
-- Version history for all knowledge items.
-- Living document flag for items meant to represent current state.
-- Background log for async job results (drift detection, etc.)

begin;

-- ── knowledge_versions — full snapshot before each overwrite ──────────────────
create table if not exists knowledge_versions (
  id             uuid         primary key default gen_random_uuid(),
  knowledge_id   uuid         not null references knowledge(id) on delete cascade,
  tenant_id      uuid         not null,
  user_id        uuid         not null,
  title          text         not null default '',
  content        text         not null,
  version_number integer      not null,
  replaced_at    timestamptz  not null default now()
);

create index if not exists knowledge_versions_knowledge_version_idx
  on knowledge_versions (knowledge_id, version_number desc);
create index if not exists knowledge_versions_tenant_knowledge_idx
  on knowledge_versions (tenant_id, knowledge_id);

-- ── New columns on knowledge ──────────────────────────────────────────────────
alter table knowledge
  add column if not exists version_number      integer not null default 1,
  add column if not exists is_living_document  boolean not null default false;

-- ── background_log — for drift detection + future async job results ───────────
create table if not exists background_log (
  id         uuid         primary key default gen_random_uuid(),
  tenant_id  uuid         not null,
  job_name   text         not null,
  status     text         not null default 'completed',
  meta       jsonb,
  created_at timestamptz  not null default now()
);

create index if not exists background_log_tenant_job_idx
  on background_log (tenant_id, job_name, created_at desc);

commit;
