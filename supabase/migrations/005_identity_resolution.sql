-- 005_identity_resolution.sql — W1 Foundation (NOT auto-applied; apply manually via Supabase
-- dashboard SQL editor or `supabase db push` after review).
--
-- Durable + accountability + audit identity layer (synthesized: C3 base + C1 snapshot/responsible,
-- C1/C2 companion-not-ALTER for registry). Lives OUTSIDE operational sweep tables (001/002) and the
-- YTD fact store (003/004). agency_source_registry (001) stays the thin id->name cache UNCHANGED
-- (no ALTER); agency_source_resolution is the evidence companion. CHECK constraints mirror the TS
-- enums in lib/resolution-types.ts (single source of truth for the enum<->SQL contract).
--
-- Idempotent: IF NOT EXISTS / IF EXISTS throughout so re-running is safe.
-- Verified against 003_ytd_analytics.sql (ytd_sync_runs.id is uuid -> sync_run_id uuid matches) and
-- 002_agency_submissions.sql (agency_source_id / agency_source_name exist as NOT NULL -> drop not null
-- has real targets). notification_delivery_attempts is intentionally NOT created here (sibling G3/W3
-- design; creating it now widens migration surface).

create extension if not exists pgcrypto;

create table if not exists greenhouse_job_ownership (
  job_id bigint primary key,
  job_title text,
  department_id bigint,
  department_name text,
  primary_recruiter_id bigint,
  primary_recruiter_name text,
  recruiter_ids bigint[] not null default '{}',
  recruiter_names text[] not null default '{}',
  responsible_recruiter_id bigint,                 -- from live /job_owners responsible:true
  confidence text not null default 'unresolved'
    check (confidence in ('confirmed','high','inferred','unresolved')),
  resolution_status text not null default 'unresolved'
    check (resolution_status in ('resolved','ambiguous','unresolved','permission_blocked')),
  evidence_types text[] not null default '{}',
  evidence_detail jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now()
);

-- Append-only: who was accountable when the application entered a tracker. Multiple rows over
-- time (confidence upgrades). NO unique on application_id; uniqueness is the surrogate id.
create table if not exists application_ownership_snapshots (
  id uuid primary key default gen_random_uuid(),
  application_id bigint not null,
  candidate_id bigint not null,
  job_id bigint not null,
  channel text not null check (channel in ('referral','agency')),
  primary_recruiter_id bigint,
  primary_recruiter_name text,
  recruiter_ids bigint[] not null default '{}',
  recruiter_names text[] not null default '{}',
  referrer_id bigint,
  referrer_name text,
  ownership_source text,                           -- 'write_time_sweep' | 'ytd_extract' | 'reconcile'
  ownership_confidence text not null
    check (ownership_confidence in ('confirmed','high','inferred','unresolved')),
  ownership_resolution_status text not null
    check (ownership_resolution_status in ('resolved','ambiguous','unresolved','permission_blocked')),
  ownership_evidence_types text[] not null default '{}',
  ownership_evidence_detail jsonb,
  ownership_resolved_at timestamptz,               -- null until first high+ resolve (lock point)
  sync_run_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists idx_ownership_snap_app on application_ownership_snapshots(application_id, created_at desc);
create index if not exists idx_ownership_snap_job on application_ownership_snapshots(job_id);
create index if not exists idx_ownership_snap_unresolved on application_ownership_snapshots(ownership_resolution_status)
  where ownership_resolution_status <> 'resolved';

-- Audit + retry queue. One live row per entity; reconcile updates it; UI surfaces it as a defect.
create table if not exists identity_resolution_attempts (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null
    check (entity_type in ('job_ownership','application_ownership','agency_source','agency_submitter')),
  entity_id text not null,                          -- job_id | application_id::channel | source_id
  channel text check (channel in ('referral','agency')),
  status text not null
    check (status in ('resolved','unresolved','ambiguous','permission_blocked','failed')),
  confidence text check (confidence in ('confirmed','high','inferred','unresolved')),
  attempt_number int not null default 1,
  evidence_sources_checked text[] not null default '{}',
  failure_reason text,
  next_retry_at timestamptz,                        -- backoff target; null once resolved
  attempted_at timestamptz not null default now(),
  metadata jsonb,
  unique (entity_type, entity_id)
);
create index if not exists idx_attempts_due on identity_resolution_attempts(next_retry_at)
  where status in ('unresolved','ambiguous','failed');
create index if not exists idx_attempts_entity on identity_resolution_attempts(entity_type, entity_id, attempted_at desc);

-- Evidence-bearing agency identity (companion to agency_source_registry, which is left unchanged).
create table if not exists agency_source_resolution (
  source_id bigint primary key,
  source_name text,
  source_type_id bigint,                            -- 4000007004 = 'Agencies' (live-confirmed)
  source_type_name text,
  agency_name text,                                 -- NULL when unresolved; NEVER 'Unknown Agency'
  agency_account_id bigint,
  agency_user_ids bigint[] not null default '{}',
  active boolean not null default true,
  confidence text not null default 'unresolved'
    check (confidence in ('confirmed','high','inferred','unresolved')),
  resolution_status text not null default 'unresolved'
    check (resolution_status in ('resolved','unresolved','ambiguous')),
  evidence_types text[] not null default '{}',
  evidence_detail jsonb,
  last_verified_at timestamptz not null default now()
);
create index if not exists idx_agency_res_status on agency_source_resolution(resolution_status, active)
  where resolution_status <> 'resolved';

-- Inline writeback columns so reads stay single-table (dashboards are select *). Additive, nullable.
alter table ytd_application_facts add column if not exists ownership_confidence text
  check (ownership_confidence is null or ownership_confidence in ('confirmed','high','inferred','unresolved'));
alter table ytd_application_facts add column if not exists ownership_resolution_status text
  check (ownership_resolution_status is null or ownership_resolution_status in ('resolved','ambiguous','unresolved','permission_blocked'));
alter table ytd_application_facts add column if not exists source_resolution_status text
  check (source_resolution_status is null or source_resolution_status in ('resolved','ambiguous','unresolved'));

alter table sweep_items add column if not exists recruiter_id bigint;
alter table sweep_items add column if not exists referrer_id bigint;
alter table sweep_items add column if not exists ownership_confidence text check (ownership_confidence is null or ownership_confidence in ('confirmed','high','inferred','unresolved'));
alter table sweep_items add column if not exists ownership_resolution_status text check (ownership_resolution_status is null or ownership_resolution_status in ('resolved','ambiguous','unresolved','permission_blocked'));

-- agency_submissions: allow NULL instead of 'Unknown Agency'/0.
alter table agency_submissions alter column agency_source_id drop not null;
alter table agency_submissions alter column agency_source_name drop not null;
alter table agency_submissions add column if not exists source_resolution_status text
  check (source_resolution_status is null or source_resolution_status in ('resolved','ambiguous','unresolved'));
alter table agency_submissions add column if not exists recruiter_id bigint;
alter table agency_submissions add column if not exists recruiter_name text;
alter table agency_submissions add column if not exists ownership_resolution_status text check (ownership_resolution_status is null or ownership_resolution_status in ('resolved','ambiguous','unresolved','permission_blocked'));

-- agency_source_registry (001) intentionally UNCHANGED. notification_delivery_attempts intentionally
-- NOT created here (sibling G3/W3 notification design).
