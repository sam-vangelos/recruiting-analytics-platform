-- 024 — Durable orchestration state for copied-artifact hydration.
-- One leased run owns one immutable source execution; artifact attempts keep
-- retry/resume evidence without relying on Cloud Run request lifetime.

begin;

create extension if not exists pgcrypto;

create table if not exists recruiting_ops_hydration_runs (
  run_id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  business_date date not null,
  mode text not null check (mode in ('dry_run', 'write')),
  requested_artifacts text[] not null check (cardinality(requested_artifacts) > 0),
  status text not null default 'queued'
    check (status in ('queued', 'loading_source', 'running', 'terminal')),
  outcome text check (outcome in ('succeeded', 'no_change', 'partial', 'failed', 'timed_out')),
  source_execution_id uuid references recruiting_ops_source_executions(source_execution_id),
  source_fingerprint text,
  source_generated_at timestamptz,
  owner_token uuid,
  leased_until timestamptz,
  claim_count integer not null default 0,
  public_summary jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recruiting_ops_hydration_run_source_all_or_none check (
    (source_execution_id is null and source_fingerprint is null and source_generated_at is null)
    or
    (source_execution_id is not null and source_fingerprint is not null and source_generated_at is not null)
  ),
  constraint recruiting_ops_hydration_run_terminal_shape check (
    (status = 'terminal' and outcome is not null and completed_at is not null)
    or
    (status <> 'terminal' and outcome is null and completed_at is null)
  )
);

create index if not exists idx_recops_hydration_runs_lease
  on recruiting_ops_hydration_runs (leased_until)
  where status <> 'terminal';

create table if not exists recruiting_ops_hydration_artifact_attempts (
  attempt_id uuid primary key default gen_random_uuid(),
  run_id uuid not null references recruiting_ops_hydration_runs(run_id) on delete cascade,
  artifact_key text not null,
  attempt_no integer not null check (attempt_no > 0),
  source_execution_id uuid not null references recruiting_ops_source_executions(source_execution_id),
  source_fingerprint text not null,
  status text not null default 'running' check (status in ('running', 'terminal')),
  outcome text check (outcome in ('written', 'no_change', 'failed', 'timed_out', 'certification_failed')),
  plan_fingerprint text,
  mutation_call_count integer check (mutation_call_count is null or mutation_call_count >= 0),
  version_before text,
  version_after text,
  certification_evidence jsonb,
  failure_code text,
  failure_stage text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint recruiting_ops_hydration_artifact_attempt_unique unique (run_id, artifact_key, attempt_no),
  constraint recruiting_ops_hydration_artifact_attempt_terminal_shape check (
    (status = 'terminal' and outcome is not null and completed_at is not null)
    or
    (status = 'running' and outcome is null and completed_at is null)
  )
);

create index if not exists idx_recops_hydration_attempts_run
  on recruiting_ops_hydration_artifact_attempts (run_id, artifact_key, attempt_no desc);

create unique index if not exists idx_recops_hydration_attempt_one_active_or_certified
  on recruiting_ops_hydration_artifact_attempts (run_id, artifact_key)
  where status = 'running'
     or (
       status = 'terminal'
       and outcome in ('written', 'no_change')
       and certification_evidence is not null
     );

-- Replay payloads contain recruiting data and exist only to make interrupted
-- jobs retry-safe. Keep the non-PII identity/count evidence, but make payloads
-- eligible for pruning after seven days once no active run can still need them.
create or replace function prune_recruiting_ops_source_execution_payloads(
  p_retention_days integer default 7
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pruned integer := 0;
  prunable_source_execution_id uuid;
  expired_at timestamptz := now();
begin
  if p_retention_days is null or p_retention_days < 7 or p_retention_days > 30 then
    raise exception 'source payload retention must be between 7 and 30 days';
  end if;

  for prunable_source_execution_id in
    select source.source_execution_id
    from recruiting_ops_source_executions source
    where source.status = 'completed'
      and source.source_payload is not null
      and source.completed_at < now() - make_interval(days => p_retention_days)
      and not exists (
        select 1
        from recruiting_ops_hydration_runs run
        where run.source_execution_id = source.source_execution_id
          and run.status <> 'terminal'
          and run.leased_until > now()
      )
    for update of source skip locked
  loop
    -- Expired work cannot pin recruiting data past the retry window. Resolve
    -- its durable state while holding the source lock, then discard the cut.
    update recruiting_ops_hydration_artifact_attempts attempt
       set status = 'terminal',
           outcome = 'timed_out',
           completed_at = expired_at,
           failure_code = 'source_payload_retention_expired',
           failure_stage = 'retention_cleanup'
     where attempt.status = 'running'
       and exists (
         select 1
         from recruiting_ops_hydration_runs run
         where run.run_id = attempt.run_id
           and run.source_execution_id = prunable_source_execution_id
           and run.status <> 'terminal'
           and (run.leased_until is null or run.leased_until <= now())
       );

    update recruiting_ops_hydration_runs run
       set status = 'terminal',
           outcome = 'timed_out',
           completed_at = expired_at,
           leased_until = null,
           public_summary = jsonb_build_object(
             'failure_code', 'source_payload_retention_expired'
           ),
           updated_at = expired_at
     where run.source_execution_id = prunable_source_execution_id
       and run.status <> 'terminal'
       and (run.leased_until is null or run.leased_until <= now());

    update recruiting_ops_source_executions source
       set source_payload = null,
           source_payload_schema_version = null,
           source_payload_checksum = null,
           source_payload_pruned_at = expired_at
     where source.source_execution_id = prunable_source_execution_id
       and source.status = 'completed'
       and source.source_payload is not null
       and not exists (
         select 1
         from recruiting_ops_hydration_runs run
         where run.source_execution_id = source.source_execution_id
           and run.status <> 'terminal'
       );
    if found then
      pruned := pruned + 1;
    end if;
  end loop;
  return pruned;
end;
$$;

-- This database-owned daily job is the sole multi-source cleanup owner, so
-- claims stay source-local. cron.schedule(name, ...) is an idempotent named
-- upsert; an exact migration rerun keeps one job instead of adding duplicates.
create extension if not exists pg_cron;

select cron.schedule(
  'recruiting-ops-source-payload-prune-daily',
  '17 9 * * *',
  $cron$select public.prune_recruiting_ops_source_execution_payloads(7);$cron$
);

create or replace function claim_recruiting_ops_hydration_run(
  p_dedupe_key text,
  p_business_date date,
  p_mode text,
  p_requested_artifacts text[],
  p_owner_token uuid,
  p_lease_seconds integer default 3600
)
returns table (
  run_id uuid,
  claim_acquired boolean,
  status text,
  outcome text,
  source_execution_id uuid,
  source_fingerprint text,
  source_generated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed recruiting_ops_hydration_runs%rowtype;
  existing recruiting_ops_hydration_runs%rowtype;
  locked_source_execution_id uuid;
begin
  if coalesce(trim(p_dedupe_key), '') = '' then
    raise exception 'hydration dedupe key is required';
  end if;
  if p_business_date is null or p_owner_token is null then
    raise exception 'hydration business date and owner token are required';
  end if;
  if p_mode is null or p_mode not in ('dry_run', 'write') then
    raise exception 'invalid hydration mode';
  end if;
  if coalesce(cardinality(p_requested_artifacts), 0) = 0 then
    raise exception 'at least one hydration artifact is required';
  end if;
  if cardinality(p_requested_artifacts) <> cardinality(array(
    select distinct artifact from unnest(p_requested_artifacts) artifact
  )) then
    raise exception 'hydration artifacts must be unique';
  end if;
  if exists (
    select 1
    from unnest(p_requested_artifacts) artifact
    where coalesce(trim(artifact), '') = ''
       or artifact <> all(array[
         'elt_doc', 'weekly_recruitment', 'weekly_progress', 'all_hires',
         'pipeline_890', 'pipeline_907', 'pipeline_1026_1027',
         'pipeline_1118_1119', 'final_offer', 'rps_tracking',
         'delivery_roles_rps'
       ]::text[])
  ) then
    raise exception 'hydration artifacts contain an unknown key';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 86400 then
    raise exception 'hydration lease must be between 60 and 86400 seconds';
  end if;

  insert into recruiting_ops_hydration_runs (
    dedupe_key, business_date, mode, requested_artifacts
  ) values (
    p_dedupe_key, p_business_date, p_mode, p_requested_artifacts
  )
  on conflict (dedupe_key) do nothing;

  select * into existing
    from recruiting_ops_hydration_runs r
   where r.dedupe_key = p_dedupe_key;

  if existing.business_date <> p_business_date
     or existing.mode <> p_mode
     or existing.requested_artifacts <> p_requested_artifacts then
    raise exception 'hydration dedupe key conflicts with different immutable inputs';
  end if;

  -- A bound claim is valid only inside the replay-payload retention window.
  -- The shared source-row lock serializes retry/reclaim with pruning.
  if existing.source_execution_id is not null
     and (
       (
         existing.status = 'terminal'
         and existing.outcome in ('partial', 'failed', 'timed_out')
       )
       or (
         existing.status <> 'terminal'
         and (
           existing.owner_token = p_owner_token
           or existing.leased_until is null
           or existing.leased_until < now()
         )
       )
     ) then
    select source.source_execution_id into locked_source_execution_id
    from recruiting_ops_source_executions source
    where source.source_execution_id = existing.source_execution_id
      and source.status = 'completed'
      and source.source_fingerprint = existing.source_fingerprint
      and source.source_generated_at = existing.source_generated_at
      and source.source_payload is not null
      and jsonb_typeof(source.source_payload) = 'object'
      and source.source_payload_schema_version is not null
      and source.source_payload_schema_version > 0
      and source.source_payload_checksum ~ '^sha256:[0-9a-f]{64}$'
      and source.source_payload_pruned_at is null
    for share;
    if not found then
      select * into existing
        from recruiting_ops_hydration_runs r
       where r.run_id = existing.run_id;
      return query select existing.run_id, false, existing.status, existing.outcome,
        existing.source_execution_id, existing.source_fingerprint, existing.source_generated_at;
      return;
    end if;
  end if;

  update recruiting_ops_hydration_runs r
     set owner_token = p_owner_token,
         leased_until = now() + make_interval(secs => p_lease_seconds),
         claim_count = r.claim_count + 1,
         status = case
           when r.status = 'queued' then 'loading_source'
           when r.status = 'terminal' and r.source_execution_id is null then 'loading_source'
           when r.status = 'terminal' then 'running'
           else r.status
         end,
         outcome = case when r.status = 'terminal' then null else r.outcome end,
         completed_at = case when r.status = 'terminal' then null else r.completed_at end,
         public_summary = case when r.status = 'terminal' then null else r.public_summary end,
         started_at = coalesce(r.started_at, now()),
         updated_at = now()
   where r.run_id = existing.run_id
     and (r.status <> 'terminal' or r.outcome in ('partial', 'failed', 'timed_out'))
     and (r.owner_token = p_owner_token or r.leased_until is null or r.leased_until < now())
   returning r.* into claimed;

  if found then
    return query select claimed.run_id, true, claimed.status, claimed.outcome,
      claimed.source_execution_id, claimed.source_fingerprint, claimed.source_generated_at;
  else
    return query select existing.run_id, false, existing.status, existing.outcome,
      existing.source_execution_id, existing.source_fingerprint, existing.source_generated_at;
  end if;
end;
$$;

create or replace function guard_recruiting_ops_hydration_run_update()
returns trigger language plpgsql as $$
begin
  if old.dedupe_key <> new.dedupe_key
     or old.business_date <> new.business_date
     or old.mode <> new.mode
     or old.requested_artifacts <> new.requested_artifacts then
    raise exception 'hydration run immutable inputs cannot change';
  end if;
  if old.source_execution_id is not null and (
    old.source_execution_id is distinct from new.source_execution_id
    or old.source_fingerprint is distinct from new.source_fingerprint
    or old.source_generated_at is distinct from new.source_generated_at
  ) then
    raise exception 'hydration run source identity cannot change';
  end if;
  if old.status = 'terminal' and not (
    old.outcome in ('partial', 'failed', 'timed_out')
    and new.status in ('loading_source', 'running')
    and new.outcome is null
    and new.completed_at is null
  ) then
    raise exception 'terminal hydration run cannot change';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_recruiting_ops_hydration_run_update
  on recruiting_ops_hydration_runs;
create trigger trg_guard_recruiting_ops_hydration_run_update
before update on recruiting_ops_hydration_runs
for each row execute function guard_recruiting_ops_hydration_run_update();

create or replace function guard_recruiting_ops_hydration_attempt_update()
returns trigger language plpgsql as $$
begin
  if old.run_id <> new.run_id
     or old.artifact_key <> new.artifact_key
     or old.attempt_no <> new.attempt_no
     or old.source_execution_id <> new.source_execution_id
     or old.source_fingerprint <> new.source_fingerprint then
    raise exception 'hydration artifact attempt identity cannot change';
  end if;
  if old.status = 'terminal' then
    raise exception 'terminal hydration artifact attempt cannot change';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_recruiting_ops_hydration_attempt_update
  on recruiting_ops_hydration_artifact_attempts;
create trigger trg_guard_recruiting_ops_hydration_attempt_update
before update on recruiting_ops_hydration_artifact_attempts
for each row execute function guard_recruiting_ops_hydration_attempt_update();

create or replace function bind_recruiting_ops_hydration_run_source(
  p_run_id uuid,
  p_owner_token uuid,
  p_source_execution_id uuid,
  p_source_fingerprint text,
  p_source_generated_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
  locked_source_execution_id uuid;
begin
  if p_run_id is null or p_owner_token is null or p_source_execution_id is null
     or p_source_generated_at is null
     or p_source_fingerprint is null
     or p_source_fingerprint !~ '^hmac-sha256:[0-9a-f]{64}$' then
    raise exception 'complete hydration source identity is required';
  end if;

  -- Hold the replay row through binding so pruning either happens first and
  -- makes this return false, or skips this source while the run becomes active.
  select source.source_execution_id into locked_source_execution_id
  from recruiting_ops_source_executions source
  where source.source_execution_id = p_source_execution_id
    and source.status = 'completed'
    and source.source_fingerprint = p_source_fingerprint
    and source.source_generated_at = p_source_generated_at
    and source.source_payload is not null
    and jsonb_typeof(source.source_payload) = 'object'
    and source.source_payload_schema_version is not null
    and source.source_payload_schema_version > 0
    and source.source_payload_checksum ~ '^sha256:[0-9a-f]{64}$'
    and source.source_payload_pruned_at is null
  for share;
  if not found then
    return false;
  end if;

  update recruiting_ops_hydration_runs r
     set source_execution_id = p_source_execution_id,
         source_fingerprint = p_source_fingerprint,
         source_generated_at = p_source_generated_at,
         status = 'running',
         updated_at = now()
   where r.run_id = p_run_id
     and r.owner_token = p_owner_token
     and r.leased_until > now()
     and r.status = 'loading_source'
     and r.source_execution_id is null;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function start_recruiting_ops_hydration_artifact_attempt(
  p_attempt_id uuid,
  p_run_id uuid,
  p_owner_token uuid,
  p_artifact_key text,
  p_attempt_no integer,
  p_source_execution_id uuid,
  p_source_fingerprint text,
  p_started_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
  locked_source_execution_id uuid;
begin
  if p_attempt_id is null or p_run_id is null or p_owner_token is null
     or coalesce(trim(p_artifact_key), '') = '' or p_attempt_no <= 0
     or p_source_execution_id is null or p_started_at is null
     or p_source_fingerprint is null
     or p_source_fingerprint !~ '^hmac-sha256:[0-9a-f]{64}$' then
    raise exception 'complete hydration attempt identity is required';
  end if;

  -- Source-first locking matches bind/reclaim/prune, preventing a retention
  -- cleanup from racing an attempt into existence against a discarded cut.
  select source.source_execution_id into locked_source_execution_id
  from recruiting_ops_source_executions source
  where source.source_execution_id = p_source_execution_id
    and source.status = 'completed'
    and source.source_fingerprint = p_source_fingerprint
    and source.source_payload is not null
    and jsonb_typeof(source.source_payload) = 'object'
    and source.source_payload_schema_version is not null
    and source.source_payload_schema_version > 0
    and source.source_payload_checksum ~ '^sha256:[0-9a-f]{64}$'
    and source.source_payload_pruned_at is null
  for share;
  if not found then
    return false;
  end if;

  insert into recruiting_ops_hydration_artifact_attempts (
    attempt_id, run_id, artifact_key, attempt_no, source_execution_id,
    source_fingerprint, started_at
  )
  select p_attempt_id, r.run_id, p_artifact_key, p_attempt_no,
         p_source_execution_id, p_source_fingerprint, p_started_at
    from recruiting_ops_hydration_runs r
   where r.run_id = p_run_id
     and r.owner_token = p_owner_token
     and r.status = 'running'
     and r.leased_until > now()
     and r.source_execution_id = p_source_execution_id
     and r.source_fingerprint = p_source_fingerprint
     and p_artifact_key = any(r.requested_artifacts)
     and p_attempt_no = 1 + coalesce((
       select max(a.attempt_no)
       from recruiting_ops_hydration_artifact_attempts a
       where a.run_id = r.run_id and a.artifact_key = p_artifact_key
     ), 0)
     and not exists (
       select 1
       from recruiting_ops_hydration_artifact_attempts a
       where a.run_id = r.run_id
         and a.artifact_key = p_artifact_key
         and a.status = 'terminal'
         and a.outcome in ('written', 'no_change')
         and a.certification_evidence is not null
     )
  for update of r
  on conflict do nothing;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function timeout_recruiting_ops_hydration_artifact_attempts(
  p_run_id uuid,
  p_owner_token uuid,
  p_completed_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  if p_run_id is null or p_owner_token is null or p_completed_at is null then
    raise exception 'hydration timeout identity is required';
  end if;
  update recruiting_ops_hydration_artifact_attempts a
     set status = 'terminal', outcome = 'timed_out', completed_at = p_completed_at
   where a.run_id = p_run_id
     and a.status = 'running'
     and exists (
       select 1
       from recruiting_ops_hydration_runs r
       where r.run_id = a.run_id
         and r.owner_token = p_owner_token
         and r.status = 'running'
         and r.leased_until > now()
         and r.source_execution_id = a.source_execution_id
         and r.source_fingerprint = a.source_fingerprint
     );
  get diagnostics changed = row_count;
  return changed;
end;
$$;

create or replace function finish_recruiting_ops_hydration_artifact_attempt(
  p_attempt_id uuid,
  p_run_id uuid,
  p_owner_token uuid,
  p_outcome text,
  p_completed_at timestamptz,
  p_plan_fingerprint text,
  p_mutation_call_count integer,
  p_version_before text,
  p_version_after text,
  p_certification_evidence jsonb,
  p_failure_code text,
  p_failure_stage text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  if p_attempt_id is null or p_run_id is null or p_owner_token is null
     or p_completed_at is null or p_outcome is null
     or p_outcome not in ('written', 'no_change', 'failed', 'timed_out', 'certification_failed')
     or (p_mutation_call_count is not null and p_mutation_call_count < 0) then
    raise exception 'valid hydration attempt completion is required';
  end if;
  if p_outcome in ('written', 'no_change') and (
    p_certification_evidence is null
    or jsonb_typeof(p_certification_evidence) <> 'object'
    or p_certification_evidence = '{}'::jsonb
    or jsonb_typeof(p_certification_evidence -> 'artifact_status') <> 'string'
    or p_plan_fingerprint is null
    or p_plan_fingerprint !~ '^hmac-sha256:[0-9a-f]{64}$'
  ) then
    raise exception 'successful hydration attempts require certification evidence';
  end if;
  if p_outcome = 'written' and (
    coalesce(p_mutation_call_count, 0) <= 0
    or p_version_before is null
    or p_version_after is null
  ) then
    raise exception 'written hydration attempts require mutation and version evidence';
  end if;
  if p_outcome = 'no_change' and coalesce(p_mutation_call_count, 0) <> 0 then
    raise exception 'no-change hydration attempts cannot record mutations';
  end if;

  update recruiting_ops_hydration_artifact_attempts a
     set status = 'terminal',
         outcome = p_outcome,
         completed_at = p_completed_at,
         plan_fingerprint = p_plan_fingerprint,
         mutation_call_count = p_mutation_call_count,
         version_before = p_version_before,
         version_after = p_version_after,
         certification_evidence = p_certification_evidence,
         failure_code = p_failure_code,
         failure_stage = p_failure_stage
   where a.attempt_id = p_attempt_id
     and a.run_id = p_run_id
     and a.status = 'running'
     and exists (
       select 1
       from recruiting_ops_hydration_runs r
       where r.run_id = a.run_id
         and r.owner_token = p_owner_token
         and r.status = 'running'
         and r.leased_until > now()
         and r.source_execution_id = a.source_execution_id
         and r.source_fingerprint = a.source_fingerprint
     );
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function finish_recruiting_ops_hydration_run(
  p_run_id uuid,
  p_owner_token uuid,
  p_outcome text,
  p_completed_at timestamptz,
  p_public_summary jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
  active_run recruiting_ops_hydration_runs%rowtype;
  requested_count integer;
  latest_count integer;
  completed_count integer;
  written_count integer;
  timed_out_count integer;
  expected_outcome text;
begin
  if p_run_id is null or p_owner_token is null or p_completed_at is null
     or p_outcome is null
     or p_outcome not in ('succeeded', 'no_change', 'partial', 'failed', 'timed_out')
     or p_public_summary is null or jsonb_typeof(p_public_summary) <> 'object' then
    raise exception 'valid hydration run completion is required';
  end if;

  select * into active_run
  from recruiting_ops_hydration_runs r
  where r.run_id = p_run_id
    and r.owner_token = p_owner_token
    and r.status <> 'terminal'
    and r.leased_until > now()
  for update;
  if not found then
    return false;
  end if;
  if exists (
    select 1 from recruiting_ops_hydration_artifact_attempts a
    where a.run_id = p_run_id and a.status = 'running'
  ) then
    raise exception 'hydration run cannot finish with a running artifact attempt';
  end if;

  requested_count := cardinality(active_run.requested_artifacts);
  with latest as (
    select distinct on (a.artifact_key) a.artifact_key, a.outcome,
           a.plan_fingerprint, a.certification_evidence
    from recruiting_ops_hydration_artifact_attempts a
    where a.run_id = p_run_id
      and a.artifact_key = any(active_run.requested_artifacts)
      and a.status = 'terminal'
    order by a.artifact_key, a.attempt_no desc
  )
  select count(*),
         count(*) filter (
           where outcome in ('written', 'no_change')
             and certification_evidence is not null
             and jsonb_typeof(certification_evidence) = 'object'
             and certification_evidence <> '{}'::jsonb
             and jsonb_typeof(certification_evidence -> 'artifact_status') = 'string'
             and plan_fingerprint ~ '^hmac-sha256:[0-9a-f]{64}$'
         ),
         count(*) filter (where outcome = 'written'),
         count(*) filter (where outcome = 'timed_out')
    into latest_count, completed_count, written_count, timed_out_count
    from latest;

  expected_outcome := case
    when completed_count = requested_count and written_count > 0 then 'succeeded'
    when completed_count = requested_count then 'no_change'
    when completed_count > 0 then 'partial'
    when timed_out_count > 0 then 'timed_out'
    else 'failed'
  end;
  if p_outcome <> expected_outcome then
    raise exception 'hydration run outcome does not match durable artifact attempts';
  end if;
  if expected_outcome <> 'failed' and (
    active_run.source_execution_id is null
    or active_run.source_fingerprint is null
    or active_run.source_generated_at is null
  ) then
    raise exception 'non-failed hydration run requires a bound source cut';
  end if;
  if latest_count > 0 and active_run.source_execution_id is null then
    raise exception 'hydration artifact attempts require a bound source cut';
  end if;

  update recruiting_ops_hydration_runs r
     set status = 'terminal', outcome = p_outcome, completed_at = p_completed_at,
         leased_until = null, public_summary = p_public_summary,
         updated_at = p_completed_at
   where r.run_id = p_run_id
     and r.owner_token = p_owner_token;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

alter table recruiting_ops_hydration_runs enable row level security;
alter table recruiting_ops_hydration_artifact_attempts enable row level security;

revoke all on table recruiting_ops_hydration_runs from public;
revoke all on table recruiting_ops_hydration_artifact_attempts from public;

do $$
declare
  role_name text;
  function_signature text;
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on table recruiting_ops_hydration_runs from %I', role_name);
      execute format('revoke all on table recruiting_ops_hydration_artifact_attempts from %I', role_name);
    end if;
  end loop;

  for function_signature in
    select format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'claim_recruiting_ops_hydration_run',
        'bind_recruiting_ops_hydration_run_source',
        'start_recruiting_ops_hydration_artifact_attempt',
        'timeout_recruiting_ops_hydration_artifact_attempts',
        'finish_recruiting_ops_hydration_artifact_attempt',
        'finish_recruiting_ops_hydration_run',
        'prune_recruiting_ops_source_execution_payloads'
      )
  loop
    execute format('revoke all on function %s from public', function_signature);
    foreach role_name in array array['anon', 'authenticated', 'service_role']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on function %s from %I', function_signature, role_name);
      end if;
    end loop;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on table recruiting_ops_hydration_runs to service_role;
    grant select on table recruiting_ops_hydration_artifact_attempts to service_role;
    grant execute on function claim_recruiting_ops_hydration_run(text, date, text, text[], uuid, integer) to service_role;
    grant execute on function bind_recruiting_ops_hydration_run_source(uuid, uuid, uuid, text, timestamptz) to service_role;
    grant execute on function start_recruiting_ops_hydration_artifact_attempt(uuid, uuid, uuid, text, integer, uuid, text, timestamptz) to service_role;
    grant execute on function timeout_recruiting_ops_hydration_artifact_attempts(uuid, uuid, timestamptz) to service_role;
    grant execute on function finish_recruiting_ops_hydration_artifact_attempt(uuid, uuid, uuid, text, timestamptz, text, integer, text, text, jsonb, text, text) to service_role;
    grant execute on function finish_recruiting_ops_hydration_run(uuid, uuid, text, timestamptz, jsonb) to service_role;
  end if;
end $$;

commit;
