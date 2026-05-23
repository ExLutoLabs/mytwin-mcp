-- My Twin MCP V2 — multi-tenant schema
-- Run this in your Supabase SQL editor (new dedicated project)

-- ── Users ──────────────────────────────────────────────────────────────────────

create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique not null,
  created_at timestamptz default now()
);

create index if not exists users_email_idx on users(email);

-- ── Magic link tokens ──────────────────────────────────────────────────────────

create table if not exists magic_tokens (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  token      text unique not null,
  used       boolean default false,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

create index if not exists magic_tokens_token_idx on magic_tokens(token);

-- Auto-clean expired tokens (optional: run via pg_cron or just rely on select filter)

-- ── Knowledge store ────────────────────────────────────────────────────────────

create table if not exists knowledge (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  type        text not null,
  title       text,
  content     text not null,
  source_type text,   -- 'typed', 'voice-note', 'document', 'url'
  source_ref  text,
  tags        text[],
  pinecone_id text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create index if not exists knowledge_user_idx     on knowledge(user_id);
create index if not exists knowledge_type_idx     on knowledge(user_id, type);
create index if not exists knowledge_created_idx  on knowledge(user_id, created_at desc);

-- ── Schema types ───────────────────────────────────────────────────────────────

create table if not exists schema_types (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  description text,
  created_at  timestamptz default now(),
  unique(user_id, name)
);

create index if not exists schema_types_user_idx on schema_types(user_id);

-- ── Ingested sources ───────────────────────────────────────────────────────────

create table if not exists sources (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  source_type text not null,   -- 'document', 'url', 'voice-note'
  reference   text not null,
  summary     text,
  item_count  integer default 0,
  ingested_at timestamptz default now()
);

create index if not exists sources_user_idx on sources(user_id);

-- ── Auto-update updated_at trigger ────────────────────────────────────────────

create or replace function mytwin_update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'knowledge_updated_at') then
    create trigger knowledge_updated_at
      before update on knowledge
      for each row execute function mytwin_update_updated_at();
  end if;
end $$;

-- ── Row Level Security ─────────────────────────────────────────────────────────
-- We use service_role key server-side so RLS is a defence-in-depth layer.
-- Enable it but the application filters by user_id directly via service_role.

alter table knowledge    enable row level security;
alter table schema_types enable row level security;
alter table sources      enable row level security;
alter table users        enable row level security;
alter table magic_tokens enable row level security;

-- Service role bypasses RLS automatically. No policies needed for server use.
-- If you add a public client later, add explicit policies here.
