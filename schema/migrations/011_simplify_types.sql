-- Migration 011 — simplify knowledge types to skill / knowledge
-- The 10-type system was over-engineered and auto-classification was unreliable.
-- Two types only: 'skill' (explicitly user-flagged) and 'knowledge' (everything else).
-- All existing rows that aren't already 'skill' or 'knowledge' are coerced to 'knowledge'.

update knowledge
set type = 'knowledge'
where type not in ('skill', 'knowledge');
