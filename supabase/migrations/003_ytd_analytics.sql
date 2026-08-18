-- YTD analytics fact store.
-- Operational sweep tables remain the live tracker source of truth; these
-- tables support historical referral and agency analytics only.

create table if not exists ytd_sync_runs (
  id uuid primary key default gen_random_uuid(),
  scan_year int not null,
  run_type text not null check (run_type in ('backfill', 'incremental', 'preflight')),
  channel text not null check (channel in ('referral', 'agency', 'all')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  applications_scanned int not null default 0,
  facts_upserted int not null default 0,
  stage_events_upserted int not null default 0,
  error_message text,
  metadata jsonb
);

create table if not exists ytd_application_facts (
  application_id bigint primary key,
  scan_year int not null,
  channel text not null check (channel in ('referral', 'agency')),
  candidate_id bigint not null,
  candidate_name text,
  candidate_email text,
  job_id bigint not null,
  job_title text,
  source_id bigint,
  source_name text,
  application_status text,
  applied_at timestamptz,
  last_activity_at timestamptz,
  referrer_id bigint,
  referrer_name text,
  agency_source_id bigint,
  agency_source_name text,
  primary_recruiter_id bigint,
  primary_recruiter_name text,
  recruiter_ids bigint[] not null default '{}',
  recruiter_names text[] not null default '{}',
  current_stage_id bigint,
  current_stage_name text,
  current_stage_entered_at timestamptz,
  application_review_entered_at timestamptz,
  application_review_exited_at timestamptz,
  actioned_at timestamptz,
  action_time_hours float,
  never_actioned boolean not null default false,
  action_time_quality text check (action_time_quality in ('exact', 'approximate', 'unknown')),
  max_stage_id bigint,
  max_stage_name text,
  max_stage_rank int,
  terminal_outcome text check (terminal_outcome in ('active', 'rejected', 'hired', 'converted', 'unknown')),
  conflict_detected boolean not null default false,
  conflict_types text[] not null default '{}',
  dual_agency_group_key text,
  prior_internal_application_ids bigint[] not null default '{}',
  conflict_detail jsonb,
  data_quality_flags text[] not null default '{}',
  last_synced_at timestamptz not null default now(),
  sync_run_id uuid references ytd_sync_runs(id)
);

create table if not exists ytd_application_stage_events (
  id bigint primary key,
  application_id bigint not null,
  job_interview_stage_id bigint,
  stage_name text,
  stage_rank int,
  entered_at timestamptz,
  exited_at timestamptz,
  days_in_stage float,
  current boolean not null default false,
  sync_run_id uuid references ytd_sync_runs(id)
);

create table if not exists ytd_job_stage_definitions (
  job_interview_stage_id bigint primary key,
  job_id bigint not null,
  stage_name text,
  stage_rank int,
  active boolean,
  last_synced_at timestamptz not null default now()
);

create table if not exists ytd_job_owner_snapshots (
  job_id bigint not null,
  user_id bigint not null,
  owner_type text not null,
  user_name text,
  user_email text,
  active boolean not null default true,
  last_seen_run_id uuid references ytd_sync_runs(id),
  last_seen_at timestamptz not null default now(),
  primary key (job_id, user_id, owner_type)
);

create index if not exists idx_ytd_facts_year_channel on ytd_application_facts(scan_year, channel);
create index if not exists idx_ytd_facts_year_channel_job on ytd_application_facts(scan_year, channel, job_id);
create index if not exists idx_ytd_facts_year_channel_stage on ytd_application_facts(scan_year, channel, current_stage_name);
create index if not exists idx_ytd_facts_year_channel_never_actioned on ytd_application_facts(scan_year, channel, never_actioned);
create index if not exists idx_ytd_facts_year_channel_conflict on ytd_application_facts(scan_year, channel, conflict_detected);
create index if not exists idx_ytd_facts_recruiter_ids on ytd_application_facts using gin(recruiter_ids);
create index if not exists idx_ytd_facts_conflict_types on ytd_application_facts using gin(conflict_types);
create index if not exists idx_ytd_facts_quality_flags on ytd_application_facts using gin(data_quality_flags);
create index if not exists idx_ytd_stage_events_application on ytd_application_stage_events(application_id);
create index if not exists idx_ytd_job_owners_job_type on ytd_job_owner_snapshots(job_id, owner_type, active);
