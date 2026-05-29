-- 016-provenance-four-way.sql
-- V2 spine: split the single 'organisational' provenance into 'employer' and
-- 'client', because employer voice and client voice are different and must
-- never blur (see docs/twin-behaviour-spec.md §3.6, v2 build brief 2026-05-29).
--
-- ADDITIVE ONLY. 'organisational' stays valid so the existing rows that still
-- carry it remain legal until the gated retro-classification pass migrates them
-- into employer/client. Nothing is dropped or renamed.
--
-- The going-forward proposal flow offers personal / employer / client / external;
-- 'organisational' is retained purely for back-compat.
--
-- Safe to re-run.

begin;

-- Widen the CHECK constraint to the five-value union. Drop-then-add keeps this
-- idempotent: a re-run removes the widened constraint and re-adds it identically.
alter table knowledge
  drop constraint if exists knowledge_provenance_check;

alter table knowledge
  add constraint knowledge_provenance_check
  check (provenance in ('personal', 'organisational', 'employer', 'client', 'external'));

commit;
