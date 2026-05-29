-- Migration 010 — concept_pages
-- Compiled, versioned concept pages. Each page synthesises a cluster of
-- related knowledge items into a coherent, readable view of how the user
-- thinks (flavour: 'thinking') or creates (flavour: 'craft').
-- Compilation is triggered asynchronously after every confirm-store.

create table if not exists concept_pages (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants(id) on delete cascade,
  user_id     uuid        not null references users(id)   on delete cascade,
  flavour     text        not null check (flavour in ('thinking', 'craft')),
  title       text        not null,
  summary     text        not null,
  content     text        not null,
  source_ids  uuid[]      not null default '{}',
  version     integer     not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists concept_pages_tenant_flavour_idx
  on concept_pages (tenant_id, flavour, updated_at desc);

create index if not exists concept_pages_tenant_user_idx
  on concept_pages (tenant_id, user_id);
