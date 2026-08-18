-- 029 — Durable once-only delivery state for the monthly Employee Referral report.
--
-- The report contents and recipient addresses never enter this schema. Period-level
-- advisory locks serialize creation, correction promotion, claims, late provider
-- observations, and proposal satisfaction behind Supabase transaction pooling.

begin;

create table if not exists public.employee_referral_report_runs (
  period_start_local date not null,
  period_end_local_exclusive date not null,
  revision integer not null,
  supersedes_revision integer,
  status text not null default 'prepared',
  window_start_utc timestamptz not null,
  window_end_utc timestamptz not null,
  source_set_fingerprint text not null,
  payload_fingerprint text not null,
  recipient_scope_version text not null,
  current_cohort_count integer not null,
  deprecated_review_count integer not null,
  ungoverned_source_review_count integer not null,
  total_row_count integer not null,
  mapping_review_count integer not null,
  policy_version text not null,
  policy_export_sha256 text not null,
  correction_reason text,
  manual_preparation_token uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivery_deadline_at timestamptz not null,
  recovery_eligible_at timestamptz not null,
  deadline_missed_at_creation boolean not null,
  delivered_at timestamptz,
  primary key (period_start_local, period_end_local_exclusive, revision)
);

create table if not exists public.employee_referral_report_recipient_deliveries (
  period_start_local date not null,
  period_end_local_exclusive date not null,
  revision integer not null,
  recipient_slot text not null,
  delivery_channel text not null,
  status text not null default 'prepared',
  provider_request_fingerprint text,
  idempotency_key text,
  attempt_count integer not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  first_provider_attempt_at timestamptz,
  idempotency_expires_at timestamptz,
  provider_message_id text,
  provider_last_event text,
  manual_evidence_ref text,
  error_code text,
  updated_at timestamptz not null default now(),
  provider_accepted_at timestamptz,
  delivered_at timestamptz,
  primary key (period_start_local, period_end_local_exclusive, revision, recipient_slot)
);

create table if not exists public.employee_referral_report_correction_proposals (
  proposal_id uuid primary key default gen_random_uuid(),
  period_start_local date not null,
  period_end_local_exclusive date not null,
  predecessor_revision integer not null,
  kind text not null,
  cause_code text not null,
  proposed_payload_fingerprint text,
  observed_recipient_scope_version text,
  status text not null default 'open',
  detected_at timestamptz not null default now(),
  decided_at timestamptz,
  decision_reason text,
  promoted_revision integer,
  satisfied_by_revision integer
);

create table if not exists public.employee_referral_report_reconciliation_issues (
  period_start_local date not null,
  period_end_local_exclusive date not null,
  revision integer not null,
  issue_code text not null,
  status text not null default 'open',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_reason text,
  primary key (period_start_local, period_end_local_exclusive, revision, issue_code)
);

alter table public.employee_referral_report_runs
  add column if not exists manual_preparation_token uuid;

alter table public.employee_referral_report_runs
  drop constraint if exists employee_referral_report_run_period_check,
  drop constraint if exists employee_referral_report_run_revision_check,
  drop constraint if exists employee_referral_report_run_status_check,
  drop constraint if exists employee_referral_report_run_count_check,
  drop constraint if exists employee_referral_report_run_fingerprint_check,
  drop constraint if exists employee_referral_report_run_policy_check,
  drop constraint if exists employee_referral_report_run_lineage_check,
  drop constraint if exists employee_referral_report_run_manual_token_check,
  drop constraint if exists employee_referral_report_run_deadline_check,
  drop constraint if exists employee_referral_report_run_delivered_check,
  drop constraint if exists employee_referral_report_run_supersedes_fk,
  drop constraint if exists employee_referral_report_run_one_successor;

alter table public.employee_referral_report_runs
  add constraint employee_referral_report_run_period_check check (
    period_end_local_exclusive > period_start_local
    and window_end_utc > window_start_utc
  ),
  add constraint employee_referral_report_run_revision_check check (revision > 0),
  add constraint employee_referral_report_run_status_check check (
    status in (
      'prepared', 'sending', 'provider_accepted', 'partially_delivered',
      'delivered', 'attention_required', 'ambiguous'
    )
  ),
  add constraint employee_referral_report_run_count_check check (
    current_cohort_count >= 0
    and deprecated_review_count >= 0
    and ungoverned_source_review_count >= 0
    and total_row_count >= 0
    and mapping_review_count >= 0
    and mapping_review_count <= total_row_count
    and total_row_count = current_cohort_count
      + deprecated_review_count
      + ungoverned_source_review_count
  ),
  add constraint employee_referral_report_run_fingerprint_check check (
    source_set_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    and payload_fingerprint ~ '^hmac-sha256:[0-9a-f]{64}$'
    and recipient_scope_version ~ '^scope-v[1-9][0-9]{0,9}$'
  ),
  add constraint employee_referral_report_run_policy_check check (
    length(trim(policy_version)) between 1 and 64
    and policy_export_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint employee_referral_report_run_lineage_check check (
    (revision = 1 and supersedes_revision is null and correction_reason is null)
    or
    (revision > 1 and supersedes_revision = revision - 1
      and correction_reason is not null
      and length(trim(correction_reason)) between 1 and 1000)
  ),
  add constraint employee_referral_report_run_manual_token_check check (
    manual_preparation_token is null
    or (revision = 1 and supersedes_revision is null)
  ),
  add constraint employee_referral_report_run_deadline_check check (
    recovery_eligible_at = greatest(delivery_deadline_at, created_at + interval '2 hours')
    and deadline_missed_at_creation = (delivery_deadline_at < created_at)
  ),
  add constraint employee_referral_report_run_delivered_check check (
    (status = 'delivered' and delivered_at is not null)
    or (status <> 'delivered' and delivered_at is null)
  ),
  add constraint employee_referral_report_run_supersedes_fk foreign key (
    period_start_local, period_end_local_exclusive, supersedes_revision
  ) references public.employee_referral_report_runs (
    period_start_local, period_end_local_exclusive, revision
  ) deferrable initially immediate,
  add constraint employee_referral_report_run_one_successor unique (
    period_start_local, period_end_local_exclusive, supersedes_revision
  );

alter table public.employee_referral_report_recipient_deliveries
  drop constraint if exists employee_referral_delivery_run_fk,
  drop constraint if exists employee_referral_delivery_slot_check,
  drop constraint if exists employee_referral_delivery_channel_check,
  drop constraint if exists employee_referral_delivery_status_check,
  drop constraint if exists employee_referral_delivery_attempt_check,
  drop constraint if exists employee_referral_delivery_lease_check,
  drop constraint if exists employee_referral_delivery_provider_request_check,
  drop constraint if exists employee_referral_delivery_channel_evidence_check,
  drop constraint if exists employee_referral_delivery_status_evidence_check,
  drop constraint if exists employee_referral_delivery_safe_code_check;

alter table public.employee_referral_report_recipient_deliveries
  add constraint employee_referral_delivery_run_fk foreign key (
    period_start_local, period_end_local_exclusive, revision
  ) references public.employee_referral_report_runs (
    period_start_local, period_end_local_exclusive, revision
  ) on delete restrict,
  add constraint employee_referral_delivery_slot_check check (
    recipient_slot in ('ta_lead', 'requesting_manager')
  ),
  add constraint employee_referral_delivery_channel_check check (
    delivery_channel in ('resend', 'manual_corporate_email')
  ),
  add constraint employee_referral_delivery_status_check check (
    status in (
      'prepared', 'sending', 'provider_accepted', 'pending', 'delivery_delayed',
      'delivered', 'manual_delivered', 'complained', 'transport_failed',
      'ambiguous', 'delivery_failed', 'bounced', 'suppressed', 'canceled',
      'unknown_event', 'status_unverifiable'
    )
  ),
  add constraint employee_referral_delivery_attempt_check check (attempt_count >= 0),
  add constraint employee_referral_delivery_lease_check check (
    (lease_token is null) = (lease_expires_at is null)
    and (status = 'sending') = (lease_token is not null)
  ),
  add constraint employee_referral_delivery_provider_request_check check (
    (
      provider_request_fingerprint is null
      and idempotency_key is null
      and first_provider_attempt_at is null
      and idempotency_expires_at is null
    )
    or
    (
      provider_request_fingerprint ~ '^hmac-sha256:[0-9a-f]{64}$'
      and idempotency_key ~ '^employee-referral-[0-9a-f]{64}$'
      and first_provider_attempt_at is not null
      and idempotency_expires_at = first_provider_attempt_at + interval '24 hours'
    )
  ),
  add constraint employee_referral_delivery_channel_evidence_check check (
    (
      delivery_channel = 'resend'
      and manual_evidence_ref is null
    )
    or
    (
      delivery_channel = 'manual_corporate_email'
      and provider_request_fingerprint is null
      and idempotency_key is null
      and first_provider_attempt_at is null
      and idempotency_expires_at is null
      and provider_message_id is null
      and provider_accepted_at is null
      and provider_last_event is null
      and attempt_count = 0
      and (
        (status = 'prepared' and manual_evidence_ref is null)
        or (status = 'manual_delivered' and manual_evidence_ref is not null)
      )
    )
  ),
  add constraint employee_referral_delivery_status_evidence_check check (
    (
      status in ('provider_accepted', 'pending', 'delivery_delayed', 'delivered',
        'complained', 'delivery_failed', 'bounced', 'suppressed', 'canceled',
        'unknown_event')
      and provider_message_id is not null
      and provider_accepted_at is not null
      and provider_request_fingerprint is not null
      and idempotency_key is not null
      and first_provider_attempt_at is not null
    )
    or (
      status = 'status_unverifiable'
      and provider_request_fingerprint is not null
      and idempotency_key is not null
      and first_provider_attempt_at is not null
      and (provider_message_id is null) = (provider_accepted_at is null)
    )
    or status not in ('provider_accepted', 'pending', 'delivery_delayed', 'delivered',
      'complained', 'delivery_failed', 'bounced', 'suppressed', 'canceled',
      'unknown_event', 'status_unverifiable')
  ),
  add constraint employee_referral_delivery_safe_code_check check (
    (error_code is null or error_code ~ '^[a-z0-9_]{1,64}$')
    and (provider_last_event is null or provider_last_event ~ '^[a-z_]{1,64}$')
    and (provider_message_id is null or provider_message_id ~ '^[A-Za-z0-9_-]{1,200}$')
    and (manual_evidence_ref is null
      or manual_evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9:_./-]{0,255}$')
    and (
      (status in ('delivered', 'manual_delivered', 'complained') and delivered_at is not null)
      or (status not in ('delivered', 'manual_delivered', 'complained') and delivered_at is null)
    )
  );

alter table public.employee_referral_report_correction_proposals
  drop constraint if exists employee_referral_proposal_predecessor_fk,
  drop constraint if exists employee_referral_proposal_promoted_fk,
  drop constraint if exists employee_referral_proposal_satisfied_fk,
  drop constraint if exists employee_referral_proposal_kind_check,
  drop constraint if exists employee_referral_proposal_cause_check,
  drop constraint if exists employee_referral_proposal_status_check,
  drop constraint if exists employee_referral_proposal_transition_shape_check;

alter table public.employee_referral_report_correction_proposals
  add constraint employee_referral_proposal_predecessor_fk foreign key (
    period_start_local, period_end_local_exclusive, predecessor_revision
  ) references public.employee_referral_report_runs (
    period_start_local, period_end_local_exclusive, revision
  ),
  add constraint employee_referral_proposal_promoted_fk foreign key (
    period_start_local, period_end_local_exclusive, promoted_revision
  ) references public.employee_referral_report_runs (
    period_start_local, period_end_local_exclusive, revision
  ),
  add constraint employee_referral_proposal_satisfied_fk foreign key (
    period_start_local, period_end_local_exclusive, satisfied_by_revision
  ) references public.employee_referral_report_runs (
    period_start_local, period_end_local_exclusive, revision
  ),
  add constraint employee_referral_proposal_kind_check check (
    kind in ('data_drift', 'delivery_recovery')
  ),
  add constraint employee_referral_proposal_cause_check check (
    (
      kind = 'data_drift'
      and cause_code = 'payload_changed'
      and proposed_payload_fingerprint is not null
      and proposed_payload_fingerprint ~ '^hmac-sha256:[0-9a-f]{64}$'
      and observed_recipient_scope_version is null
    )
    or
    (
      kind = 'delivery_recovery'
      and cause_code in (
        'payload_changed', 'dispatch_unresolved', 'provider_terminal',
        'delivery_deadline', 'recipient_scope_changed'
      )
      and proposed_payload_fingerprint is null
      and (
        (cause_code = 'recipient_scope_changed'
          and observed_recipient_scope_version is not null
          and observed_recipient_scope_version ~ '^scope-v[1-9][0-9]{0,9}$')
        or
        (cause_code <> 'recipient_scope_changed'
          and observed_recipient_scope_version is null)
      )
    )
  ),
  add constraint employee_referral_proposal_status_check check (
    status in ('open', 'dismissed', 'promoted', 'satisfied')
  ),
  add constraint employee_referral_proposal_transition_shape_check check (
    (status = 'open' and decided_at is null and decision_reason is null
      and promoted_revision is null and satisfied_by_revision is null)
    or
    (status = 'dismissed' and kind = 'data_drift' and decided_at is not null
      and decision_reason is not null
      and length(trim(decision_reason)) between 1 and 1000
      and promoted_revision is null and satisfied_by_revision is null)
    or
    (status = 'promoted' and decided_at is not null
      and decision_reason is not null
      and length(trim(decision_reason)) between 1 and 1000
      and promoted_revision = predecessor_revision + 1
      and satisfied_by_revision is null)
    or
    (status = 'satisfied' and decided_at is not null
      and decision_reason is not null
      and length(trim(decision_reason)) between 1 and 1000
      and satisfied_by_revision is not null
      and satisfied_by_revision >= predecessor_revision
      and (promoted_revision is null or promoted_revision = predecessor_revision + 1))
  );

alter table public.employee_referral_report_reconciliation_issues
  drop constraint if exists employee_referral_issue_run_fk,
  drop constraint if exists employee_referral_issue_code_check,
  drop constraint if exists employee_referral_issue_status_check;

alter table public.employee_referral_report_reconciliation_issues
  add constraint employee_referral_issue_run_fk foreign key (
    period_start_local, period_end_local_exclusive, revision
  ) references public.employee_referral_report_runs (
    period_start_local, period_end_local_exclusive, revision
  ),
  add constraint employee_referral_issue_code_check check (
    issue_code ~ '^[a-z0-9_]{1,64}$'
  ),
  add constraint employee_referral_issue_status_check check (
    (status = 'open' and resolved_at is null and resolution_reason is null)
    or
    (status = 'resolved' and resolved_at is not null
      and resolution_reason is not null
      and length(trim(resolution_reason)) between 1 and 1000)
  );

create unique index if not exists employee_referral_open_recovery_unique
  on public.employee_referral_report_correction_proposals (
    period_start_local, period_end_local_exclusive, predecessor_revision, cause_code
  ) where kind = 'delivery_recovery' and status in ('open', 'promoted');

create unique index if not exists employee_referral_open_drift_unique
  on public.employee_referral_report_correction_proposals (
    period_start_local, period_end_local_exclusive, predecessor_revision,
    proposed_payload_fingerprint
  ) where kind = 'data_drift' and status in ('open', 'promoted');

create index if not exists employee_referral_delivery_watchdog_idx
  on public.employee_referral_report_recipient_deliveries (
    status, first_provider_attempt_at, period_start_local, revision
  );

create index if not exists employee_referral_open_proposal_idx
  on public.employee_referral_report_correction_proposals (
    status, period_start_local, period_end_local_exclusive, predecessor_revision
  );

create or replace function public.employee_referral_assert_run_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if row(
    new.period_start_local, new.period_end_local_exclusive, new.revision,
    new.supersedes_revision, new.window_start_utc, new.window_end_utc,
    new.source_set_fingerprint, new.payload_fingerprint,
    new.recipient_scope_version, new.current_cohort_count,
    new.deprecated_review_count, new.ungoverned_source_review_count,
    new.total_row_count, new.mapping_review_count, new.policy_version,
    new.policy_export_sha256, new.correction_reason,
    new.manual_preparation_token, new.created_at,
    new.delivery_deadline_at, new.recovery_eligible_at,
    new.deadline_missed_at_creation
  ) is distinct from row(
    old.period_start_local, old.period_end_local_exclusive, old.revision,
    old.supersedes_revision, old.window_start_utc, old.window_end_utc,
    old.source_set_fingerprint, old.payload_fingerprint,
    old.recipient_scope_version, old.current_cohort_count,
    old.deprecated_review_count, old.ungoverned_source_review_count,
    old.total_row_count, old.mapping_review_count, old.policy_version,
    old.policy_export_sha256, old.correction_reason,
    old.manual_preparation_token, old.created_at,
    old.delivery_deadline_at, old.recovery_eligible_at,
    old.deadline_missed_at_creation
  ) then
    raise exception 'employee referral report immutable fields cannot change';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists employee_referral_report_run_immutable on public.employee_referral_report_runs;
create trigger employee_referral_report_run_immutable
before update on public.employee_referral_report_runs
for each row execute function public.employee_referral_assert_run_immutable();

create or replace function public.employee_referral_assert_delivery_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if row(new.period_start_local, new.period_end_local_exclusive, new.revision,
      new.recipient_slot, new.delivery_channel)
    is distinct from
    row(old.period_start_local, old.period_end_local_exclusive, old.revision,
      old.recipient_slot, old.delivery_channel) then
    raise exception 'employee referral recipient delivery identity cannot change';
  end if;
  if old.provider_request_fingerprint is not null
    and new.provider_request_fingerprint is distinct from old.provider_request_fingerprint then
    raise exception 'employee referral provider request fingerprint is frozen';
  end if;
  if old.idempotency_key is not null and new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'employee referral idempotency key is frozen';
  end if;
  if old.first_provider_attempt_at is not null
    and new.first_provider_attempt_at is distinct from old.first_provider_attempt_at then
    raise exception 'employee referral first provider attempt is frozen';
  end if;
  if old.idempotency_expires_at is not null
    and new.idempotency_expires_at is distinct from old.idempotency_expires_at then
    raise exception 'employee referral idempotency expiry is frozen';
  end if;
  if old.provider_message_id is not null
    and new.provider_message_id is distinct from old.provider_message_id then
    raise exception 'employee referral provider message id is frozen';
  end if;
  if old.manual_evidence_ref is not null
    and new.manual_evidence_ref is distinct from old.manual_evidence_ref then
    raise exception 'employee referral manual evidence is frozen';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists employee_referral_delivery_immutable
  on public.employee_referral_report_recipient_deliveries;
create trigger employee_referral_delivery_immutable
before update on public.employee_referral_report_recipient_deliveries
for each row execute function public.employee_referral_assert_delivery_immutable();

create or replace function public.employee_referral_lock_period(
  p_period_start_local date,
  p_period_end_local_exclusive date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_period_start_local is null or p_period_end_local_exclusive is null
    or p_period_end_local_exclusive <= p_period_start_local then
    raise exception 'valid employee referral report period is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'employee_referral_report:' || p_period_start_local::text || ':'
        || p_period_end_local_exclusive::text,
      0
    )
  );
end;
$$;

create or replace function public.employee_referral_refresh_parent(
  p_period_start_local date,
  p_period_end_local_exclusive date,
  p_revision integer
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  child_count integer;
  evidence_count integer;
  terminal_count integer;
  accepted_count integer;
  sending_count integer;
  ambiguous_count integer;
  next_status text;
begin
  select count(*),
    count(*) filter (where status in ('delivered', 'manual_delivered', 'complained')),
    count(*) filter (where status in (
      'delivery_failed', 'bounced', 'suppressed', 'canceled',
      'unknown_event', 'status_unverifiable'
    )),
    count(*) filter (where status in (
      'provider_accepted', 'pending', 'delivery_delayed',
      'delivered', 'manual_delivered', 'complained'
    )),
    count(*) filter (where status = 'sending'),
    count(*) filter (where status = 'ambiguous')
  into child_count, evidence_count, terminal_count, accepted_count,
    sending_count, ambiguous_count
  from public.employee_referral_report_recipient_deliveries
  where period_start_local = p_period_start_local
    and period_end_local_exclusive = p_period_end_local_exclusive
    and revision = p_revision;

  if child_count <> 2 then
    raise exception 'employee referral report requires exactly two recipient slots';
  end if;
  next_status := case
    when terminal_count > 0 then 'attention_required'
    when evidence_count = 2 then 'delivered'
    when evidence_count > 0 then 'partially_delivered'
    when ambiguous_count > 0 then 'ambiguous'
    when accepted_count = 2 then 'provider_accepted'
    when sending_count > 0 or accepted_count > 0 then 'sending'
    else 'prepared'
  end;
  if exists (
    select 1
    from public.employee_referral_report_correction_proposals proposal
    where proposal.period_start_local = p_period_start_local
      and proposal.period_end_local_exclusive = p_period_end_local_exclusive
      and proposal.predecessor_revision = p_revision
      and proposal.kind = 'delivery_recovery'
      and proposal.status in ('open', 'promoted')
      and (
        next_status <> 'delivered'
        or proposal.cause_code = 'recipient_scope_changed'
        or proposal.status = 'promoted'
      )
  ) then
    next_status := 'attention_required';
  end if;

  update public.employee_referral_report_runs
  set status = next_status,
      delivered_at = case when next_status = 'delivered' then coalesce(delivered_at, now()) else null end
  where period_start_local = p_period_start_local
    and period_end_local_exclusive = p_period_end_local_exclusive
    and revision = p_revision;
  if not found then
    raise exception 'employee referral report parent is missing';
  end if;

  if next_status = 'delivered' then
    update public.employee_referral_report_correction_proposals proposal
    set status = 'satisfied',
        decided_at = coalesce(proposal.decided_at, now()),
        decision_reason = case
          when proposal.promoted_revision is null then 'late_delivery_evidence_completed_predecessor'
          else 'fully_delivered_successor_satisfied_obligation'
        end,
        satisfied_by_revision = p_revision
    where proposal.period_start_local = p_period_start_local
      and proposal.period_end_local_exclusive = p_period_end_local_exclusive
      and proposal.status in ('open', 'promoted')
      and (
        p_revision > proposal.predecessor_revision
        or (
          p_revision = proposal.predecessor_revision
          and proposal.status = 'open'
          and proposal.kind = 'delivery_recovery'
          and proposal.cause_code <> 'recipient_scope_changed'
        )
      );
  end if;
  return next_status;
end;
$$;

-- The return contract gained deadline_missed_at_creation during pre-launch hardening.
-- PostgreSQL cannot CREATE OR REPLACE a function when OUT columns change, so the
-- exact signature is dropped and recreated transactionally for safe reapplication.
drop function if exists public.employee_referral_prepare_and_claim(
  date, date, integer, integer, timestamptz, timestamptz,
  text, text, text, integer, integer, integer, integer, integer,
  text, text, text, timestamptz, text, integer, jsonb, jsonb
);
drop function if exists public.employee_referral_prepare_and_claim(
  date, date, integer, integer, timestamptz, timestamptz,
  text, text, text, integer, integer, integer, integer, integer,
  text, text, text, timestamptz, text, integer, jsonb, jsonb, uuid
);

create function public.employee_referral_prepare_and_claim(
  p_period_start_local date,
  p_period_end_local_exclusive date,
  p_revision integer,
  p_supersedes_revision integer,
  p_window_start_utc timestamptz,
  p_window_end_utc timestamptz,
  p_source_set_fingerprint text,
  p_payload_fingerprint text,
  p_recipient_scope_version text,
  p_current_cohort_count integer,
  p_deprecated_review_count integer,
  p_ungoverned_source_review_count integer,
  p_total_row_count integer,
  p_mapping_review_count integer,
  p_policy_version text,
  p_policy_export_sha256 text,
  p_correction_reason text,
  p_delivery_deadline_at timestamptz,
  p_delivery_channel text default 'resend',
  p_lease_seconds integer default 300,
  p_request_fingerprints jsonb default '{}'::jsonb,
  p_idempotency_keys jsonb default '{}'::jsonb,
  p_manual_preparation_token uuid default null
)
returns table (
  parent_status text,
  recipient_slot text,
  delivery_status text,
  claimed boolean,
  lease_token uuid,
  attempt_count integer,
  provider_request_fingerprint text,
  idempotency_key text,
  idempotency_expires_at timestamptz,
  provider_message_id text,
  deadline_missed_at_creation boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.employee_referral_report_runs%rowtype;
  slot public.employee_referral_report_recipient_deliveries%rowtype;
  claim_token uuid;
  claim_tokens uuid[] := array[]::uuid[];
  requested_fingerprint text;
  requested_idempotency_key text;
  now_at timestamptz := now();
  immutable_conflict boolean := false;
  payload_changed boolean := false;
  scope_changed boolean := false;
  authoritative_head boolean := false;
  unsafe_ambiguity boolean := false;
begin
  perform public.employee_referral_lock_period(p_period_start_local, p_period_end_local_exclusive);
  if p_revision is null or p_revision <= 0 then
    raise exception 'employee referral report revision must be positive';
  end if;
  if p_revision = 1 and p_correction_reason is not null then
    raise exception 'revision 1 cannot carry a correction reason';
  end if;
  if p_delivery_channel is null
    or p_delivery_channel not in ('resend', 'manual_corporate_email') then
    raise exception 'invalid employee referral delivery channel';
  end if;
  if (
    p_delivery_channel = 'manual_corporate_email'
    and p_manual_preparation_token is null
  ) or (
    p_delivery_channel = 'resend'
    and p_manual_preparation_token is not null
  ) then
    raise exception 'manual preparation token does not match delivery channel';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 600 then
    raise exception 'employee referral delivery lease must be between 60 and 600 seconds';
  end if;
  if p_source_set_fingerprint is null
      or p_source_set_fingerprint !~ '^sha256:[0-9a-f]{64}$'
      or p_payload_fingerprint is null
      or p_payload_fingerprint !~ '^hmac-sha256:[0-9a-f]{64}$'
      or p_recipient_scope_version is null
      or p_recipient_scope_version !~ '^scope-v[1-9][0-9]{0,9}$' then
    raise exception 'valid employee referral report fingerprints and scope are required';
  end if;
  if p_policy_version is null
      or length(trim(p_policy_version)) not between 1 and 64
      or p_policy_export_sha256 is null
      or p_policy_export_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'valid employee referral policy metadata is required';
  end if;
  if p_delivery_deadline_at is null then
    raise exception 'employee referral delivery deadline is required';
  end if;
  if p_delivery_channel = 'manual_corporate_email'
    and (
      p_period_start_local <> date '2026-04-01'
      or p_period_end_local_exclusive <> date '2026-07-01'
      or p_revision <> 1
  ) then
    raise exception 'manual delivery is fenced to the initial April-June revision 1';
  end if;
  if p_delivery_channel = 'manual_corporate_email'
    and (
      exists (
        select 1
        from public.employee_referral_report_runs report
        where report.period_start_local = p_period_start_local
          and report.period_end_local_exclusive = p_period_end_local_exclusive
      )
      or exists (
        select 1
        from public.employee_referral_report_recipient_deliveries delivery
        where delivery.period_start_local = p_period_start_local
          and delivery.period_end_local_exclusive = p_period_end_local_exclusive
      )
    ) then
    raise exception 'manual delivery preparation requires an empty initial backfill ledger';
  end if;

  select report.* into existing
  from public.employee_referral_report_runs report
  where report.period_start_local = p_period_start_local
    and report.period_end_local_exclusive = p_period_end_local_exclusive
    and report.revision = p_revision;

  if not found then
    if p_revision <> 1 or p_supersedes_revision is not null then
      raise exception 'new correction revisions require explicit promotion';
    end if;
    insert into public.employee_referral_report_runs (
      period_start_local, period_end_local_exclusive, revision,
      supersedes_revision, status, window_start_utc, window_end_utc,
      source_set_fingerprint, payload_fingerprint, recipient_scope_version,
      current_cohort_count, deprecated_review_count,
      ungoverned_source_review_count, total_row_count, mapping_review_count,
      policy_version, policy_export_sha256, correction_reason,
      manual_preparation_token, created_at,
      delivery_deadline_at, recovery_eligible_at, deadline_missed_at_creation
    ) values (
      p_period_start_local, p_period_end_local_exclusive, p_revision,
      null, 'prepared', p_window_start_utc, p_window_end_utc,
      p_source_set_fingerprint, p_payload_fingerprint, p_recipient_scope_version,
      p_current_cohort_count, p_deprecated_review_count,
      p_ungoverned_source_review_count, p_total_row_count, p_mapping_review_count,
      p_policy_version, p_policy_export_sha256, null,
      p_manual_preparation_token, now_at,
      p_delivery_deadline_at, greatest(p_delivery_deadline_at, now_at + interval '2 hours'),
      p_delivery_deadline_at < now_at
    );
    insert into public.employee_referral_report_recipient_deliveries (
      period_start_local, period_end_local_exclusive, revision,
      recipient_slot, delivery_channel, status
    ) values
      (p_period_start_local, p_period_end_local_exclusive, p_revision,
        'ta_lead', p_delivery_channel, 'prepared'),
      (p_period_start_local, p_period_end_local_exclusive, p_revision,
        'requesting_manager', p_delivery_channel, 'prepared');
  else
    immutable_conflict := row(
      existing.supersedes_revision, existing.window_start_utc, existing.window_end_utc,
      existing.correction_reason
    ) is distinct from row(
      p_supersedes_revision, p_window_start_utc, p_window_end_utc,
      p_correction_reason
    );
    if immutable_conflict then
      raise exception 'employee referral report replay conflicts with immutable inputs';
    end if;
    if exists (
      select 1 from public.employee_referral_report_recipient_deliveries delivery
      where delivery.period_start_local = p_period_start_local
        and delivery.period_end_local_exclusive = p_period_end_local_exclusive
        and delivery.revision = p_revision
        and delivery.delivery_channel <> p_delivery_channel
    ) then
      raise exception 'employee referral delivery channel cannot change';
    end if;
    payload_changed := existing.payload_fingerprint is distinct from p_payload_fingerprint
      or existing.source_set_fingerprint is distinct from p_source_set_fingerprint
      or existing.policy_version is distinct from p_policy_version
      or existing.policy_export_sha256 is distinct from p_policy_export_sha256
      or row(existing.current_cohort_count, existing.deprecated_review_count,
        existing.ungoverned_source_review_count, existing.total_row_count,
        existing.mapping_review_count)
        is distinct from
        row(p_current_cohort_count, p_deprecated_review_count,
          p_ungoverned_source_review_count, p_total_row_count,
          p_mapping_review_count);
    scope_changed := existing.recipient_scope_version
      is distinct from p_recipient_scope_version;
    if existing.status <> 'delivered' and (payload_changed or scope_changed) then
      update public.employee_referral_report_runs
      set status = 'attention_required', delivered_at = null
      where period_start_local = p_period_start_local
        and period_end_local_exclusive = p_period_end_local_exclusive
        and revision = p_revision
        and status <> 'delivered';
      if payload_changed then
        insert into public.employee_referral_report_correction_proposals (
          period_start_local, period_end_local_exclusive, predecessor_revision,
          kind, cause_code, proposed_payload_fingerprint
        ) select p_period_start_local, p_period_end_local_exclusive, p_revision,
          'data_drift', 'payload_changed', p_payload_fingerprint
        where not exists (
          select 1 from public.employee_referral_report_correction_proposals proposal
          where proposal.period_start_local = p_period_start_local
            and proposal.period_end_local_exclusive = p_period_end_local_exclusive
            and proposal.predecessor_revision = p_revision
            and proposal.kind = 'data_drift'
            and proposal.proposed_payload_fingerprint = p_payload_fingerprint
            and proposal.status in ('open', 'promoted')
        );
        insert into public.employee_referral_report_correction_proposals (
          period_start_local, period_end_local_exclusive, predecessor_revision,
          kind, cause_code
        ) select p_period_start_local, p_period_end_local_exclusive, p_revision,
          'delivery_recovery', 'payload_changed'
        where not exists (
          select 1 from public.employee_referral_report_correction_proposals proposal
          where proposal.period_start_local = p_period_start_local
            and proposal.period_end_local_exclusive = p_period_end_local_exclusive
            and proposal.predecessor_revision = p_revision
            and proposal.kind = 'delivery_recovery'
            and proposal.cause_code = 'payload_changed'
            and proposal.status in ('open', 'promoted')
        );
      end if;
      if scope_changed then
        insert into public.employee_referral_report_correction_proposals (
          period_start_local, period_end_local_exclusive, predecessor_revision,
          kind, cause_code, observed_recipient_scope_version
        ) select p_period_start_local, p_period_end_local_exclusive, p_revision,
          'delivery_recovery', 'recipient_scope_changed', p_recipient_scope_version
        where not exists (
          select 1 from public.employee_referral_report_correction_proposals proposal
          where proposal.period_start_local = p_period_start_local
            and proposal.period_end_local_exclusive = p_period_end_local_exclusive
            and proposal.predecessor_revision = p_revision
            and proposal.kind = 'delivery_recovery'
            and proposal.cause_code = 'recipient_scope_changed'
            and proposal.status in ('open', 'promoted')
        );
      end if;
    end if;
  end if;

  update public.employee_referral_report_recipient_deliveries delivery
  set status = case
        when delivery.first_provider_attempt_at is null then 'prepared'
        when delivery.error_code = 'retry_proven_preacceptance'
          then 'transport_failed'
        else 'ambiguous'
      end,
      lease_token = null,
      lease_expires_at = null,
      error_code = case
        when delivery.first_provider_attempt_at is null
          or delivery.error_code = 'retry_proven_preacceptance'
          then 'lease_expired_before_dispatch'
        else 'lease_expired_after_dispatch'
      end
  where delivery.period_start_local = p_period_start_local
    and delivery.period_end_local_exclusive = p_period_end_local_exclusive
    and delivery.revision = p_revision
    and delivery.status = 'sending'
    and delivery.lease_expires_at <= now_at;

  select report.* into existing
  from public.employee_referral_report_runs report
  where report.period_start_local = p_period_start_local
    and report.period_end_local_exclusive = p_period_end_local_exclusive
    and report.revision = p_revision;

  select not exists (
    select 1
    from public.employee_referral_report_runs successor
    where successor.period_start_local = p_period_start_local
      and successor.period_end_local_exclusive = p_period_end_local_exclusive
      and successor.supersedes_revision = p_revision
  ) into authoritative_head;

  if authoritative_head
    and existing.status <> 'attention_required'
    and p_delivery_channel = 'resend' then
    select exists (
      select 1
      from public.employee_referral_report_recipient_deliveries delivery
      where delivery.period_start_local = p_period_start_local
        and delivery.period_end_local_exclusive = p_period_end_local_exclusive
        and delivery.revision = p_revision
        and (
          (
            delivery.status = 'ambiguous'
            and (
              delivery.provider_message_id is not null
              or delivery.idempotency_expires_at is null
              or now_at >= delivery.idempotency_expires_at - interval '5 minutes'
              or delivery.provider_request_fingerprint is distinct from
                (p_request_fingerprints ->> delivery.recipient_slot)
              or delivery.idempotency_key is distinct from
                (p_idempotency_keys ->> delivery.recipient_slot)
            )
          )
          or (
            delivery.status = 'transport_failed'
            and (
              delivery.provider_request_fingerprint is distinct from
                (p_request_fingerprints ->> delivery.recipient_slot)
              or delivery.idempotency_key is distinct from
                (p_idempotency_keys ->> delivery.recipient_slot)
            )
          )
        )
    ) into unsafe_ambiguity;
  end if;

  if unsafe_ambiguity then
    insert into public.employee_referral_report_correction_proposals (
      period_start_local, period_end_local_exclusive, predecessor_revision,
      kind, cause_code
    ) select p_period_start_local, p_period_end_local_exclusive, p_revision,
      'delivery_recovery', 'dispatch_unresolved'
    where not exists (
      select 1 from public.employee_referral_report_correction_proposals proposal
      where proposal.period_start_local = p_period_start_local
        and proposal.period_end_local_exclusive = p_period_end_local_exclusive
        and proposal.predecessor_revision = p_revision
        and proposal.kind = 'delivery_recovery'
        and proposal.cause_code = 'dispatch_unresolved'
        and proposal.status in ('open', 'promoted')
    );
    update public.employee_referral_report_runs
    set status = 'attention_required', delivered_at = null
    where period_start_local = p_period_start_local
      and period_end_local_exclusive = p_period_end_local_exclusive
      and revision = p_revision;
    existing.status := 'attention_required';
  end if;

  if authoritative_head
    and existing.status <> 'attention_required'
    and p_delivery_channel = 'resend' then
    for slot in
      select delivery.*
      from public.employee_referral_report_recipient_deliveries delivery
      where delivery.period_start_local = p_period_start_local
        and delivery.period_end_local_exclusive = p_period_end_local_exclusive
        and delivery.revision = p_revision
      order by delivery.recipient_slot
      for update
    loop
      requested_fingerprint := p_request_fingerprints ->> slot.recipient_slot;
      requested_idempotency_key := p_idempotency_keys ->> slot.recipient_slot;
      if requested_fingerprint is null
        or requested_fingerprint !~ '^hmac-sha256:[0-9a-f]{64}$'
        or requested_idempotency_key is null
        or requested_idempotency_key !~ '^employee-referral-[0-9a-f]{64}$' then
        raise exception 'employee referral claim requires derived PII-safe request tokens';
      end if;
      if (
          slot.status = 'prepared'
          and slot.provider_request_fingerprint is null
          and slot.idempotency_key is null
        )
        or (
          slot.status = 'transport_failed'
          and slot.provider_request_fingerprint = requested_fingerprint
          and slot.idempotency_key = requested_idempotency_key
        )
        or (
          slot.status = 'ambiguous'
          and slot.provider_message_id is null
          and now_at < slot.idempotency_expires_at - interval '5 minutes'
          and slot.provider_request_fingerprint = requested_fingerprint
          and slot.idempotency_key = requested_idempotency_key
        ) then
        claim_token := gen_random_uuid();
        update public.employee_referral_report_recipient_deliveries delivery
        set status = 'sending',
            attempt_count = delivery.attempt_count + 1,
            lease_token = claim_token,
            lease_expires_at = now_at + make_interval(secs => p_lease_seconds),
            error_code = case
              when slot.status = 'transport_failed'
                then 'retry_proven_preacceptance'
              else null
            end
        where delivery.period_start_local = p_period_start_local
          and delivery.period_end_local_exclusive = p_period_end_local_exclusive
          and delivery.revision = p_revision
          and delivery.recipient_slot = slot.recipient_slot;
        claim_tokens := array_append(claim_tokens, claim_token);
      end if;
    end loop;
  end if;

  if p_delivery_channel = 'resend' and not exists (
    select 1 from public.employee_referral_report_runs report
    where report.period_start_local = p_period_start_local
      and report.period_end_local_exclusive = p_period_end_local_exclusive
      and report.revision = p_revision
      and report.status = 'attention_required'
  ) then
    perform public.employee_referral_refresh_parent(
      p_period_start_local, p_period_end_local_exclusive, p_revision
    );
  end if;
  return query
  select report.status,
    delivery.recipient_slot,
    delivery.status,
    coalesce(delivery.lease_token = any(claim_tokens), false),
    case when delivery.lease_token = any(claim_tokens) then delivery.lease_token else null end,
    delivery.attempt_count,
    delivery.provider_request_fingerprint,
    delivery.idempotency_key,
    delivery.idempotency_expires_at,
    delivery.provider_message_id,
    report.deadline_missed_at_creation
  from public.employee_referral_report_runs report
  join public.employee_referral_report_recipient_deliveries delivery
    on delivery.period_start_local = report.period_start_local
    and delivery.period_end_local_exclusive = report.period_end_local_exclusive
    and delivery.revision = report.revision
  where report.period_start_local = p_period_start_local
    and report.period_end_local_exclusive = p_period_end_local_exclusive
    and report.revision = p_revision
  order by delivery.recipient_slot;
end;
$$;

create or replace function public.employee_referral_start_provider_attempt(
  p_period_start_local date,
  p_period_end_local_exclusive date,
  p_revision integer,
  p_recipient_slot text,
  p_lease_token uuid,
  p_provider_request_fingerprint text,
  p_idempotency_key text
)
returns setof public.employee_referral_report_recipient_deliveries
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.employee_referral_lock_period(p_period_start_local, p_period_end_local_exclusive);
  if p_provider_request_fingerprint is null
    or p_provider_request_fingerprint !~ '^hmac-sha256:[0-9a-f]{64}$'
    or p_idempotency_key is null
    or p_idempotency_key !~ '^employee-referral-[0-9a-f]{64}$' then
    raise exception 'valid provider request fingerprint and idempotency key are required';
  end if;
  return query
  update public.employee_referral_report_recipient_deliveries delivery
  set provider_request_fingerprint = coalesce(delivery.provider_request_fingerprint,
        p_provider_request_fingerprint),
      idempotency_key = coalesce(delivery.idempotency_key, p_idempotency_key),
      first_provider_attempt_at = coalesce(delivery.first_provider_attempt_at, now()),
      idempotency_expires_at = coalesce(delivery.idempotency_expires_at,
        now() + interval '24 hours'),
      error_code = null
  where delivery.period_start_local = p_period_start_local
    and delivery.period_end_local_exclusive = p_period_end_local_exclusive
    and delivery.revision = p_revision
    and delivery.recipient_slot = p_recipient_slot
    and delivery.delivery_channel = 'resend'
    and delivery.status = 'sending'
    and delivery.lease_token = p_lease_token
    and delivery.lease_expires_at > now()
    and (delivery.provider_request_fingerprint is null
      or delivery.provider_request_fingerprint = p_provider_request_fingerprint)
    and (delivery.idempotency_key is null or delivery.idempotency_key = p_idempotency_key)
    and (delivery.idempotency_expires_at is null
      or delivery.error_code = 'retry_proven_preacceptance'
      or now() < delivery.idempotency_expires_at - interval '5 minutes')
    and exists (
      select 1
      from public.employee_referral_report_runs report
      where report.period_start_local = p_period_start_local
        and report.period_end_local_exclusive = p_period_end_local_exclusive
        and report.revision = p_revision
        and report.status in (
          'sending', 'provider_accepted', 'partially_delivered', 'ambiguous'
        )
    )
    and not exists (
      select 1
      from public.employee_referral_report_runs successor
      where successor.period_start_local = p_period_start_local
        and successor.period_end_local_exclusive = p_period_end_local_exclusive
        and successor.supersedes_revision = p_revision
    )
  returning delivery.*;
  if not found then
    raise exception 'employee referral provider attempt rejected by lease or frozen request';
  end if;
end;
$$;

create or replace function public.employee_referral_finalize_provider_attempt(
  p_period_start_local date,
  p_period_end_local_exclusive date,
  p_revision integer,
  p_recipient_slot text,
  p_lease_token uuid,
  p_status text,
  p_provider_message_id text default null,
  p_error_code text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parent_state text;
begin
  perform public.employee_referral_lock_period(p_period_start_local, p_period_end_local_exclusive);
  if p_status is null
    or p_status not in ('provider_accepted', 'transport_failed', 'ambiguous') then
    raise exception 'invalid employee referral provider finalization status';
  end if;
  if p_status = 'provider_accepted' and coalesce(trim(p_provider_message_id), '') = '' then
    raise exception 'provider acceptance requires a provider message id';
  end if;
  if p_status <> 'provider_accepted' and p_provider_message_id is not null then
    raise exception 'non-acceptance finalization cannot provide a provider message id';
  end if;
  if p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'employee referral error code must be bounded and PII-free';
  end if;

  update public.employee_referral_report_recipient_deliveries delivery
  set status = p_status,
      provider_message_id = case
        when p_status = 'provider_accepted' then p_provider_message_id
        else delivery.provider_message_id
      end,
      provider_accepted_at = case
        when p_status = 'provider_accepted' then now()
        else delivery.provider_accepted_at
      end,
      provider_last_event = case
        when p_status = 'provider_accepted' then 'accepted'
        else delivery.provider_last_event
      end,
      error_code = p_error_code,
      lease_token = null,
      lease_expires_at = null
  where delivery.period_start_local = p_period_start_local
    and delivery.period_end_local_exclusive = p_period_end_local_exclusive
    and delivery.revision = p_revision
    and delivery.recipient_slot = p_recipient_slot
    and delivery.status = 'sending'
    and delivery.lease_token = p_lease_token
    and delivery.lease_expires_at > now()
    and delivery.provider_request_fingerprint is not null
    and delivery.idempotency_key is not null
    and delivery.first_provider_attempt_at is not null
    and delivery.idempotency_expires_at is not null;
  if not found then
    if exists (
      select 1 from public.employee_referral_report_recipient_deliveries delivery
      where delivery.period_start_local = p_period_start_local
        and delivery.period_end_local_exclusive = p_period_end_local_exclusive
        and delivery.revision = p_revision
        and delivery.recipient_slot = p_recipient_slot
        and delivery.status = p_status
        and delivery.provider_message_id is not distinct from p_provider_message_id
    ) then
      return public.employee_referral_refresh_parent(
        p_period_start_local, p_period_end_local_exclusive, p_revision
      );
    end if;
    raise exception 'employee referral provider finalization rejected by stale lease';
  end if;
  parent_state := public.employee_referral_refresh_parent(
    p_period_start_local, p_period_end_local_exclusive, p_revision
  );
  return parent_state;
end;
$$;

create or replace function public.employee_referral_record_provider_event(
  p_period_start_local date,
  p_period_end_local_exclusive date,
  p_revision integer,
  p_recipient_slot text,
  p_provider_message_id text,
  p_provider_event text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  mapped_status text;
  previous_status text;
  effective_status text;
  sanitized_event text;
  head_revision integer;
  head_status text;
  parent_state text;
begin
  perform public.employee_referral_lock_period(p_period_start_local, p_period_end_local_exclusive);
  mapped_status := case p_provider_event
    when 'sent' then 'pending'
    when 'queued' then 'pending'
    when 'scheduled' then 'pending'
    when 'delivery_delayed' then 'delivery_delayed'
    when 'delivered' then 'delivered'
    when 'opened' then 'delivered'
    when 'clicked' then 'delivered'
    when 'complained' then 'complained'
    when 'failed' then 'delivery_failed'
    when 'delivery_failed' then 'delivery_failed'
    when 'bounced' then 'bounced'
    when 'suppressed' then 'suppressed'
    when 'canceled' then 'canceled'
    else 'unknown_event'
  end;
  sanitized_event := case
    when p_provider_event ~ '^[a-z_]{1,64}$' then p_provider_event
    else 'unknown'
  end;
  select delivery.status into previous_status
  from public.employee_referral_report_recipient_deliveries delivery
  where delivery.period_start_local = p_period_start_local
    and delivery.period_end_local_exclusive = p_period_end_local_exclusive
    and delivery.revision = p_revision
    and delivery.recipient_slot = p_recipient_slot
    and delivery.provider_message_id = p_provider_message_id
    and delivery.delivery_channel = 'resend'
  for update;
  if not found then
    raise exception 'employee referral provider event did not match a delivery slot';
  end if;

  effective_status := case
    when previous_status = 'complained' or mapped_status = 'complained' then 'complained'
    when previous_status = 'delivered' then 'delivered'
    when mapped_status = 'delivered' then 'delivered'
    when previous_status in ('delivery_failed', 'bounced', 'suppressed', 'canceled')
      then previous_status
    when mapped_status in (
      'delivery_failed', 'bounced', 'suppressed', 'canceled'
    ) then mapped_status
    when previous_status in ('unknown_event', 'status_unverifiable') then previous_status
    when mapped_status = 'unknown_event' then mapped_status
    else mapped_status
  end;

  update public.employee_referral_report_recipient_deliveries delivery
  set status = effective_status,
      provider_last_event = case
        when effective_status = previous_status and mapped_status <> effective_status
          then delivery.provider_last_event
        else sanitized_event
      end,
      delivered_at = case
        when effective_status in ('delivered', 'complained')
          then coalesce(delivery.delivered_at, now())
        else null
      end,
      error_code = case
        when effective_status in ('delivery_failed', 'bounced', 'suppressed',
          'canceled', 'unknown_event', 'status_unverifiable')
          then coalesce(delivery.error_code, 'provider_terminal_event')
        else null
      end
  where delivery.period_start_local = p_period_start_local
    and delivery.period_end_local_exclusive = p_period_end_local_exclusive
    and delivery.revision = p_revision
    and delivery.recipient_slot = p_recipient_slot
    and delivery.provider_message_id = p_provider_message_id
    and delivery.delivery_channel = 'resend';
  parent_state := public.employee_referral_refresh_parent(
    p_period_start_local, p_period_end_local_exclusive, p_revision
  );

  if effective_status in (
      'delivery_failed', 'bounced', 'suppressed', 'canceled',
      'unknown_event', 'status_unverifiable'
    )
    and previous_status not in (
      'delivery_failed', 'bounced', 'suppressed', 'canceled',
      'unknown_event', 'status_unverifiable'
    ) then
    select report.revision, report.status into head_revision, head_status
    from public.employee_referral_report_runs report
    where report.period_start_local = p_period_start_local
      and report.period_end_local_exclusive = p_period_end_local_exclusive
    order by report.revision desc
    limit 1;
    if head_status <> 'delivered' then
      insert into public.employee_referral_report_correction_proposals (
        period_start_local, period_end_local_exclusive, predecessor_revision,
        kind, cause_code
      ) select p_period_start_local, p_period_end_local_exclusive, head_revision,
        'delivery_recovery', 'provider_terminal'
      where not exists (
        select 1 from public.employee_referral_report_correction_proposals proposal
        where proposal.period_start_local = p_period_start_local
          and proposal.period_end_local_exclusive = p_period_end_local_exclusive
          and proposal.predecessor_revision = head_revision
          and proposal.kind = 'delivery_recovery'
          and proposal.cause_code = 'provider_terminal'
          and proposal.status in ('open', 'promoted')
      );
      update public.employee_referral_report_runs
      set status = 'attention_required', delivered_at = null
      where period_start_local = p_period_start_local
        and period_end_local_exclusive = p_period_end_local_exclusive
        and revision = head_revision;
      parent_state := 'attention_required';
    end if;
  end if;
  return parent_state;
end;
$$;

create or replace function public.employee_referral_mark_delivery_deadline(
  p_period_start_local date,
  p_period_end_local_exclusive date,
  p_revision integer,
  p_recipient_slot text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  head_revision integer;
  head_status text;
  target_revision integer;
  recovery_cause text;
begin
  perform public.employee_referral_lock_period(p_period_start_local, p_period_end_local_exclusive);
  select report.revision, report.status into head_revision, head_status
  from public.employee_referral_report_runs report
  where report.period_start_local = p_period_start_local
    and report.period_end_local_exclusive = p_period_end_local_exclusive
  order by report.revision desc
  limit 1;
  if head_revision is null then
    raise exception 'employee referral report period was not found';
  end if;
  if not exists (
    select 1 from public.employee_referral_report_runs report
    where report.period_start_local = p_period_start_local
      and report.period_end_local_exclusive = p_period_end_local_exclusive
      and report.revision = p_revision
      and now() >= report.recovery_eligible_at
  ) then
    raise exception 'employee referral delivery is not recovery eligible';
  end if;
  update public.employee_referral_report_recipient_deliveries delivery
  set status = 'status_unverifiable',
      error_code = case
        when delivery.status = 'ambiguous' then 'dispatch_unresolved'
        else 'delivery_status_unverifiable'
      end
  where delivery.period_start_local = p_period_start_local
    and delivery.period_end_local_exclusive = p_period_end_local_exclusive
    and delivery.revision = p_revision
    and delivery.recipient_slot = p_recipient_slot
    and delivery.delivery_channel = 'resend'
    and (
      (
        delivery.provider_message_id is not null
        and delivery.status in ('provider_accepted', 'pending', 'delivery_delayed')
      )
      or (
        p_revision = head_revision
        and delivery.provider_message_id is null
        and delivery.status = 'ambiguous'
        and delivery.idempotency_expires_at is not null
        and now() >= delivery.idempotency_expires_at - interval '5 minutes'
      )
    )
  returning case
    when provider_message_id is null then 'dispatch_unresolved'
    else 'delivery_deadline'
  end into recovery_cause;
  if not found then
    raise exception 'employee referral delivery slot is not deadline-recoverable';
  end if;
  perform public.employee_referral_refresh_parent(
    p_period_start_local, p_period_end_local_exclusive, p_revision
  );
  if p_revision <> head_revision and head_status = 'delivered' then
    return head_status;
  end if;
  target_revision := head_revision;
  insert into public.employee_referral_report_correction_proposals (
    period_start_local, period_end_local_exclusive, predecessor_revision,
    kind, cause_code
  ) select p_period_start_local, p_period_end_local_exclusive, target_revision,
    'delivery_recovery', recovery_cause
  where not exists (
    select 1 from public.employee_referral_report_correction_proposals proposal
    where proposal.period_start_local = p_period_start_local
      and proposal.period_end_local_exclusive = p_period_end_local_exclusive
      and proposal.predecessor_revision = target_revision
      and proposal.kind = 'delivery_recovery'
      and proposal.cause_code = recovery_cause
      and proposal.status in ('open', 'promoted')
  );
  return public.employee_referral_refresh_parent(
    p_period_start_local, p_period_end_local_exclusive, target_revision
  );
end;
$$;

create or replace function public.employee_referral_open_data_drift(
  p_period_start_local date,
  p_period_end_local_exclusive date,
  p_predecessor_revision integer,
  p_proposed_payload_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result_id uuid;
begin
  perform public.employee_referral_lock_period(p_period_start_local, p_period_end_local_exclusive);
  if p_proposed_payload_fingerprint is null
    or p_proposed_payload_fingerprint !~ '^hmac-sha256:[0-9a-f]{64}$' then
    raise exception 'valid proposed payload fingerprint is required';
  end if;
  if not exists (
    select 1
    from public.employee_referral_report_runs report
    where report.period_start_local = p_period_start_local
      and report.period_end_local_exclusive = p_period_end_local_exclusive
      and report.revision = p_predecessor_revision
      and report.status = 'delivered'
      and not exists (
        select 1
        from public.employee_referral_report_runs successor
        where successor.period_start_local = report.period_start_local
          and successor.period_end_local_exclusive = report.period_end_local_exclusive
          and successor.supersedes_revision = report.revision
      )
  ) then
    raise exception 'data drift predecessor must be the delivered authoritative head';
  end if;
  select proposal.proposal_id into result_id
  from public.employee_referral_report_correction_proposals proposal
  where proposal.period_start_local = p_period_start_local
    and proposal.period_end_local_exclusive = p_period_end_local_exclusive
    and proposal.predecessor_revision = p_predecessor_revision
    and proposal.kind = 'data_drift'
    and proposal.proposed_payload_fingerprint = p_proposed_payload_fingerprint
    and proposal.status in ('open', 'promoted');
  if result_id is null then
    insert into public.employee_referral_report_correction_proposals (
      period_start_local, period_end_local_exclusive, predecessor_revision,
      kind, cause_code, proposed_payload_fingerprint
    ) values (
      p_period_start_local, p_period_end_local_exclusive, p_predecessor_revision,
      'data_drift', 'payload_changed', p_proposed_payload_fingerprint
    ) returning proposal_id into result_id;
  end if;
  return result_id;
end;
$$;

create or replace function public.employee_referral_dismiss_data_drift(
  p_proposal_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  proposal public.employee_referral_report_correction_proposals%rowtype;
  proposal_period_start date;
  proposal_period_end date;
begin
  if p_reason is null or length(trim(p_reason)) not between 1 and 1000 then
    raise exception 'nonblank bounded dismissal reason is required';
  end if;
  select p.period_start_local, p.period_end_local_exclusive
    into proposal_period_start, proposal_period_end
  from public.employee_referral_report_correction_proposals p
  where p.proposal_id = p_proposal_id;
  if not found then
    raise exception 'only an open data-drift proposal can be dismissed';
  end if;
  perform public.employee_referral_lock_period(
    proposal_period_start, proposal_period_end
  );
  select p.* into proposal
  from public.employee_referral_report_correction_proposals p
  where p.proposal_id = p_proposal_id
  for update;
  if not found or proposal.kind <> 'data_drift' or proposal.status <> 'open' then
    raise exception 'only an open data-drift proposal can be dismissed';
  end if;
  update public.employee_referral_report_correction_proposals
  set status = 'dismissed', decided_at = now(), decision_reason = trim(p_reason)
  where proposal_id = p_proposal_id;
  return p_proposal_id;
end;
$$;

create or replace function public.employee_referral_promote_correction(
  p_period_start_local date,
  p_period_end_local_exclusive date,
  p_predecessor_revision integer,
  p_window_start_utc timestamptz,
  p_window_end_utc timestamptz,
  p_source_set_fingerprint text,
  p_payload_fingerprint text,
  p_recipient_scope_version text,
  p_current_cohort_count integer,
  p_deprecated_review_count integer,
  p_ungoverned_source_review_count integer,
  p_total_row_count integer,
  p_mapping_review_count integer,
  p_policy_version text,
  p_policy_export_sha256 text,
  p_correction_reason text,
  p_delivery_deadline_at timestamptz,
  p_acknowledge_possible_late_delivery boolean default false,
  p_late_delivery_reason text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  head_revision integer;
  next_revision integer;
  now_at timestamptz := now();
begin
  perform public.employee_referral_lock_period(p_period_start_local, p_period_end_local_exclusive);
  select max(report.revision) into head_revision
  from public.employee_referral_report_runs report
  where report.period_start_local = p_period_start_local
    and report.period_end_local_exclusive = p_period_end_local_exclusive;
  if head_revision is null or head_revision <> p_predecessor_revision then
    raise exception 'correction predecessor is not the authoritative head';
  end if;
  if not exists (
    select 1 from public.employee_referral_report_correction_proposals proposal
    where proposal.period_start_local = p_period_start_local
      and proposal.period_end_local_exclusive = p_period_end_local_exclusive
      and proposal.predecessor_revision = p_predecessor_revision
      and proposal.status = 'open'
  ) then
    raise exception 'correction requires an open obligation';
  end if;
  if p_correction_reason is null
    or length(trim(p_correction_reason)) not between 1 and 1000 then
    raise exception 'correction reason is required';
  end if;
  if exists (
    select 1
    from public.employee_referral_report_recipient_deliveries delivery
    where delivery.period_start_local = p_period_start_local
      and delivery.period_end_local_exclusive = p_period_end_local_exclusive
      and delivery.revision = p_predecessor_revision
      and delivery.first_provider_attempt_at is not null
      and delivery.status in (
        'sending', 'provider_accepted', 'pending', 'delivery_delayed',
        'ambiguous', 'unknown_event', 'status_unverifiable'
      )
  ) and (
    p_acknowledge_possible_late_delivery is not true
    or length(trim(coalesce(p_late_delivery_reason, ''))) not between 1 and 1000
  ) then
    raise exception 'possible late delivery must be explicitly acknowledged with a reason';
  end if;
  next_revision := p_predecessor_revision + 1;
  insert into public.employee_referral_report_runs (
    period_start_local, period_end_local_exclusive, revision,
    supersedes_revision, status, window_start_utc, window_end_utc,
    source_set_fingerprint, payload_fingerprint, recipient_scope_version,
    current_cohort_count, deprecated_review_count,
    ungoverned_source_review_count, total_row_count, mapping_review_count,
    policy_version, policy_export_sha256, correction_reason, created_at,
    delivery_deadline_at, recovery_eligible_at, deadline_missed_at_creation
  ) values (
    p_period_start_local, p_period_end_local_exclusive, next_revision,
    p_predecessor_revision, 'prepared', p_window_start_utc, p_window_end_utc,
    p_source_set_fingerprint, p_payload_fingerprint, p_recipient_scope_version,
    p_current_cohort_count, p_deprecated_review_count,
    p_ungoverned_source_review_count, p_total_row_count, p_mapping_review_count,
    p_policy_version, p_policy_export_sha256, trim(p_correction_reason), now_at,
    p_delivery_deadline_at, greatest(p_delivery_deadline_at, now_at + interval '2 hours'),
    p_delivery_deadline_at < now_at
  );
  insert into public.employee_referral_report_recipient_deliveries (
    period_start_local, period_end_local_exclusive, revision,
    recipient_slot, delivery_channel, status
  ) values
    (p_period_start_local, p_period_end_local_exclusive, next_revision,
      'ta_lead', 'resend', 'prepared'),
    (p_period_start_local, p_period_end_local_exclusive, next_revision,
      'requesting_manager', 'resend', 'prepared');
  update public.employee_referral_report_correction_proposals proposal
  set status = 'promoted',
      decided_at = now_at,
      decision_reason = trim(p_correction_reason),
      promoted_revision = next_revision
  where proposal.period_start_local = p_period_start_local
    and proposal.period_end_local_exclusive = p_period_end_local_exclusive
    and proposal.predecessor_revision = p_predecessor_revision
    and proposal.status = 'open';
  return next_revision;
end;
$$;

create or replace function public.employee_referral_record_manual_delivery(
  p_period_start_local date,
  p_period_end_local_exclusive date,
  p_revision integer,
  p_recipient_slot text,
  p_delivered_at timestamptz,
  p_manual_evidence_ref text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.employee_referral_lock_period(p_period_start_local, p_period_end_local_exclusive);
  if p_period_start_local <> date '2026-04-01'
    or p_period_end_local_exclusive <> date '2026-07-01'
    or p_revision <> 1 then
    raise exception 'manual delivery is fenced to the initial April-June revision 1';
  end if;
  if p_delivered_at is null
    or p_manual_evidence_ref is null
    or length(trim(p_manual_evidence_ref)) not between 1 and 256 then
    raise exception 'manual delivery requires timestamp and opaque evidence reference';
  end if;
  update public.employee_referral_report_recipient_deliveries delivery
  set status = 'manual_delivered',
      manual_evidence_ref = trim(p_manual_evidence_ref),
      delivered_at = p_delivered_at
  where delivery.period_start_local = p_period_start_local
    and delivery.period_end_local_exclusive = p_period_end_local_exclusive
    and delivery.revision = 1
    and delivery.recipient_slot = p_recipient_slot
    and delivery.delivery_channel = 'manual_corporate_email'
    and delivery.status = 'prepared';
  if not found and not exists (
    select 1 from public.employee_referral_report_recipient_deliveries delivery
    where delivery.period_start_local = p_period_start_local
      and delivery.period_end_local_exclusive = p_period_end_local_exclusive
      and delivery.revision = 1
      and delivery.recipient_slot = p_recipient_slot
      and delivery.status = 'manual_delivered'
      and delivery.manual_evidence_ref = trim(p_manual_evidence_ref)
      and delivery.delivered_at = p_delivered_at
  ) then
    raise exception 'manual delivery receipt rejected by channel or state fence';
  end if;
  return public.employee_referral_refresh_parent(
    p_period_start_local, p_period_end_local_exclusive, 1
  );
end;
$$;

create or replace function public.employee_referral_upsert_reconciliation_issue(
  p_period_start_local date,
  p_period_end_local_exclusive date,
  p_revision integer,
  p_issue_code text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_issue_code is null or p_issue_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'reconciliation issue code must be bounded and PII-free';
  end if;
  perform public.employee_referral_lock_period(p_period_start_local, p_period_end_local_exclusive);
  insert into public.employee_referral_report_reconciliation_issues (
    period_start_local, period_end_local_exclusive, revision, issue_code
  ) values (
    p_period_start_local, p_period_end_local_exclusive, p_revision, p_issue_code
  ) on conflict (period_start_local, period_end_local_exclusive, revision, issue_code)
  do update set status = 'open', last_seen_at = now(), resolved_at = null,
    resolution_reason = null;
  return p_issue_code;
end;
$$;

create or replace function public.employee_referral_resolve_reconciliation_issue(
  p_period_start_local date,
  p_period_end_local_exclusive date,
  p_revision integer,
  p_issue_code text,
  p_reason text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_reason is null or length(trim(p_reason)) not between 1 and 1000 then
    raise exception 'reconciliation resolution requires a signed nonblank reason';
  end if;
  perform public.employee_referral_lock_period(p_period_start_local, p_period_end_local_exclusive);
  update public.employee_referral_report_reconciliation_issues issue
  set status = 'resolved', resolved_at = now(), resolution_reason = trim(p_reason)
  where issue.period_start_local = p_period_start_local
    and issue.period_end_local_exclusive = p_period_end_local_exclusive
    and issue.revision = p_revision
    and issue.issue_code = p_issue_code
    and issue.status = 'open';
  if not found then raise exception 'open reconciliation issue was not found'; end if;
  return p_issue_code;
end;
$$;

create or replace function public.employee_referral_get_period_state(
  p_period_start_local date,
  p_period_end_local_exclusive date
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select jsonb_build_object(
    'runs', coalesce((
      select jsonb_agg(to_jsonb(report) order by report.revision)
      from public.employee_referral_report_runs report
      where report.period_start_local = p_period_start_local
        and report.period_end_local_exclusive = p_period_end_local_exclusive
    ), '[]'::jsonb),
    'deliveries', coalesce((
      select jsonb_agg(to_jsonb(delivery) order by delivery.revision, delivery.recipient_slot)
      from public.employee_referral_report_recipient_deliveries delivery
      where delivery.period_start_local = p_period_start_local
        and delivery.period_end_local_exclusive = p_period_end_local_exclusive
    ), '[]'::jsonb),
    'proposals', coalesce((
      select jsonb_agg(to_jsonb(proposal) order by proposal.detected_at, proposal.proposal_id)
      from public.employee_referral_report_correction_proposals proposal
      where proposal.period_start_local = p_period_start_local
        and proposal.period_end_local_exclusive = p_period_end_local_exclusive
    ), '[]'::jsonb),
    'issues', coalesce((
      select jsonb_agg(to_jsonb(issue) order by issue.first_seen_at, issue.issue_code)
      from public.employee_referral_report_reconciliation_issues issue
      where issue.period_start_local = p_period_start_local
        and issue.period_end_local_exclusive = p_period_end_local_exclusive
    ), '[]'::jsonb)
  );
$$;

create or replace function public.employee_referral_list_authoritative_heads()
returns table (
  period_start_local date,
  period_end_local_exclusive date,
  window_start_utc timestamptz,
  window_end_utc timestamptz,
  revision integer,
  status text,
  payload_fingerprint text,
  policy_version text,
  policy_export_sha256 text
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select report.period_start_local, report.period_end_local_exclusive,
    report.window_start_utc, report.window_end_utc, report.revision, report.status,
    report.payload_fingerprint, report.policy_version, report.policy_export_sha256
  from public.employee_referral_report_runs report
  where report.revision = (
    select max(candidate.revision)
    from public.employee_referral_report_runs candidate
    where candidate.period_start_local = report.period_start_local
      and candidate.period_end_local_exclusive = report.period_end_local_exclusive
  )
  order by report.period_start_local, report.period_end_local_exclusive;
$$;

drop function if exists public.employee_referral_list_watchdog_targets(timestamptz);

create or replace function public.employee_referral_list_watchdog_targets(
  p_now timestamptz default now()
)
returns table (
  period_start_local date,
  period_end_local_exclusive date,
  revision integer,
  parent_status text,
  recipient_slot text,
  delivery_status text,
  provider_message_id text,
  first_provider_attempt_at timestamptz,
  idempotency_expires_at timestamptz,
  recovery_eligible_at timestamptz,
  observation_expires_at timestamptz,
  authoritative_head boolean
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select report.period_start_local, report.period_end_local_exclusive,
    report.revision, report.status, delivery.recipient_slot, delivery.status,
    delivery.provider_message_id, delivery.first_provider_attempt_at,
    delivery.idempotency_expires_at,
    report.recovery_eligible_at,
    delivery.first_provider_attempt_at + interval '29 days',
    not exists (
      select 1
      from public.employee_referral_report_runs successor
      where successor.period_start_local = report.period_start_local
        and successor.period_end_local_exclusive = report.period_end_local_exclusive
        and successor.supersedes_revision = report.revision
    )
  from public.employee_referral_report_runs report
  join public.employee_referral_report_recipient_deliveries delivery
    on delivery.period_start_local = report.period_start_local
    and delivery.period_end_local_exclusive = report.period_end_local_exclusive
    and delivery.revision = report.revision
  where (
      report.status <> 'delivered'
      and not exists (
        select 1
        from public.employee_referral_report_runs successor
        where successor.period_start_local = report.period_start_local
          and successor.period_end_local_exclusive = report.period_end_local_exclusive
          and successor.supersedes_revision = report.revision
      )
    )
    or (
      delivery.provider_message_id is not null
      and delivery.first_provider_attempt_at is not null
      and p_now < delivery.first_provider_attempt_at + interval '29 days'
    )
  order by report.period_start_local, report.revision, delivery.recipient_slot;
$$;

alter table public.employee_referral_report_runs enable row level security;
alter table public.employee_referral_report_recipient_deliveries enable row level security;
alter table public.employee_referral_report_correction_proposals enable row level security;
alter table public.employee_referral_report_reconciliation_issues enable row level security;

revoke all on table public.employee_referral_report_runs from public, anon, authenticated;
revoke all on table public.employee_referral_report_recipient_deliveries from public, anon, authenticated;
revoke all on table public.employee_referral_report_correction_proposals from public, anon, authenticated;
revoke all on table public.employee_referral_report_reconciliation_issues from public, anon, authenticated;
revoke all on table public.employee_referral_report_runs from service_role;
revoke all on table public.employee_referral_report_recipient_deliveries from service_role;
revoke all on table public.employee_referral_report_correction_proposals from service_role;
revoke all on table public.employee_referral_report_reconciliation_issues from service_role;

do $$
declare
  function_signature text;
  function_name text;
begin
  for function_signature, function_name in
    select procedure.oid::regprocedure::text, procedure.proname
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname like 'employee_referral_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', function_signature);
    execute format('revoke all on function %s from service_role', function_signature);
    if function_name = any (array[
      'employee_referral_prepare_and_claim',
      'employee_referral_start_provider_attempt',
      'employee_referral_finalize_provider_attempt',
      'employee_referral_record_provider_event',
      'employee_referral_mark_delivery_deadline',
      'employee_referral_open_data_drift',
      'employee_referral_dismiss_data_drift',
      'employee_referral_promote_correction',
      'employee_referral_record_manual_delivery',
      'employee_referral_upsert_reconciliation_issue',
      'employee_referral_resolve_reconciliation_issue',
      'employee_referral_get_period_state',
      'employee_referral_list_authoritative_heads',
      'employee_referral_list_watchdog_targets'
    ]) then
      execute format('grant execute on function %s to service_role', function_signature);
    end if;
  end loop;
end;
$$;

commit;
