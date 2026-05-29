-- Migration 015 — skill_proposals
--
-- Background job "detect-skill" writes candidate skill proposals here when it
-- spots a repeatable pattern across recent craft-oriented items.
-- The proposal surfaces as a nudge in creation-mode chat responses.

create table skill_proposals (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants(id)  on delete cascade,
  user_id     uuid        not null references users(id)    on delete cascade,
  title       text        not null,
  description text        not null,
  status      text        not null default 'pending'
                          check (status in ('pending', 'accepted', 'dismissed')),
  created_at  timestamptz not null default now()
);

create index on skill_proposals (tenant_id, status, created_at desc);
