-- 026 — Serialize hydration claims across every dedupe key.
--
-- The unique index is the durable invariant. The transaction advisory lock
-- lets the existing claim RPC reject overlap without surfacing a unique-index
-- error, and lets one claim retire an expired different-dedupe run atomically.

begin;

-- Replace a same-named legacy or partial experiment instead of trusting its
-- shape. If live data already contains multiple active runs, the exact unique
-- index fails atomically and leaves the prior index/data untouched.
drop index if exists public.idx_recops_hydration_run_one_active;
create unique index idx_recops_hydration_run_one_active
  on public.recruiting_ops_hydration_runs ((1))
  where status <> 'terminal';

create or replace function public.claim_recruiting_ops_hydration_run(
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
set search_path = public, pg_temp
as $$
declare
  requested_run public.recruiting_ops_hydration_runs%rowtype;
  active_run public.recruiting_ops_hydration_runs%rowtype;
  claimed public.recruiting_ops_hydration_runs%rowtype;
  locked_source_execution_id uuid;
  observed_source_execution_id uuid;
  requested_run_id uuid;
  active_run_id uuid;
  requested_run_found boolean := false;
  active_run_found boolean := false;
  changed integer := 0;
  recovered_at timestamptz := now();
  requested_count integer := 0;
  latest_count integer := 0;
  completed_count integer := 0;
  written_count integer := 0;
  timed_out_count integer := 0;
  recovered_outcome text;
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

  -- Claims are one-statement transactions through PostgREST, so this is
  -- pooler-safe. Only claimers take this lock; source/prune paths never wait on
  -- it, which keeps the row-lock graph acyclic.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public.recruiting_ops_hydration_runs:global_claim', 0)
  );

  select r.* into requested_run
  from public.recruiting_ops_hydration_runs r
  where r.dedupe_key = p_dedupe_key;
  requested_run_found := found;
  if requested_run_found then
    requested_run_id := requested_run.run_id;
  end if;

  if requested_run_found and (
    requested_run.business_date <> p_business_date
    or requested_run.mode <> p_mode
    or requested_run.requested_artifacts <> p_requested_artifacts
  ) then
    raise exception 'hydration dedupe key conflicts with different immutable inputs';
  end if;

  -- Completed success is an idempotent replay and needs no global lease.
  if requested_run_found
     and requested_run.status = 'terminal'
     and requested_run.outcome in ('succeeded', 'no_change') then
    return query select requested_run.run_id, false, requested_run.status,
      requested_run.outcome, requested_run.source_execution_id,
      requested_run.source_fingerprint, requested_run.source_generated_at;
    return;
  end if;

  select r.* into active_run
  from public.recruiting_ops_hydration_runs r
  where r.status <> 'terminal';
  active_run_found := found;
  if active_run_found then
    active_run_id := active_run.run_id;
  end if;

  if active_run_found and active_run.dedupe_key <> p_dedupe_key then
    loop
      if active_run.leased_until > recovered_at then
        return query select active_run.run_id, false, active_run.status,
          active_run.outcome, active_run.source_execution_id,
          active_run.source_fingerprint, active_run.source_generated_at;
        return;
      end if;

      observed_source_execution_id := active_run.source_execution_id;

      -- Lock the source before attempts and the run, exactly like retention
      -- pruning. NO KEY UPDATE blocks prune/bind/start while remaining
      -- compatible with finish_run's foreign-key key-share check.
      if observed_source_execution_id is not null then
        select source.source_execution_id into locked_source_execution_id
        from public.recruiting_ops_source_executions source
        where source.source_execution_id = observed_source_execution_id
        for no key update;
        if not found then
          raise exception 'active hydration run source execution is missing';
        end if;
      end if;

      select r.* into active_run
      from public.recruiting_ops_hydration_runs r
      where r.run_id = active_run_id
        and r.status <> 'terminal';
      active_run_found := found;
      if not active_run_found then
        exit;
      end if;
      if active_run.source_execution_id is distinct from observed_source_execution_id then
        continue;
      end if;
      if active_run.leased_until > recovered_at then
        return query select active_run.run_id, false, active_run.status,
          active_run.outcome, active_run.source_execution_id,
          active_run.source_fingerprint, active_run.source_generated_at;
        return;
      end if;

      update public.recruiting_ops_hydration_artifact_attempts attempt
      set status = 'terminal',
          outcome = 'timed_out',
          completed_at = recovered_at,
          failure_code = 'hydration_run_lease_expired',
          failure_stage = 'claim_recovery'
      where attempt.run_id = active_run_id
        and attempt.status = 'running';

      requested_count := cardinality(active_run.requested_artifacts);
      with latest as (
        select distinct on (attempt.artifact_key)
          attempt.artifact_key,
          attempt.outcome,
          attempt.plan_fingerprint,
          attempt.certification_evidence
        from public.recruiting_ops_hydration_artifact_attempts attempt
        where attempt.run_id = active_run_id
          and attempt.artifact_key = any(active_run.requested_artifacts)
          and attempt.status = 'terminal'
        order by attempt.artifact_key, attempt.attempt_no desc
      )
      select count(*),
             count(*) filter (
               where latest.outcome in ('written', 'no_change')
                 and latest.certification_evidence is not null
                 and jsonb_typeof(latest.certification_evidence) = 'object'
                 and latest.certification_evidence <> '{}'::jsonb
                 and jsonb_typeof(latest.certification_evidence -> 'artifact_status') = 'string'
                 and latest.plan_fingerprint ~ '^hmac-sha256:[0-9a-f]{64}$'
             ),
             count(*) filter (where latest.outcome = 'written'),
             count(*) filter (where latest.outcome = 'timed_out')
      into latest_count, completed_count, written_count, timed_out_count
      from latest;

      recovered_outcome := case
        when completed_count = requested_count and written_count > 0 then 'succeeded'
        when completed_count = requested_count then 'no_change'
        when completed_count > 0 then 'partial'
        when latest_count = 0 then 'timed_out'
        when timed_out_count > 0 then 'timed_out'
        else 'failed'
      end;

      update public.recruiting_ops_hydration_runs r
      set status = 'terminal',
          outcome = recovered_outcome,
          completed_at = recovered_at,
          leased_until = null,
          public_summary = jsonb_build_object(
            'failure_code', 'hydration_run_lease_expired',
            'failure_stage', 'claim_recovery',
            'requested_artifact_count', requested_count,
            'latest_artifact_count', latest_count,
            'certified_artifact_count', completed_count,
            'timed_out_artifact_count', timed_out_count
          ),
          updated_at = recovered_at
      where r.run_id = active_run_id
        and r.status <> 'terminal'
        and r.source_execution_id is not distinct from observed_source_execution_id
        and (r.leased_until is null or r.leased_until <= recovered_at);
      get diagnostics changed = row_count;

      if changed = 1 then
        exit;
      end if;

      select r.* into active_run
      from public.recruiting_ops_hydration_runs r
      where r.run_id = active_run_id
        and r.status <> 'terminal';
      active_run_found := found;
      if not active_run_found then
        exit;
      end if;
    end loop;
  end if;

  if not requested_run_found then
    insert into public.recruiting_ops_hydration_runs as r (
      dedupe_key, business_date, mode, requested_artifacts
    ) values (
      p_dedupe_key, p_business_date, p_mode, p_requested_artifacts
    )
    on conflict do nothing
    returning r.* into requested_run;
    requested_run_found := found;
    if requested_run_found then
      requested_run_id := requested_run.run_id;
    end if;

    if not requested_run_found then
      select r.* into active_run
      from public.recruiting_ops_hydration_runs r
      where r.status <> 'terminal';
      if found then
        return query select active_run.run_id, false, active_run.status,
          active_run.outcome, active_run.source_execution_id,
          active_run.source_fingerprint, active_run.source_generated_at;
        return;
      end if;

      select r.* into requested_run
      from public.recruiting_ops_hydration_runs r
      where r.dedupe_key = p_dedupe_key;
      requested_run_found := found;
      if not requested_run_found then
        raise exception 'hydration run claim could not resolve its durable row';
      end if;
      requested_run_id := requested_run.run_id;
    end if;
  end if;

  if requested_run.status <> 'terminal'
     and requested_run.owner_token is distinct from p_owner_token
     and requested_run.leased_until > recovered_at then
    return query select requested_run.run_id, false, requested_run.status,
      requested_run.outcome, requested_run.source_execution_id,
      requested_run.source_fingerprint, requested_run.source_generated_at;
    return;
  end if;

  if requested_run.source_execution_id is not null then
    select source.source_execution_id into locked_source_execution_id
    from public.recruiting_ops_source_executions source
    where source.source_execution_id = requested_run.source_execution_id
      and source.status = 'completed'
      and source.source_fingerprint = requested_run.source_fingerprint
      and source.source_generated_at = requested_run.source_generated_at
      and source.source_payload is not null
      and jsonb_typeof(source.source_payload) = 'object'
      and source.source_payload_schema_version is not null
      and source.source_payload_schema_version > 0
      and source.source_payload_checksum ~ '^sha256:[0-9a-f]{64}$'
      and source.source_payload_pruned_at is null
    for share;
    if not found then
      select r.* into requested_run
      from public.recruiting_ops_hydration_runs r
      where r.run_id = requested_run_id;
      return query select requested_run.run_id, false, requested_run.status,
        requested_run.outcome, requested_run.source_execution_id,
        requested_run.source_fingerprint, requested_run.source_generated_at;
      return;
    end if;
  end if;

  update public.recruiting_ops_hydration_runs r
  set owner_token = p_owner_token,
      leased_until = recovered_at + make_interval(secs => p_lease_seconds),
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
      started_at = coalesce(r.started_at, recovered_at),
      updated_at = recovered_at
  where r.run_id = requested_run_id
    and (r.status <> 'terminal' or r.outcome in ('partial', 'failed', 'timed_out'))
    and (r.owner_token = p_owner_token or r.leased_until is null or r.leased_until <= recovered_at)
  returning r.* into claimed;

  if found then
    return query select claimed.run_id, true, claimed.status, claimed.outcome,
      claimed.source_execution_id, claimed.source_fingerprint, claimed.source_generated_at;
  else
    select r.* into requested_run
    from public.recruiting_ops_hydration_runs r
    where r.run_id = requested_run_id;
    return query select requested_run.run_id, false, requested_run.status,
      requested_run.outcome, requested_run.source_execution_id,
      requested_run.source_fingerprint, requested_run.source_generated_at;
  end if;
end;
$$;

-- Normal owned timeout records only non-sensitive failure vocabulary while
-- leaving plan, mutation, version, and certification evidence untouched.
create or replace function public.timeout_recruiting_ops_hydration_artifact_attempts(
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

  update public.recruiting_ops_hydration_artifact_attempts attempt
  set status = 'terminal',
      outcome = 'timed_out',
      completed_at = p_completed_at,
      failure_code = 'hydration_attempt_timed_out',
      failure_stage = 'orchestration_recovery'
  where attempt.run_id = p_run_id
    and attempt.status = 'running'
    and exists (
      select 1
      from public.recruiting_ops_hydration_runs r
      where r.run_id = attempt.run_id
        and r.owner_token = p_owner_token
        and r.status = 'running'
        and r.leased_until > now()
        and r.source_execution_id = attempt.source_execution_id
        and r.source_fingerprint = attempt.source_fingerprint
    );
  get diagnostics changed = row_count;
  return changed;
end;
$$;

do $$
declare
  role_name text;
begin
  revoke all on function public.claim_recruiting_ops_hydration_run(
    text, date, text, text[], uuid, integer
  ) from public;
  revoke all on function public.timeout_recruiting_ops_hydration_artifact_attempts(
    uuid, uuid, timestamptz
  ) from public;

  foreach role_name in array array['anon', 'authenticated', 'service_role']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'revoke all on function public.claim_recruiting_ops_hydration_run(text, date, text, text[], uuid, integer) from %I',
        role_name
      );
      execute format(
        'revoke all on function public.timeout_recruiting_ops_hydration_artifact_attempts(uuid, uuid, timestamptz) from %I',
        role_name
      );
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_recruiting_ops_hydration_run(
      text, date, text, text[], uuid, integer
    ) to service_role;
    grant execute on function public.timeout_recruiting_ops_hydration_artifact_attempts(
      uuid, uuid, timestamptz
    ) to service_role;
  end if;
end $$;

commit;
