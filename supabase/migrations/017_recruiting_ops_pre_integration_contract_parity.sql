-- 017 (was 012; renumbered past main's parallel 010–014 lineage) — Recruiting Ops pre-integration contract parity.
--
-- Source-controlled schema only. Do not apply this migration until Operator approves
-- the production persistence boundary. It aligns the local TypeScript row
-- contracts with DDL for autonomy/output-contract fields and action proposal
-- lifecycle metadata.

-- ARCH-MIG-1 guard: the NOT-NULL-without-default alters below are valid only on
-- an empty table (or on re-apply once the columns exist). Same class-level guard
-- as migration 016 — a human "do not apply" comment is not a check.
do $$
declare
  has_rows boolean;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'recruiting_ops_output_contracts' and column_name = 'capability_id'
  ) then
    select exists (select 1 from recruiting_ops_output_contracts limit 1) into has_rows;
    if has_rows then
      raise exception
        'Migration 017 requires recruiting_ops_output_contracts to be empty: new columns are NOT NULL without defaults. Backfill or truncate deliberately before applying.';
    end if;
  end if;
end $$;

alter table recruiting_ops_output_contracts
  add column if not exists capability_id text not null,
  add column if not exists lane text not null check (lane in ('auto_delivery','review_assisted','action_proposal')),
  add column if not exists initial_autonomy_state text not null check (initial_autonomy_state in (
    'disabled',
    'dev_only',
    'shadow',
    'review_required',
    'auto_eligible',
    'auto_delivering',
    'auto_paused',
    'never_auto'
  )),
  add column if not exists freshness_ttl_minutes integer not null check (freshness_ttl_minutes > 0),
  add column if not exists stale_behavior text not null check (stale_behavior in ('warn','block')),
  add column if not exists recipient_scope_rule_ids text[] not null default '{}',
  add column if not exists delivery_log_required boolean not null default true check (delivery_log_required = true),
  add column if not exists delivery_authorization_required boolean not null default true check (delivery_authorization_required = true);

drop index if exists idx_recops_output_contracts_capability;
create index if not exists idx_recops_output_contracts_capability
  on recruiting_ops_output_contracts (capability_id);
create index if not exists idx_recops_output_contracts_lane
  on recruiting_ops_output_contracts (lane);

alter table recruiting_ops_action_proposals
  add column if not exists defer_until text,
  add column if not exists defer_reason text,
  add column if not exists manual_execution_attested_at timestamptz,
  add column if not exists manual_execution_attested_by text,
  add column if not exists external_reference text;

alter table recruiting_ops_action_proposals
  drop constraint if exists recruiting_ops_action_proposals_approval_state_check;

alter table recruiting_ops_action_proposals
  add constraint recruiting_ops_action_proposals_approval_state_check
  check (approval_state in (
    'drafted',
    'needs_review',
    'approved_for_manual_execution',
    'rejected',
    'deferred',
    'blocked',
    'executed_manually'
  ));

alter table recruiting_ops_action_proposals
  drop constraint if exists recruiting_ops_action_proposals_deferred_metadata_check;
alter table recruiting_ops_action_proposals
  add constraint recruiting_ops_action_proposals_deferred_metadata_check
  check (
    approval_state <> 'deferred'
    or (defer_until is not null and length(trim(defer_until)) > 0 and defer_reason is not null and length(trim(defer_reason)) > 0)
  );

alter table recruiting_ops_action_proposals
  drop constraint if exists recruiting_ops_action_proposals_manual_attestation_check;
alter table recruiting_ops_action_proposals
  add constraint recruiting_ops_action_proposals_manual_attestation_check
  check (
    approval_state <> 'executed_manually'
    or (manual_execution_attested_at is not null and manual_execution_attested_by is not null and length(trim(manual_execution_attested_by)) > 0)
  );
