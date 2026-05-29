-- 017-knowledge-migration-log.sql
-- The reversible backup ledger for the v2 type/provenance reclassification
-- (build brief 2026-05-29). Every change the reclassification pass makes to a
-- knowledge row's type or provenance is recorded here BEFORE the row is touched,
-- so any pass can be rolled back exactly to the prior values.
--
-- A backup we have not tested is not a backup: scripts/reclassify/rollback.mjs
-- restores type + provenance from this table and the rehearsal proves it.
--
-- Additive only. Safe to re-run.

begin;

create table if not exists knowledge_migration_log (
  id              uuid        primary key default gen_random_uuid(),
  knowledge_id    uuid        not null references knowledge(id) on delete cascade,
  tenant_id       uuid        not null references tenants(id)   on delete cascade,
  old_type        text,
  new_type        text,
  old_provenance  text,
  new_provenance  text,
  rule            text,                       -- the classification rule that fired
  batch           text,                       -- pass identifier, e.g. 'staging-2026-05-29' / 'prod-2026-05-29'
  rolled_back     boolean     not null default false,
  changed_at      timestamptz not null default now()
);

-- Look up a tenant's log entries, newest first, for review and rollback.
create index if not exists kml_tenant_changed_idx on knowledge_migration_log (tenant_id, changed_at desc);
-- Find the entries for a given knowledge row (rollback restores the latest).
create index if not exists kml_knowledge_idx       on knowledge_migration_log (knowledge_id);
-- Scope a rollback to a single pass.
create index if not exists kml_batch_idx           on knowledge_migration_log (batch);

alter table knowledge_migration_log enable row level security;

commit;
