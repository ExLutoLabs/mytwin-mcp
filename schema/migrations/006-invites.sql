-- 006-invites.sql
-- Prelaunch invite system.
--
-- Model:
--   * `invites` row per code. Seeded (generated_by_user_id IS NULL) or minted
--     when a user redeems (generated_by_user_id = the redeemer's user_id).
--   * On the magic-link flow, the invite code rides through via a new
--     `invite_code` column on magic_tokens, so when the user is created on
--     verify we can atomically mark the invite redeemed and mint a new one
--     for the new user to pass on.
--
-- Cap is enforced in application code: 50 total successful redemptions.
-- Beyond that, the redemption endpoint returns a "at capacity" response and
-- the prelaunch page swaps to a waitlist form.
--
-- Safe to re-run.

begin;

create table if not exists invites (
  id                    uuid primary key default gen_random_uuid(),
  code                  text unique not null,
  generated_by_user_id  uuid references users(id) on delete set null,  -- NULL = seed
  redeemed_by_user_id   uuid unique references users(id) on delete set null,
  first_visited_at      timestamptz,
  visit_count           integer not null default 0,
  redeemed_at           timestamptz,
  created_at            timestamptz not null default now()
);

create index if not exists invites_code_idx                 on invites(code);
create index if not exists invites_redeemed_by_idx          on invites(redeemed_by_user_id);
create index if not exists invites_generated_by_idx         on invites(generated_by_user_id);
create index if not exists invites_redeemed_at_idx          on invites(redeemed_at) where redeemed_at is not null;

alter table invites enable row level security;

-- Carry the invite code through the magic-link flow so verify() can atomically
-- redeem + mint when the user is created.
alter table magic_tokens add column if not exists invite_code text;

-- Optional waitlist for the "at capacity" path on the prelaunch page.
create table if not exists waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  source      text,                                -- e.g. 'invite_full'
  created_at  timestamptz not null default now()
);

create index if not exists waitlist_email_idx on waitlist(email);
alter table waitlist enable row level security;

-- Atomic mark-visited helper. Bumps visit_count, sets first_visited_at if
-- this is the first visit. Returns the invite row so the caller can decide
-- what to render (unused / redeemed / not-found are all distinguishable).
create or replace function mark_invite_visited(p_code text)
returns table(id uuid, code text, redeemed_by_user_id uuid, visit_count integer, first_visited_at timestamptz) as $$
begin
  update invites
     set visit_count     = invites.visit_count + 1,
         first_visited_at = coalesce(invites.first_visited_at, now())
   where invites.code = p_code;
  return query
    select i.id, i.code, i.redeemed_by_user_id, i.visit_count, i.first_visited_at
      from invites i where i.code = p_code;
end;
$$ language plpgsql security definer;

notify pgrst, 'reload schema';

commit;
