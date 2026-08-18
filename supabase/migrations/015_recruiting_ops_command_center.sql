-- 015 (was 010; renumbered past main's parallel 010–014 lineage) — Recruiting Ops
-- Command Center persistence substrate.
--
-- Schema only. This migration creates non-production command-center tables for
-- source-controlled registries, local/shadow run ledgers, evidence refs,
-- discrepancy classification, and dry-run action proposals. It intentionally
-- does not create production writers, live Greenhouse write paths, warehouse/dbt
-- dependencies, or broad candidate payload storage.

create extension if not exists pgcrypto;

create table if not exists recruiting_ops_workflow_registry (
  id text primary key,
  title text not null,
  category text not null,
  cadence text not null,
  priority text not null,
  status text not null,
  capability text not null,
  source_ids text[] not null default '{}',
  query_ids text[] not null default '{}',
  output_contract_ids text[] not null default '{}',
  provenance jsonb not null default '[]'::jsonb,
  blockers text[] not null default '{}',
  next_gate text not null,
  updated_at timestamptz not null default now()
);

create table if not exists recruiting_ops_legacy_artifacts (
  id text primary key,
  artifact_type text not null,
  workflow_ids text[] not null default '{}',
  query_ids text[] not null default '{}',
  script_asset_ids text[] not null default '{}',
  output_contract_ids text[] not null default '{}',
  source_id text not null,
  title text not null,
  location_label text not null,
  custody_status text not null,
  access_status text not null,
  expected_headers text[] not null default '{}',
  provenance jsonb not null default '[]'::jsonb,
  blockers text[] not null default '{}',
  next_gate text not null,
  updated_at timestamptz not null default now()
);

create table if not exists recruiting_ops_output_contracts (
  id text primary key,
  source_contract_id text not null,
  workflow_ids text[] not null default '{}',
  renderer text not null,
  format text not null,
  schema_version text not null,
  columns jsonb not null default '[]'::jsonb,
  manual_fields text[] not null default '{}',
  validation_checks text[] not null default '{}',
  pii_policy text not null check (pii_policy in ('public_safe','internal_review_identifiers','restricted')),
  source_ids text[] not null default '{}',
  production_write_enabled boolean not null default false check (production_write_enabled = false),
  provenance jsonb not null default '[]'::jsonb,
  blockers text[] not null default '{}',
  next_gate text not null,
  updated_at timestamptz not null default now()
);

create table if not exists recruiting_ops_runs (
  run_id text primary key,
  workflow_id text not null,
  module_id text not null,
  mode text not null check (mode in ('fixture','local','shadow','production')),
  status text not null check (status in ('succeeded','blocked','failed','partial')),
  started_at timestamptz not null,
  completed_at timestamptz,
  input_checksum text not null,
  normalized_row_count integer not null check (normalized_row_count >= 0),
  normalized_checksum text not null,
  public_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_recops_runs_workflow_started
  on recruiting_ops_runs (workflow_id, started_at desc);

create table if not exists recruiting_ops_run_evidence_refs (
  id uuid primary key default gen_random_uuid(),
  run_id text not null references recruiting_ops_runs(run_id) on delete cascade,
  evidence_ref_id text not null,
  source_id text not null,
  adapter text not null,
  label text not null,
  artifact_id text,
  created_at timestamptz not null default now(),
  unique (run_id, evidence_ref_id)
);
create index if not exists idx_recops_run_evidence_refs_run
  on recruiting_ops_run_evidence_refs (run_id);

create table if not exists recruiting_ops_run_artifacts (
  artifact_id text primary key,
  run_id text not null references recruiting_ops_runs(run_id) on delete cascade,
  workflow_id text not null,
  format text not null,
  path text not null,
  row_count integer not null check (row_count >= 0),
  checksum text not null,
  schema_version text not null,
  source_refs text[] not null default '{}',
  public_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_recops_run_artifacts_run
  on recruiting_ops_run_artifacts (run_id);

create table if not exists recruiting_ops_source_gaps (
  id text primary key,
  run_id text not null references recruiting_ops_runs(run_id) on delete cascade,
  workflow_id text not null,
  source_id text not null,
  field text not null,
  reason text not null,
  blocks_cutover boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_recops_source_gaps_run
  on recruiting_ops_source_gaps (run_id);

create table if not exists recruiting_ops_discrepancy_classes (
  class text primary key,
  description text not null
);

insert into recruiting_ops_discrepancy_classes (class, description) values
  ('legacy_bug', 'Legacy artifact appears wrong or internally inconsistent.'),
  ('stale_mapping', 'Legacy mapping appears stale relative to current source facts.'),
  ('source_gap', 'Required evidence or source field is missing or incomplete.'),
  ('intentional_modernization', 'Modern output intentionally differs from legacy behavior.'),
  ('modern_bug', 'Modern module appears wrong and needs repair.'),
  ('business_definition_open', 'Business definition requires owner decision.')
on conflict (class) do nothing;

create table if not exists recruiting_ops_discrepancies (
  id text primary key,
  run_id text not null references recruiting_ops_runs(run_id) on delete cascade,
  workflow_id text not null,
  class text not null references recruiting_ops_discrepancy_classes(class),
  severity text not null check (severity in ('info','warning','blocking')),
  entity_key text not null,
  field text not null,
  modern_value_summary text not null,
  legacy_value_summary text not null,
  evidence_refs text[] not null default '{}',
  resolution_status text not null check (resolution_status in ('open','accepted','rejected','needs_owner','resolved')),
  owner text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_recops_discrepancies_run
  on recruiting_ops_discrepancies (run_id);
create index if not exists idx_recops_discrepancies_resolution
  on recruiting_ops_discrepancies (resolution_status, severity);

create table if not exists recruiting_ops_action_proposals (
  proposal_id text primary key,
  workflow_id text not null,
  target_system text not null check (target_system in ('greenhouse','linkedin','google_admin','gmail')),
  target_reference text not null,
  action_type text not null check (action_type in (
    'requisition_update',
    'requisition_open',
    'offer_update',
    'offer_approval_review',
    'greenhouse_user_update',
    'linkedin_user_checklist',
    'google_group_membership_update',
    'inbox_draft'
  )),
  actor text not null,
  reason text not null,
  risk_tier text not null check (risk_tier in ('low','medium','high','never')),
  approval_state text not null check (approval_state in (
    'draft',
    'pending_human',
    'approved_for_manual_step',
    'rejected',
    'blocked'
  )),
  evidence_refs text[] not null default '{}',
  payload_fingerprint text not null,
  redacted_payload_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  no_live_execution boolean not null default true check (no_live_execution = true),
  inserted_at timestamptz not null default now()
);
create index if not exists idx_recops_action_proposals_workflow
  on recruiting_ops_action_proposals (workflow_id, created_at desc);
create index if not exists idx_recops_action_proposals_approval
  on recruiting_ops_action_proposals (approval_state, risk_tier);

-- ============================================================
-- Row-level security (persistence completeness, audit §4.6).
-- Deny-by-default: RLS enabled with NO policies; anon/authenticated
-- revoked. The service-role adapter (approved in C2) bypasses RLS;
-- nothing else can read or write these PII-bearing tables.
--
-- The revokes are role-guarded: on a non-Supabase Postgres (test targets)
-- the anon/authenticated roles do not exist and a bare revoke would error —
-- under psql's default continue-on-error that is a SILENT partial apply.
-- RLS-enable alone still denies everything (no policies exist); the guard
-- raises a loud warning so the skipped defense-in-depth layer is visible.
-- ============================================================

alter table recruiting_ops_workflow_registry enable row level security;
alter table recruiting_ops_legacy_artifacts enable row level security;
alter table recruiting_ops_output_contracts enable row level security;
alter table recruiting_ops_runs enable row level security;
alter table recruiting_ops_run_evidence_refs enable row level security;
alter table recruiting_ops_run_artifacts enable row level security;
alter table recruiting_ops_source_gaps enable row level security;
alter table recruiting_ops_discrepancy_classes enable row level security;
alter table recruiting_ops_discrepancies enable row level security;
alter table recruiting_ops_action_proposals enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
    and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table recruiting_ops_workflow_registry from anon, authenticated;
    revoke all on table recruiting_ops_legacy_artifacts from anon, authenticated;
    revoke all on table recruiting_ops_output_contracts from anon, authenticated;
    revoke all on table recruiting_ops_runs from anon, authenticated;
    revoke all on table recruiting_ops_run_evidence_refs from anon, authenticated;
    revoke all on table recruiting_ops_run_artifacts from anon, authenticated;
    revoke all on table recruiting_ops_source_gaps from anon, authenticated;
    revoke all on table recruiting_ops_discrepancy_classes from anon, authenticated;
    revoke all on table recruiting_ops_discrepancies from anon, authenticated;
    revoke all on table recruiting_ops_action_proposals from anon, authenticated;
  else
    raise warning 'anon/authenticated roles absent (non-Supabase target): PostgREST revokes skipped; RLS deny-by-default still enforced';
  end if;
end $$;
