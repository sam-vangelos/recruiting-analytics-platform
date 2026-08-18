-- Sweep infrastructure: tables for referral tracking + agency duplicate detection
-- Apply via Supabase dashboard SQL editor or `supabase db push`

-- sweep_runs: one row per cron invocation
create table sweep_runs (
  id uuid primary key default gen_random_uuid(),
  sweep_type text not null check (sweep_type in ('referral', 'agency')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  lookback_hours int,
  applications_scanned int default 0,
  items_found int default 0,
  items_alerted int default 0,
  error_message text,
  metadata jsonb
);

-- sweep_items: one row per detected referral or agency conflict
create table sweep_items (
  id uuid primary key default gen_random_uuid(),
  sweep_run_id uuid not null references sweep_runs(id),
  sweep_type text not null check (sweep_type in ('referral', 'agency')),
  application_id bigint not null,
  candidate_id bigint,
  job_id bigint,
  candidate_name text,
  job_title text,
  source_name text,
  current_stage text,
  application_status text,
  application_created_at timestamptz,
  current_stage_entered_at timestamptz,
  last_activity_at timestamptz,
  hours_in_current_stage float,
  sla_violated boolean default false,
  prior_application_ids bigint[],
  conflict_detail jsonb,
  created_at timestamptz not null default now()
);

-- alert_ledger: dedup + delivery + resolution tracking
create table alert_ledger (
  id uuid primary key default gen_random_uuid(),
  application_id bigint not null,
  sweep_type text not null check (sweep_type in ('referral', 'agency')),
  first_alerted_at timestamptz not null default now(),
  last_alerted_at timestamptz not null default now(),
  alert_count int not null default 1,
  slack_ts text,
  resolved_at timestamptz,
  resolution_type text check (resolution_type in ('stage_change', 'rejection', 'hire', 'manual', 'expired')),
  resolution_detail text,
  greenhouse_stage_at_alert text,
  greenhouse_stage_at_resolution text,
  unique (application_id, sweep_type)
);

-- agency_source_registry: cached agency source IDs from list_sources
create table agency_source_registry (
  source_id bigint primary key,
  source_name text not null,
  source_type text,
  last_verified_at timestamptz not null default now()
);

-- Indexes for query performance
create index idx_sweep_items_application_id on sweep_items(application_id);
create index idx_sweep_items_type_created on sweep_items(sweep_type, created_at desc);
create index idx_alert_ledger_app_type on alert_ledger(application_id, sweep_type);
create index idx_alert_ledger_unresolved on alert_ledger(sweep_type) where resolved_at is null;
create index idx_sweep_runs_type_started on sweep_runs(sweep_type, started_at desc);
