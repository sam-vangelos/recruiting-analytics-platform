-- 027 — Make projected Delivery dry-run certification a durable invariant.
--
-- This is deliberately additive and compatible with the previous service
-- image, which never emits projected_dry_run evidence. It adds no columns,
-- rewrites, indexes, or replacement RPCs.

begin;

create or replace function public.recruiting_ops_projected_evidence_valid(
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
  normalization_id text;
  date_digits text;
  projected_date date;
  projected_title text;
  projected_sheet_id bigint;
  fingerprint_key text;
  projected_evidence_keys constant text[] := array[
    'artifact_status',
    'lifecycle',
    'lifecycle_plan_status',
    'projection_certification',
    'postimage_observed',
    'target_absent_observed',
    'observed_drive_version',
    'drive_version_stable',
    'normalization_id',
    'normalization_fingerprint',
    'observed_structure_fingerprint',
    'expected_after_state_fingerprint',
    'forward_requests_fingerprint',
    'rollback_requests_fingerprint',
    'target_sheet_id',
    'target_sheet_title',
    'projected_preimage_fingerprint',
    'desired_payload_fingerprint',
    'format_fingerprint',
    'range_count',
    'projected_changed_range_count',
    'projected_value_no_op',
    'value_plan_status'
  ];
begin
  -- Preserve every pre-027 evidence shape. Only the new explicitly labelled
  -- projected certificate is governed by this validator.
  if p_certification_evidence is null
     or jsonb_typeof(p_certification_evidence) is distinct from 'object' then
    return true;
  end if;
  if jsonb_typeof(p_certification_evidence -> 'artifact_status') is distinct from 'string'
     or p_certification_evidence ->> 'artifact_status' is distinct from 'projected_dry_run' then
    return true;
  end if;

  if not (p_certification_evidence ?& projected_evidence_keys)
     or p_certification_evidence - projected_evidence_keys <> '{}'::jsonb
     or p_artifact_key is distinct from 'delivery_roles_rps'
     or p_status is distinct from 'terminal'
     or p_outcome is distinct from 'no_change'
     or p_plan_fingerprint is null
     or p_plan_fingerprint !~ '^hmac-sha256:[0-9a-f]{64}$'
     or p_mutation_call_count is distinct from 0
     or p_version_before is null
     or p_version_before !~ '^[0-9]+$'
     or p_version_after is not null
     or p_failure_code is not null
     or p_failure_stage is not null then
    return false;
  end if;

  if jsonb_typeof(p_certification_evidence -> 'lifecycle') is distinct from 'string'
     or p_certification_evidence ->> 'lifecycle' is distinct from 'recurring'
     or jsonb_typeof(p_certification_evidence -> 'lifecycle_plan_status') is distinct from 'string'
     or p_certification_evidence ->> 'lifecycle_plan_status' is distinct from 'planned'
     or jsonb_typeof(p_certification_evidence -> 'projection_certification') is distinct from 'string'
     or p_certification_evidence ->> 'projection_certification'
          is distinct from 'exact_preimage_plus_deterministic_requests'
     or jsonb_typeof(p_certification_evidence -> 'postimage_observed') is distinct from 'boolean'
     or p_certification_evidence -> 'postimage_observed' is distinct from 'false'::jsonb
     or jsonb_typeof(p_certification_evidence -> 'target_absent_observed') is distinct from 'boolean'
     or p_certification_evidence -> 'target_absent_observed' is distinct from 'true'::jsonb
     or jsonb_typeof(p_certification_evidence -> 'drive_version_stable') is distinct from 'boolean'
     or p_certification_evidence -> 'drive_version_stable' is distinct from 'true'::jsonb
     or jsonb_typeof(p_certification_evidence -> 'value_plan_status') is distinct from 'string'
     or p_certification_evidence ->> 'value_plan_status' is distinct from 'projected'
     or jsonb_typeof(p_certification_evidence -> 'projected_value_no_op') is distinct from 'boolean'
     or p_certification_evidence -> 'projected_value_no_op' is distinct from 'false'::jsonb
     or p_certification_evidence ? 'after_structure_hash' then
    return false;
  end if;

  if jsonb_typeof(p_certification_evidence -> 'observed_drive_version') is distinct from 'string'
     or p_certification_evidence ->> 'observed_drive_version' is distinct from p_version_before
     or jsonb_typeof(p_certification_evidence -> 'range_count') is distinct from 'number'
     or p_certification_evidence -> 'range_count' is distinct from '3'::jsonb
     or jsonb_typeof(p_certification_evidence -> 'projected_changed_range_count') is distinct from 'number'
     or p_certification_evidence -> 'projected_changed_range_count'
          not in ('1'::jsonb, '2'::jsonb, '3'::jsonb) then
    return false;
  end if;

  foreach fingerprint_key in array array[
    'normalization_fingerprint',
    'observed_structure_fingerprint',
    'expected_after_state_fingerprint',
    'forward_requests_fingerprint',
    'rollback_requests_fingerprint',
    'format_fingerprint'
  ] loop
    if jsonb_typeof(p_certification_evidence -> fingerprint_key) is distinct from 'string'
       or p_certification_evidence ->> fingerprint_key !~ '^sha256:[0-9a-f]{64}$' then
      return false;
    end if;
  end loop;

  foreach fingerprint_key in array array[
    'projected_preimage_fingerprint',
    'desired_payload_fingerprint'
  ] loop
    if jsonb_typeof(p_certification_evidence -> fingerprint_key) is distinct from 'string'
       or p_certification_evidence ->> fingerprint_key !~ '^hmac-sha256:[0-9a-f]{64}$' then
      return false;
    end if;
  end loop;

  if jsonb_typeof(p_certification_evidence -> 'normalization_id') is distinct from 'string' then
    return false;
  end if;
  normalization_id := p_certification_evidence ->> 'normalization_id';
  if normalization_id !~ '^delivery_rps_dated_rollover_[0-9]{8}$' then
    return false;
  end if;
  date_digits := right(normalization_id, 8);

  begin
    projected_date := make_date(
      substring(date_digits from 1 for 4)::integer,
      substring(date_digits from 5 for 2)::integer,
      substring(date_digits from 7 for 2)::integer
    );
  exception when others then
    return false;
  end;
  if projected_date < date '2000-01-01' then
    return false;
  end if;

  projected_title := lpad(extract(day from projected_date)::integer::text, 2, '0')
    || ' '
    || (array['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])[
         extract(month from projected_date)::integer
       ]
    || ' '
    || extract(year from projected_date)::integer::text;
  projected_sheet_id := 1980000000 + (projected_date - date '2000-01-01');
  if projected_sheet_id > 2147483647 then
    return false;
  end if;

  if jsonb_typeof(p_certification_evidence -> 'target_sheet_title') is distinct from 'string'
     or p_certification_evidence ->> 'target_sheet_title' is distinct from projected_title
     or jsonb_typeof(p_certification_evidence -> 'target_sheet_id') is distinct from 'number'
     or p_certification_evidence -> 'target_sheet_id' is distinct from to_jsonb(projected_sheet_id) then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.recruiting_ops_projected_evidence_valid(
  text, text, text, text, integer, text, text, jsonb, text, text
) from public;

-- Supabase may grant new public-schema functions directly to its API roles.
-- This validator exists only behind the table constraint; do not expose it as
-- a PostgREST RPC. Keep the migration portable to non-Supabase test databases
-- where one or more of these roles do not exist.
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
        'revoke all on function public.recruiting_ops_projected_evidence_valid(text, text, text, text, integer, text, text, jsonb, text, text) from %I',
        role_name
      );
    end if;
  end loop;
end;
$$;

alter table public.recruiting_ops_hydration_artifact_attempts
  add constraint recruiting_ops_projected_evidence_valid_check
  check (public.recruiting_ops_projected_evidence_valid(
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
  validate constraint recruiting_ops_projected_evidence_valid_check;

commit;
