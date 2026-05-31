-- 018-workspaces-and-permissions.sql
-- Phase 1: Workspaces, Permissions, and Personal Sharing (build brief 2026-05-31).
--
-- The architectural foundations for a multi-workspace product, plus the single
-- user-visible feature: a user can share one knowledge item with another person
-- by email at one of five permission levels. The AI-native "can_use" level is
-- what makes a shared item usable by the recipient's twin, not just readable.
--
-- ADDITIVE ONLY. No drops, no renames, no row deletes. Fully reversible:
--   * the new tables can be dropped,
--   * knowledge.workspace_id / concept_pages.workspace_id can be set back to null
--     and the column dropped,
-- and prior state is restored. Backfill runs separately as an observable node
-- script (scripts/workspaces/backfill.mjs), never inline here.
--
-- Safe to re-run (every object uses if-not-exists / drop-then-add).
--
-- Asymmetric IP ratchet (sacred): Phase 1 only creates personal workspaces, so
-- there is nothing to ratchet yet. The schema deliberately provides NO mechanism
-- that copies an item from one workspace into another. The contribution mechanic
-- (Phase 2) will be one-directional in code; this migration leaves that door
-- closed by simply not opening it. An item has exactly one workspace_id.

begin;

-- ── workspaces ────────────────────────────────────────────────────────────────
-- Top-level container. Every knowledge item belongs to exactly one workspace.
create table if not exists workspaces (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants(id) on delete cascade,
  type        text        not null check (type in ('personal', 'organisational')),
  name        text        not null,
  owner_id    uuid        not null references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_workspaces_owner  on workspaces(owner_id);
create index if not exists idx_workspaces_tenant on workspaces(tenant_id);

alter table workspaces enable row level security;

-- ── workspace_memberships ───────────────────────────────────────────────────
-- Who is in which workspace, and as what role.
create table if not exists workspace_memberships (
  id            uuid        primary key default gen_random_uuid(),
  workspace_id  uuid        not null references workspaces(id) on delete cascade,
  user_id       uuid        not null references users(id)      on delete cascade,
  role          text        not null check (role in ('owner', 'admin', 'member', 'guest')),
  invited_by    uuid        references users(id),
  joined_at     timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index if not exists idx_memberships_user      on workspace_memberships(user_id);
create index if not exists idx_memberships_workspace on workspace_memberships(workspace_id);

alter table workspace_memberships enable row level security;

-- ── permission_groups (created dormant in Phase 1, activates in Phase 3) ───────
-- Defined before `permissions` so permissions.subject_group_id can carry a real
-- foreign key rather than a loose uuid (approved Sub-phase 0 deviation).
create table if not exists permission_groups (
  id           uuid        primary key default gen_random_uuid(),
  workspace_id uuid        not null references workspaces(id) on delete cascade,
  name         text        not null,
  created_by   uuid        not null references users(id),
  created_at   timestamptz not null default now()
);

create index if not exists idx_permission_groups_workspace on permission_groups(workspace_id);

alter table permission_groups enable row level security;

create table if not exists permission_group_members (
  group_id   uuid        not null references permission_groups(id) on delete cascade,
  user_id    uuid        not null references users(id)             on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);

alter table permission_group_members enable row level security;

-- ── permissions ───────────────────────────────────────────────────────────────
-- A grant. Subject is exactly one of {user, group}. Object is exactly one of
-- {workspace, item}. The two xor checks enforce that at the row level.
-- object_item_id and subject_group_id carry real foreign keys (approved deviation
-- from the brief, which left them as loose uuids) so a deleted item or group
-- cascades its grants away and revocation can never strand a row.
create table if not exists permissions (
  id                   uuid        primary key default gen_random_uuid(),
  subject_user_id      uuid        references users(id)             on delete cascade,
  subject_group_id     uuid        references permission_groups(id) on delete cascade,
  object_workspace_id  uuid        references workspaces(id)        on delete cascade,
  object_item_id       uuid        references knowledge(id)         on delete cascade,
  level                text        not null check (level in ('can_view', 'can_comment', 'can_use', 'can_edit', 'full_access')),
  granted_by           uuid        not null references users(id),
  granted_at           timestamptz not null default now(),
  check ((subject_user_id is null) <> (subject_group_id is null)),
  check ((object_workspace_id is null) <> (object_item_id is null))
);

create index if not exists idx_permissions_user      on permissions(subject_user_id);
create index if not exists idx_permissions_group     on permissions(subject_group_id);
create index if not exists idx_permissions_item      on permissions(object_item_id);
create index if not exists idx_permissions_workspace on permissions(object_workspace_id);

alter table permissions enable row level security;

-- ── invitations ───────────────────────────────────────────────────────────────
-- Outstanding email invitations to share a specific item. item_id carries a real
-- foreign key (approved deviation). The unique token is the magic-link secret.
create table if not exists invitations (
  id           uuid        primary key default gen_random_uuid(),
  email        text        not null,
  workspace_id uuid        references workspaces(id) on delete cascade,
  item_id      uuid        references knowledge(id)  on delete cascade,
  level        text        not null check (level in ('can_view', 'can_comment', 'can_use', 'can_edit', 'full_access')),
  invited_by   uuid        not null references users(id),
  invited_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  token        text        not null unique
);

create index if not exists idx_invitations_email on invitations(email);
create index if not exists idx_invitations_token on invitations(token);

alter table invitations enable row level security;

-- ── knowledge.workspace_id ──────────────────────────────────────────────────
-- Nullable for now. The backfill script sets it for every existing item; a
-- NOT NULL constraint is deliberately NOT enforced in this migration so the
-- change stays reversible until the backfill has been verified in production.
alter table knowledge
  add column if not exists workspace_id uuid references workspaces(id);

create index if not exists idx_knowledge_workspace on knowledge(workspace_id);

-- ── concept_pages.workspace_id ────────────────────────────────────────────────
-- Concept pages are compiled, user-visible items too, so they ride the same
-- workspace assignment. Same nullable-until-verified treatment.
alter table concept_pages
  add column if not exists workspace_id uuid references workspaces(id);

create index if not exists idx_concept_pages_workspace on concept_pages(workspace_id);

commit;

-- Reload the PostgREST schema cache so supabase-js sees the new tables and the
-- knowledge/concept_pages.workspace_id column immediately (matters when this file
-- is applied by hand via the Supabase SQL editor rather than the migration runner).
notify pgrst, 'reload schema';
