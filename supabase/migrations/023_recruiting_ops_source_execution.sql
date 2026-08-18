-- 023 — Adopt the orphaned reporting source-execution proof as a replayable cut.
--
-- A partial unique index is the cross-process mutex. Claim, stale-lease reap,
-- completion, and failure each happen in one database transaction, so this is
-- safe behind Supabase transaction pooling (no session advisory lock).

begin;

create table if not exists public.recruiting_ops_source_executions (
  source_execution_id uuid primary key,
  owner_token uuid not null,
  status text not null default 'running',
  acquired_at timestamptz not null default now(),
  leased_until timestamptz not null,
  completed_at timestamptz,
  source_generated_at timestamptz,
  source_fingerprint text,
  source_counts jsonb,
  public_diagnostics jsonb not null default '{}'::jsonb,
  source_payload jsonb,
  source_payload_schema_version integer,
  source_payload_checksum text,
  source_payload_pruned_at timestamptz
);

-- The remote orphan predates these replay fields. Keep its completed metadata
-- row intact; every completion through the new RPC must provide all three.
alter table public.recruiting_ops_source_executions
  add column if not exists source_payload jsonb,
  add column if not exists source_payload_schema_version integer,
  add column if not exists source_payload_checksum text,
  add column if not exists source_payload_pruned_at timestamptz;

update public.recruiting_ops_source_executions
set public_diagnostics = '{}'::jsonb
where public_diagnostics is null;

alter table public.recruiting_ops_source_executions
  alter column public_diagnostics set default '{}'::jsonb,
  alter column public_diagnostics set not null;

-- Replace any orphaned status CHECK without guessing its generated name.
do $$
declare
  constraint_name name;
begin
  for constraint_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.recruiting_ops_source_executions'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~* '\mstatus\M'
  loop
    execute format(
      'alter table public.recruiting_ops_source_executions drop constraint %I',
      constraint_name
    );
  end loop;
end $$;

alter table public.recruiting_ops_source_executions
  add constraint recruiting_ops_source_execution_status_check
    check (status in ('running', 'completed', 'failed')),
  add constraint recruiting_ops_source_execution_completed_payload_check
    check (
      status <> 'completed'
      or (
        completed_at is not null
        and source_fingerprint is not null
        and source_generated_at is not null
        and source_fingerprint ~ '^hmac-sha256:[0-9a-f]{64}$'
        and source_counts is not null
        and jsonb_typeof(source_counts) = 'object'
        and (
          (
            source_payload is not null
            and jsonb_typeof(source_payload) = 'object'
            and source_payload_schema_version is not null
            and source_payload_schema_version > 0
            and source_payload_checksum is not null
            and source_payload_checksum ~ '^sha256:[0-9a-f]{64}$'
            and source_payload_pruned_at is null
          )
          or
          (
            source_payload is null
            and source_payload_schema_version is null
            and source_payload_checksum is null
            and source_payload_pruned_at is not null
          )
        )
      )
    ) not valid;

-- One active reporting source load across every process using this store.
create unique index if not exists idx_recruiting_ops_source_execution_active
  on public.recruiting_ops_source_executions ((1))
  where status = 'running';

create or replace function public.reap_stale_recruiting_ops_source_execution_leases()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reaped integer;
begin
  update public.recruiting_ops_source_executions
  set status = 'failed',
      leased_until = now(),
      public_diagnostics = coalesce(public_diagnostics, '{}'::jsonb)
        || jsonb_build_object(
          'failure_code', 'lease_expired',
          'lease_reaped_at', now()
        )
  where status = 'running'
    and leased_until <= now();

  get diagnostics reaped = row_count;
  return reaped;
end;
$$;

-- Return type on the unmanaged remote functions was not introspectable through
-- PostgREST. Drop only those two exact orphan signatures, then recreate them.
drop function if exists public.acquire_recruiting_ops_source_execution(uuid, uuid, integer);
drop function if exists public.complete_recruiting_ops_source_execution(
  uuid,
  uuid,
  timestamptz,
  text,
  jsonb,
  jsonb
);

create function public.acquire_recruiting_ops_source_execution(
  p_source_execution_id uuid,
  p_owner_token uuid,
  p_lease_seconds integer default 3600
)
returns setof public.recruiting_ops_source_executions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_source_execution_id is null or p_owner_token is null then
    raise exception 'source execution id and owner token are required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 7200 then
    raise exception 'source execution lease must be between 60 and 7200 seconds';
  end if;

  -- A response-lost retry by the same owner recovers the existing lease.
  return query
  select execution.*
  from public.recruiting_ops_source_executions execution
  where execution.source_execution_id = p_source_execution_id
    and execution.owner_token = p_owner_token
    and execution.status = 'running'
    and execution.leased_until > now();
  if found then
    return;
  end if;

  perform public.reap_stale_recruiting_ops_source_execution_leases();

  -- A failed deterministic execution ID is retryable. The active partial
  -- index still rejects a reclaim when another source load owns the mutex.
  begin
    return query
    update public.recruiting_ops_source_executions as execution
    set owner_token = p_owner_token,
        status = 'running',
        acquired_at = now(),
        leased_until = now() + make_interval(secs => p_lease_seconds),
        completed_at = null,
        source_generated_at = null,
        source_fingerprint = null,
        source_counts = null,
        public_diagnostics = '{}'::jsonb,
        source_payload = null,
        source_payload_schema_version = null,
        source_payload_checksum = null,
        source_payload_pruned_at = null
    where execution.source_execution_id = p_source_execution_id
      and execution.status = 'failed'
    returning execution.*;
    if found then
      return;
    end if;
  exception
    when unique_violation then
      return;
  end;

  -- ON CONFLICT covers both the execution PK and the one-active-lease index.
  return query
  insert into public.recruiting_ops_source_executions as execution (
    source_execution_id,
    owner_token,
    status,
    acquired_at,
    leased_until,
    public_diagnostics
  ) values (
    p_source_execution_id,
    p_owner_token,
    'running',
    now(),
    now() + make_interval(secs => p_lease_seconds),
    '{}'::jsonb
  )
  on conflict do nothing
  returning execution.*;
end;
$$;

-- Keep the old metadata-only signature fail-closed so an old caller cannot
-- create another completed-but-unreplayable row.
create function public.complete_recruiting_ops_source_execution(
  p_source_execution_id uuid,
  p_owner_token uuid,
  p_source_generated_at timestamptz,
  p_source_fingerprint text,
  p_source_counts jsonb,
  p_public_diagnostics jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'source payload, schema version, and checksum are required';
end;
$$;

create or replace function public.complete_recruiting_ops_source_execution(
  p_source_execution_id uuid,
  p_owner_token uuid,
  p_source_generated_at timestamptz,
  p_source_fingerprint text,
  p_source_counts jsonb,
  p_public_diagnostics jsonb,
  p_source_payload jsonb,
  p_source_payload_schema_version integer,
  p_source_payload_checksum text
)
returns setof public.recruiting_ops_source_executions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_source_generated_at is null then
    raise exception 'source generated timestamp is required';
  end if;
  if p_source_fingerprint is null
    or p_source_fingerprint !~ '^hmac-sha256:[0-9a-f]{64}$' then
    raise exception 'source fingerprint must be an HMAC-SHA256 fingerprint';
  end if;
  if p_source_counts is null or jsonb_typeof(p_source_counts) <> 'object' then
    raise exception 'source counts must be a JSON object';
  end if;
  if p_public_diagnostics is null or jsonb_typeof(p_public_diagnostics) <> 'object' then
    raise exception 'public diagnostics must be a JSON object';
  end if;
  if p_source_payload is null or jsonb_typeof(p_source_payload) <> 'object' then
    raise exception 'source payload must be a JSON object';
  end if;
  if p_source_payload_schema_version is null or p_source_payload_schema_version <= 0 then
    raise exception 'source payload schema version must be positive';
  end if;
  if p_source_payload_checksum is null
    or p_source_payload_checksum !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'source payload checksum must be SHA256';
  end if;

  return query
  update public.recruiting_ops_source_executions as execution
  set status = 'completed',
      completed_at = now(),
      source_generated_at = p_source_generated_at,
      source_fingerprint = p_source_fingerprint,
      source_counts = p_source_counts,
      public_diagnostics = p_public_diagnostics,
      source_payload = p_source_payload,
      source_payload_schema_version = p_source_payload_schema_version,
      source_payload_checksum = p_source_payload_checksum,
      source_payload_pruned_at = null
  where execution.source_execution_id = p_source_execution_id
    and execution.owner_token = p_owner_token
    and execution.status = 'running'
    and execution.leased_until > now()
  returning execution.*;
  if found then
    return;
  end if;

  -- Completion is content-aware idempotent after a lost response.
  return query
  select execution.*
  from public.recruiting_ops_source_executions execution
  where execution.source_execution_id = p_source_execution_id
    and execution.owner_token = p_owner_token
    and execution.status = 'completed'
    and execution.source_generated_at is not distinct from p_source_generated_at
    and execution.source_fingerprint is not distinct from p_source_fingerprint
    and execution.source_counts is not distinct from p_source_counts
    and execution.public_diagnostics is not distinct from p_public_diagnostics
    and execution.source_payload is not distinct from p_source_payload
    and execution.source_payload_schema_version is not distinct from p_source_payload_schema_version
    and execution.source_payload_checksum is not distinct from p_source_payload_checksum;
  if found then
    return;
  end if;

  raise exception 'source execution completion rejected: lease missing, expired, owned by another worker, or content changed';
end;
$$;

create or replace function public.fail_recruiting_ops_source_execution(
  p_source_execution_id uuid,
  p_owner_token uuid,
  p_public_diagnostics jsonb default '{}'::jsonb
)
returns setof public.recruiting_ops_source_executions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_public_diagnostics is null or jsonb_typeof(p_public_diagnostics) <> 'object' then
    raise exception 'public diagnostics must be a JSON object';
  end if;

  -- A response-lost retry of an already-recorded failure is a no-op.
  return query
  select execution.*
  from public.recruiting_ops_source_executions execution
  where execution.source_execution_id = p_source_execution_id
    and execution.owner_token = p_owner_token
    and execution.status = 'failed';
  if found then
    return;
  end if;

  return query
  update public.recruiting_ops_source_executions as execution
  set status = 'failed',
      leased_until = now(),
      public_diagnostics = p_public_diagnostics
        || jsonb_build_object('failed_at', now())
  where execution.source_execution_id = p_source_execution_id
    and execution.owner_token = p_owner_token
    and execution.status = 'running'
  returning execution.*;
  if found then
    return;
  end if;

  raise exception 'source execution failure rejected: lease missing or owned by another worker';
end;
$$;

create or replace function public.protect_recruiting_ops_source_execution()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'recruiting-ops source executions are append-only';
  end if;
  if old.status = 'completed' then
    -- The daily orchestrator may irreversibly discard only the replay payload
    -- after its bounded retry window. Identity, counts, diagnostics, and the
    -- HMAC evidence remain immutable and durable.
    if old.source_payload is not null
       and old.source_payload_pruned_at is null
       and new.source_payload is null
       and new.source_payload_schema_version is null
       and new.source_payload_checksum is null
       and new.source_payload_pruned_at is not null
       and old.source_execution_id is not distinct from new.source_execution_id
       and old.owner_token is not distinct from new.owner_token
       and old.status is not distinct from new.status
       and old.acquired_at is not distinct from new.acquired_at
       and old.leased_until is not distinct from new.leased_until
       and old.completed_at is not distinct from new.completed_at
       and old.source_generated_at is not distinct from new.source_generated_at
       and old.source_fingerprint is not distinct from new.source_fingerprint
       and old.source_counts is not distinct from new.source_counts
       and old.public_diagnostics is not distinct from new.public_diagnostics then
      return new;
    end if;
    raise exception 'completed source executions are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_recruiting_ops_source_execution
  on public.recruiting_ops_source_executions;
drop trigger if exists trg_recruiting_ops_source_execution_completed_immutable
  on public.recruiting_ops_source_executions;
drop function if exists public.protect_completed_recruiting_ops_source_execution();
create trigger protect_recruiting_ops_source_execution
before update or delete on public.recruiting_ops_source_executions
for each row execute function public.protect_recruiting_ops_source_execution();

alter table public.recruiting_ops_source_executions enable row level security;
revoke all on table public.recruiting_ops_source_executions from public;

-- Functions are executable by PUBLIC by default. Revoke every overload by
-- catalog identity, including the unmanaged signatures, before granting only
-- the service role.
do $$
declare
  role_name text;
  function_signature text;
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'revoke all on table public.recruiting_ops_source_executions from %I',
        role_name
      );
    end if;
  end loop;

  for function_signature in
    select format(
      '%I.%I(%s)',
      n.nspname,
      p.proname,
      oidvectortypes(p.proargtypes)
    )
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'acquire_recruiting_ops_source_execution',
        'complete_recruiting_ops_source_execution',
        'fail_recruiting_ops_source_execution',
        'reap_stale_recruiting_ops_source_execution_leases'
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
    grant select on table public.recruiting_ops_source_executions to service_role;
    grant execute on function public.acquire_recruiting_ops_source_execution(uuid, uuid, integer)
      to service_role;
    grant execute on function public.complete_recruiting_ops_source_execution(
      uuid, uuid, timestamptz, text, jsonb, jsonb
    ) to service_role;
    grant execute on function public.complete_recruiting_ops_source_execution(
      uuid, uuid, timestamptz, text, jsonb, jsonb, jsonb, integer, text
    ) to service_role;
    grant execute on function public.fail_recruiting_ops_source_execution(uuid, uuid, jsonb)
      to service_role;
    grant execute on function public.reap_stale_recruiting_ops_source_execution_leases()
      to service_role;
  end if;
end $$;

commit;
