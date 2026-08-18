-- 030 — Liveness-based leases for hydration runs and source executions.
--
-- A lease used to be a fixed one-hour timer: a crashed container held its run
-- and source rows until the timer ran out, and Cloud Run task retries kept
-- re-arming it through fresh claims. Every later run then failed
-- overlap_in_progress against a process that no longer existed.
--
-- The fix is to make lease lifetime mean process liveness. Claims now use a
-- short lease and a live orchestrator renews it every minute through these
-- heartbeat functions. A dead process stops renewing, the short lease expires
-- within minutes, and the existing claim recovery (026) retires or reclaims
-- the run with no human involvement.
--
-- A heartbeat can only extend a lease that is still held: renewal requires the
-- exact owner and an unexpired lease. Once a lease lapses the only way back is
-- a full claim, which serializes against recovery through the advisory lock.

begin;

create or replace function public.heartbeat_recruiting_ops_hydration_run(
  p_run_id uuid,
  p_owner_token uuid,
  p_lease_seconds integer default 600
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  if p_run_id is null or p_owner_token is null then
    raise exception 'hydration heartbeat identity is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 7200 then
    raise exception 'hydration heartbeat lease must be between 60 and 7200 seconds';
  end if;

  update public.recruiting_ops_hydration_runs r
     set leased_until = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where r.run_id = p_run_id
     and r.owner_token = p_owner_token
     and r.status <> 'terminal'
     and r.leased_until > now();
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function public.heartbeat_recruiting_ops_source_execution(
  p_source_execution_id uuid,
  p_owner_token uuid,
  p_lease_seconds integer default 600
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  if p_source_execution_id is null or p_owner_token is null then
    raise exception 'source execution heartbeat identity is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 7200 then
    raise exception 'source execution heartbeat lease must be between 60 and 7200 seconds';
  end if;

  update public.recruiting_ops_source_executions e
     set leased_until = now() + make_interval(secs => p_lease_seconds)
   where e.source_execution_id = p_source_execution_id
     and e.owner_token = p_owner_token
     and e.status = 'running'
     and e.leased_until > now();
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

do $$
declare
  role_name text;
  function_signature text;
begin
  for function_signature in
    select format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'heartbeat_recruiting_ops_hydration_run',
        'heartbeat_recruiting_ops_source_execution'
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
    grant execute on function public.heartbeat_recruiting_ops_hydration_run(uuid, uuid, integer)
      to service_role;
    grant execute on function public.heartbeat_recruiting_ops_source_execution(uuid, uuid, integer)
      to service_role;
  end if;
end $$;

commit;
