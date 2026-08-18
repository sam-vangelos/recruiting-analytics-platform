-- 016 (was 011; renumbered past main's parallel 010–014 lineage) — Capability-first
-- provenance for the Recruiting Ops Command Center.
--
-- Adds capability_id to the run-scoped ledger tables so every persisted run,
-- artifact, source gap, discrepancy, and action proposal carries its capability
-- as first-class provenance. The application layer stamps and requires it before
-- persistence (see lib/recruiting-ops/runs.ts buildCommandCenterRun and the
-- requireCapability guard in lib/recruiting-ops/persistence.ts).
--
-- Schema only; non-production. NOT NULL without a default is only valid on EMPTY
-- tables — the guard below fails loudly (ARCH-MIG-1) instead of letting a non-empty
-- table abort mid-migration or tempting a sentinel default.

do $$
declare
  ledger_table text;
  has_rows boolean;
begin
  foreach ledger_table in array array[
    'recruiting_ops_runs',
    'recruiting_ops_run_artifacts',
    'recruiting_ops_source_gaps',
    'recruiting_ops_discrepancies',
    'recruiting_ops_action_proposals'
  ] loop
    -- Re-apply idempotency: once capability_id exists, the alters below are
    -- if-not-exists no-ops and the emptiness requirement no longer applies.
    if exists (
      select 1 from information_schema.columns
      where table_name = ledger_table and column_name = 'capability_id'
    ) then
      continue;
    end if;
    execute format('select exists (select 1 from %I limit 1)', ledger_table) into has_rows;
    if has_rows then
      raise exception
        'Migration 016 requires % to be empty: capability_id is NOT NULL without a default. Backfill or truncate deliberately before applying.',
        ledger_table;
    end if;
  end loop;
end $$;

alter table recruiting_ops_runs
  add column if not exists capability_id text not null;
alter table recruiting_ops_run_artifacts
  add column if not exists capability_id text not null;
alter table recruiting_ops_source_gaps
  add column if not exists capability_id text not null;
alter table recruiting_ops_discrepancies
  add column if not exists capability_id text not null;
alter table recruiting_ops_action_proposals
  add column if not exists capability_id text not null;

create index if not exists idx_recops_runs_capability
  on recruiting_ops_runs (capability_id);
create index if not exists idx_recops_discrepancies_capability
  on recruiting_ops_discrepancies (capability_id);
create index if not exists idx_recops_action_proposals_capability
  on recruiting_ops_action_proposals (capability_id);
