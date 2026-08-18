-- 028 — Make successful ELT fact-table hydration evidence a durable invariant.
--
-- This is additive and compatible with the previous service image, which
-- never emits elt_fact_table_v1 evidence. It adds no columns, rewrites,
-- indexes, or replacement RPCs. Legacy/unlabelled evidence retains its
-- existing recovery semantics; an explicitly labelled successful ELT
-- certificate must satisfy the exact contract.

begin;

create or replace function public.recruiting_ops_elt_evidence_valid(
  p_artifact_key text,
  p_status text,
  p_outcome text,
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
immutable
security invoker
set search_path = pg_catalog
as $$
declare
  evidence_keys constant text[] := array[
    'artifact_status',
    'evidence_contract',
    'pii_policy',
    'acl_policy',
    'hydration_mode',
    'block_code',
    'mutation_scope',
    'plan_status',
    'plan_action',
    'dry_run_verified',
    'preimage_fingerprint',
    'drive_version_before',
    'drive_version_after',
    'rollback_drive_version',
    'permission_fingerprint',
    'permission_fingerprint_after',
    'rollback_permission_fingerprint',
    'outside_content_fingerprint',
    'revision_before_fingerprint',
    'revision_after_fingerprint',
    'revision_guard_present',
    'reporting_week',
    'snapshot_run_id',
    'snapshot_mode',
    'source_generated_at',
    'template_hash',
    'rollback_request_count',
    'rollback_attempted',
    'rollback_verified',
    'certification_status'
  ];
  month_names constant text[] := array[
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];
  source_parts text[];
  source_date date;
  source_iso_dow integer;
  reporting_friday date;
  reporting_thursday date;
  expected_reporting_week text;
  expected_snapshot_run_id text;
begin
  -- Only successful terminal ELT rows can opt into this certificate. Running,
  -- failed, timed-out, and non-ELT rows retain their existing recovery
  -- semantics.
  if p_artifact_key is distinct from 'elt_doc'
     or p_status is distinct from 'terminal'
     or p_outcome not in ('written', 'no_change') then
    return true;
  end if;

  -- Preserve every pre-028 evidence shape. Only the new explicitly labelled
  -- ELT fact-table certificate is governed by this validator, so the previous
  -- service image remains compatible while the constraint is validated and
  -- before the new producer is deployed.
  if p_certification_evidence is null
     or jsonb_typeof(p_certification_evidence) is distinct from 'object' then
    return true;
  end if;
  if jsonb_typeof(p_certification_evidence -> 'evidence_contract')
       is distinct from 'string'
     or p_certification_evidence ->> 'evidence_contract'
       is distinct from 'elt_fact_table_v1' then
    return true;
  end if;

  if p_certification_evidence is null
     or jsonb_typeof(p_certification_evidence) is distinct from 'object'
     or not (p_certification_evidence ?& evidence_keys)
     or p_certification_evidence - evidence_keys <> '{}'::jsonb
     or p_plan_fingerprint is null
     or p_plan_fingerprint !~ '^hmac-sha256:[0-9a-f]{64}$'
     or p_failure_code is not null
     or p_failure_stage is not null
     or p_certification_evidence ->> 'evidence_contract'
          is distinct from 'elt_fact_table_v1'
     or p_certification_evidence ->> 'pii_policy'
          is distinct from 'internal_review_identifiers'
     or p_certification_evidence ->> 'acl_policy'
          is distinct from 'exact_owner_and_service_writer'
     or p_certification_evidence -> 'block_code' is distinct from 'null'::jsonb
     or p_certification_evidence ->> 'mutation_scope'
          is distinct from 'weekly_fact_table'
     or p_certification_evidence -> 'revision_guard_present'
          is distinct from 'true'::jsonb
     or p_certification_evidence -> 'rollback_attempted'
          is distinct from 'false'::jsonb
     or p_certification_evidence -> 'rollback_verified'
          is distinct from 'false'::jsonb
     or p_certification_evidence -> 'rollback_drive_version'
          is distinct from 'null'::jsonb
     or p_certification_evidence -> 'rollback_permission_fingerprint'
          is distinct from 'null'::jsonb
     or jsonb_typeof(p_certification_evidence -> 'preimage_fingerprint')
          is distinct from 'string'
     or p_certification_evidence ->> 'preimage_fingerprint'
          !~ '^hmac-sha256:[0-9a-f]{64}$'
     or jsonb_typeof(p_certification_evidence -> 'outside_content_fingerprint')
          is distinct from 'string'
     or p_certification_evidence ->> 'outside_content_fingerprint'
          !~ '^hmac-sha256:[0-9a-f]{64}$'
     or jsonb_typeof(p_certification_evidence -> 'template_hash')
          is distinct from 'string'
     or p_certification_evidence ->> 'template_hash'
          !~ '^sha256:[0-9a-f]{64}$' then
    return false;
  end if;

  if jsonb_typeof(p_certification_evidence -> 'source_generated_at')
       is distinct from 'string'
     or jsonb_typeof(p_certification_evidence -> 'reporting_week')
       is distinct from 'string'
     or jsonb_typeof(p_certification_evidence -> 'snapshot_run_id')
       is distinct from 'string'
     or p_certification_evidence ->> 'snapshot_mode'
       is distinct from 'shadow' then
    return false;
  end if;

  source_parts := regexp_match(
    p_certification_evidence ->> 'source_generated_at',
    '^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])[.]([0-9]{3})Z$'
  );
  if source_parts is null then
    return false;
  end if;
  begin
    source_date := make_date(
      source_parts[1]::integer,
      source_parts[2]::integer,
      source_parts[3]::integer
    );
  exception when others then
    return false;
  end;

  expected_snapshot_run_id := 'e01_' || regexp_replace(
    p_certification_evidence ->> 'source_generated_at',
    '[^0-9]',
    '',
    'g'
  );
  if p_certification_evidence ->> 'snapshot_run_id'
       is distinct from expected_snapshot_run_id then
    return false;
  end if;

  source_iso_dow := extract(isodow from source_date)::integer;
  reporting_friday := source_date - mod(source_iso_dow - 5 + 7, 7);
  if source_iso_dow <> 4 then
    reporting_friday := reporting_friday - 7;
  end if;
  reporting_thursday := reporting_friday + 6;
  expected_reporting_week :=
    month_names[extract(month from reporting_friday)::integer]
    || ' ' || extract(day from reporting_friday)::integer::text
    || ', ' || extract(year from reporting_friday)::integer::text
    || ' - '
    || month_names[extract(month from reporting_thursday)::integer]
    || ' ' || extract(day from reporting_thursday)::integer::text
    || ', ' || extract(year from reporting_thursday)::integer::text;
  if p_certification_evidence ->> 'reporting_week'
       is distinct from expected_reporting_week then
    return false;
  end if;

  if p_certification_evidence ->> 'artifact_status' = 'dry_run' then
    return coalesce((
      p_outcome = 'no_change'
      and p_certification_evidence ->> 'hydration_mode' = 'dry_run'
      and p_certification_evidence ->> 'plan_status'
        in ('planned_for_internal_review', 'no_change')
      and (
        (
          p_certification_evidence ->> 'plan_status' = 'no_change'
          and p_certification_evidence ->> 'plan_action' = 'no_op'
        )
        or (
          p_certification_evidence ->> 'plan_status' = 'planned_for_internal_review'
          and p_certification_evidence ->> 'plan_action'
            in ('insert_top_week', 'replace_top_week')
        )
      )
      and p_certification_evidence -> 'dry_run_verified' = 'true'::jsonb
      and p_mutation_call_count = 0
      and p_version_before ~ '^sha256:[0-9a-f]{64}$'
      and p_version_after is null
      and p_certification_evidence -> 'drive_version_before' = 'null'::jsonb
      and p_certification_evidence -> 'drive_version_after' = 'null'::jsonb
      and p_certification_evidence -> 'permission_fingerprint' = 'null'::jsonb
      and p_certification_evidence -> 'permission_fingerprint_after' = 'null'::jsonb
      and jsonb_typeof(p_certification_evidence -> 'revision_before_fingerprint') = 'string'
      and p_certification_evidence ->> 'revision_before_fingerprint' = p_version_before
      and p_certification_evidence -> 'revision_after_fingerprint' = 'null'::jsonb
      and p_certification_evidence -> 'rollback_request_count' = '0'::jsonb
      and p_certification_evidence ->> 'certification_status' = 'dry_run_verified'
    ), false);
  end if;

  if p_certification_evidence ->> 'artifact_status' = 'no_change' then
    return coalesce((
      p_outcome = 'no_change'
      and p_certification_evidence ->> 'hydration_mode' = 'write'
      and p_certification_evidence ->> 'plan_status' = 'no_change'
      and p_certification_evidence ->> 'plan_action' = 'no_op'
      and p_certification_evidence -> 'dry_run_verified' = 'false'::jsonb
      and p_mutation_call_count = 0
      and p_version_before ~ '^sha256:[0-9a-f]{64}$'
      and p_version_after = p_version_before
      and jsonb_typeof(p_certification_evidence -> 'revision_before_fingerprint') = 'string'
      and p_certification_evidence ->> 'revision_before_fingerprint' = p_version_before
      and jsonb_typeof(p_certification_evidence -> 'revision_after_fingerprint') = 'string'
      and p_certification_evidence ->> 'revision_after_fingerprint' = p_version_after
      and jsonb_typeof(p_certification_evidence -> 'drive_version_before') = 'string'
      and jsonb_typeof(p_certification_evidence -> 'drive_version_after') = 'string'
      and p_certification_evidence ->> 'drive_version_before' ~ '^[1-9][0-9]*$'
      and p_certification_evidence ->> 'drive_version_after'
        = p_certification_evidence ->> 'drive_version_before'
      and jsonb_typeof(p_certification_evidence -> 'permission_fingerprint') = 'string'
      and p_certification_evidence ->> 'permission_fingerprint'
        ~ '^hmac-sha256:[0-9a-f]{64}$'
      and jsonb_typeof(p_certification_evidence -> 'permission_fingerprint_after') = 'string'
      and p_certification_evidence ->> 'permission_fingerprint_after'
        = p_certification_evidence ->> 'permission_fingerprint'
      and p_certification_evidence -> 'rollback_request_count' = '0'::jsonb
      and p_certification_evidence ->> 'certification_status' = 'preimage_verified'
    ), false);
  end if;

  if p_certification_evidence ->> 'artifact_status' = 'written' then
    return coalesce((
      p_outcome = 'written'
      and p_certification_evidence ->> 'hydration_mode' = 'write'
      and p_certification_evidence ->> 'plan_status' = 'planned_for_internal_review'
      and p_certification_evidence ->> 'plan_action'
        in ('insert_top_week', 'replace_top_week')
      and p_certification_evidence -> 'dry_run_verified' = 'false'::jsonb
      and p_mutation_call_count = 1
      and p_version_before ~ '^sha256:[0-9a-f]{64}$'
      and p_version_after ~ '^sha256:[0-9a-f]{64}$'
      and p_version_after <> p_version_before
      and jsonb_typeof(p_certification_evidence -> 'revision_before_fingerprint') = 'string'
      and p_certification_evidence ->> 'revision_before_fingerprint' = p_version_before
      and jsonb_typeof(p_certification_evidence -> 'revision_after_fingerprint') = 'string'
      and p_certification_evidence ->> 'revision_after_fingerprint' = p_version_after
      and jsonb_typeof(p_certification_evidence -> 'drive_version_before') = 'string'
      and jsonb_typeof(p_certification_evidence -> 'drive_version_after') = 'string'
      and p_certification_evidence ->> 'drive_version_before' ~ '^[1-9][0-9]*$'
      and p_certification_evidence ->> 'drive_version_after' ~ '^[1-9][0-9]*$'
      and (
        char_length(p_certification_evidence ->> 'drive_version_after')
          > char_length(p_certification_evidence ->> 'drive_version_before')
        or (
          char_length(p_certification_evidence ->> 'drive_version_after')
            = char_length(p_certification_evidence ->> 'drive_version_before')
          and (p_certification_evidence ->> 'drive_version_after') collate "C"
            > (p_certification_evidence ->> 'drive_version_before') collate "C"
        )
      )
      and jsonb_typeof(p_certification_evidence -> 'permission_fingerprint') = 'string'
      and p_certification_evidence ->> 'permission_fingerprint'
        ~ '^hmac-sha256:[0-9a-f]{64}$'
      and jsonb_typeof(p_certification_evidence -> 'permission_fingerprint_after') = 'string'
      and p_certification_evidence ->> 'permission_fingerprint_after'
        = p_certification_evidence ->> 'permission_fingerprint'
      and jsonb_typeof(p_certification_evidence -> 'rollback_request_count') = 'number'
      and p_certification_evidence ->> 'rollback_request_count' ~ '^[1-9][0-9]*$'
      and p_certification_evidence ->> 'certification_status' = 'postimage_verified'
    ), false);
  end if;

  return false;
end;
$$;

revoke all on function public.recruiting_ops_elt_evidence_valid(
  text, text, text, text, integer, text, text, jsonb, text, text
) from public;

-- Keep the constraint helper off PostgREST while remaining portable to test
-- databases that do not define every Supabase API role.
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = role_name
    ) then
      execute pg_catalog.format(
        'revoke all on function public.recruiting_ops_elt_evidence_valid(text, text, text, text, integer, text, text, jsonb, text, text) from %I',
        role_name
      );
    end if;
  end loop;
end;
$$;

alter table public.recruiting_ops_hydration_artifact_attempts
  add constraint recruiting_ops_elt_evidence_valid_check
  check (public.recruiting_ops_elt_evidence_valid(
    artifact_key,
    status,
    outcome,
    plan_fingerprint,
    mutation_call_count,
    version_before,
    version_after,
    certification_evidence,
    failure_code,
    failure_stage
  )) not valid;

alter table public.recruiting_ops_hydration_artifact_attempts
  validate constraint recruiting_ops_elt_evidence_valid_check;

commit;
