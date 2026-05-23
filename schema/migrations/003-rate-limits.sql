-- 003-rate-limits.sql
-- Session 2, step 5 — rate limiting state in Supabase.
--
-- Design:
--   * Fixed-window counters keyed by an opaque string (e.g. "mcp:<tenant_id>"
--     or "auth:<email>"). The caller picks the key shape.
--   * Window aligned to the hour boundary via date_trunc('hour', now()).
--   * One atomic RPC, `increment_rate_limit(key, max)`, does upsert+increment
--     in a single statement so concurrent calls can't race past the limit.
--   * Old rows accumulate — they're tiny and indexed; a future cron can prune
--     anything with window_start < now() - interval '24 hours'.
--
-- Safe to re-run.

begin;

create table if not exists rate_limits (
  bucket_key   text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (bucket_key, window_start)
);

create index if not exists rate_limits_window_idx
  on rate_limits(window_start);

alter table rate_limits enable row level security;

-- Atomic upsert+increment. Returns the new count and whether we just crossed
-- the configured max. The caller can decide what to do with `exceeded`.
create or replace function increment_rate_limit(p_key text, p_max integer)
returns table(new_count integer, exceeded boolean) as $$
declare
  v_window_start timestamptz := date_trunc('hour', now());
  v_count        integer;
begin
  insert into rate_limits(bucket_key, window_start, count)
  values (p_key, v_window_start, 1)
  on conflict (bucket_key, window_start)
    do update set count = rate_limits.count + 1
  returning rate_limits.count into v_count;

  return query select v_count, (v_count > p_max);
end;
$$ language plpgsql security definer;

-- Tell PostgREST about the new function.
notify pgrst, 'reload schema';

commit;
