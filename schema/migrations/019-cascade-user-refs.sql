-- 019-cascade-user-refs.sql
-- Fix: account deletion is blocked by NO ACTION foreign keys that migration 018
-- introduced pointing at users(id).
--
-- deleteAccount() works by deleting the tenant row and relying on
-- ON DELETE CASCADE to tear down users -> knowledge / permissions / etc. But
-- several 018 columns reference users(id) WITHOUT an on-delete clause, so they
-- default to NO ACTION. When a tenant is deleted, the cascade that removes the
-- dependent grant/workspace rows does not reliably complete before the
-- user-deletion FK check fires, so the whole delete aborts with e.g.
--   "violates foreign key constraint permissions_granted_by_fkey".
--
-- This bites TWO ways:
--   * permissions.granted_by / invitations.invited_by — any user who has shared
--     an item can no longer delete their account (the share feature triggers it).
--   * workspaces.owner_id — EVERY backfilled user owns a personal workspace, so
--     this blocks the GDPR deletion path for the whole existing user base.
--
-- Fix: give each of these user-referencing FKs an explicit on-delete action.
--   * Grants/invitations/workspaces/groups CASCADE: when the referenced user is
--     deleted, the row they created is torn down with them. For Phase 1 this is
--     always correct — the referenced user's tenant (and thus their items and
--     personal workspace) is being deleted in the same operation anyway.
--   * workspace_memberships.invited_by SET NULL: the membership should survive
--     its inviter's deletion; we just forget who invited them (column nullable).
--
-- ADDITIVE / REVERSIBLE: this only swaps the on-delete action of existing
-- constraints (drop + re-add under the same name). Reverting to NO ACTION
-- restores prior behaviour. No data is read, written, or destroyed here.
--
-- PHASE 2 NOTE: workspaces.owner_id CASCADE means deleting an owner deletes the
-- workspace. That is right for Phase 1 personal workspaces (1:1 with a tenant).
-- When organisational workspaces arrive, deletion must first transfer ownership
-- (or this FK must move to SET NULL with owner_id made nullable) so that
-- deleting one member never nukes a shared org workspace.
--
-- Safe to re-run (drop-if-exists then add).

begin;

-- permissions.granted_by -> cascade
alter table permissions drop constraint if exists permissions_granted_by_fkey;
alter table permissions
  add constraint permissions_granted_by_fkey
  foreign key (granted_by) references users(id) on delete cascade;

-- invitations.invited_by -> cascade
alter table invitations drop constraint if exists invitations_invited_by_fkey;
alter table invitations
  add constraint invitations_invited_by_fkey
  foreign key (invited_by) references users(id) on delete cascade;

-- workspaces.owner_id -> cascade
alter table workspaces drop constraint if exists workspaces_owner_id_fkey;
alter table workspaces
  add constraint workspaces_owner_id_fkey
  foreign key (owner_id) references users(id) on delete cascade;

-- permission_groups.created_by -> cascade
alter table permission_groups drop constraint if exists permission_groups_created_by_fkey;
alter table permission_groups
  add constraint permission_groups_created_by_fkey
  foreign key (created_by) references users(id) on delete cascade;

-- workspace_memberships.invited_by -> set null (column is nullable; the
-- membership outlives its inviter)
alter table workspace_memberships drop constraint if exists workspace_memberships_invited_by_fkey;
alter table workspace_memberships
  add constraint workspace_memberships_invited_by_fkey
  foreign key (invited_by) references users(id) on delete set null;

commit;

-- Reload PostgREST's schema cache so the change is picked up immediately when
-- applied by hand via the Supabase SQL editor.
notify pgrst, 'reload schema';
