-- Agency YTD handling + fee-risk workbench fields.
-- These columns enrich the historical YTD fact store only; operational tracker
-- tables remain the source of truth for live alerts.

alter table ytd_application_facts add column if not exists department_id bigint;
alter table ytd_application_facts add column if not exists department_name text;
alter table ytd_application_facts add column if not exists submitted_at timestamptz;
alter table ytd_application_facts add column if not exists first_action_at timestamptz;
alter table ytd_application_facts add column if not exists first_action_time_hours float;
alter table ytd_application_facts add column if not exists action_bucket text
  check (
    action_bucket is null or action_bucket in (
      'lt_24h',
      'h24_48',
      'd2_7',
      'gt_7d',
      'unactioned_lt_7d',
      'unactioned_gt_7d',
      'unknown'
    )
  );
alter table ytd_application_facts add column if not exists duplicate_confidence text
  check (
    duplicate_confidence is null or duplicate_confidence in (
      'confirmed',
      'high',
      'possible',
      'none',
      'insufficient_data'
    )
  );
alter table ytd_application_facts add column if not exists duplicate_evidence_types text[] not null default '{}';
alter table ytd_application_facts add column if not exists duplicate_candidate_ids bigint[] not null default '{}';
alter table ytd_application_facts add column if not exists fee_risk_state text
  check (
    fee_risk_state is null or fee_risk_state in (
      'not_duplicate',
      'cleared_in_window',
      'pending_in_window',
      'at_risk',
      'exposed',
      'insufficient_data'
    )
  );
alter table ytd_application_facts add column if not exists fee_risk_reason text;

create index if not exists idx_ytd_facts_agency_department
  on ytd_application_facts(scan_year, channel, department_id);
create index if not exists idx_ytd_facts_agency_source
  on ytd_application_facts(scan_year, channel, agency_source_id);
create index if not exists idx_ytd_facts_agency_bucket
  on ytd_application_facts(scan_year, channel, action_bucket);
create index if not exists idx_ytd_facts_agency_duplicate
  on ytd_application_facts(scan_year, channel, duplicate_confidence);
create index if not exists idx_ytd_facts_agency_fee_risk
  on ytd_application_facts(scan_year, channel, fee_risk_state);
create index if not exists idx_ytd_facts_submitted_at
  on ytd_application_facts(scan_year, channel, submitted_at desc);
create index if not exists idx_ytd_facts_duplicate_evidence
  on ytd_application_facts using gin(duplicate_evidence_types);
create index if not exists idx_ytd_facts_duplicate_candidate_ids
  on ytd_application_facts using gin(duplicate_candidate_ids);
