-- Phase 1: Agency submissions table + sweep_items column additions
-- Supports stateful agency tracker and v2 UI data requirements

-- agency_submissions: stores ALL agency-sourced applications for stateful cross-reference
create table agency_submissions (
  id uuid primary key default gen_random_uuid(),
  application_id bigint unique not null,
  candidate_id bigint not null,
  candidate_email text,
  agency_source_id bigint not null,
  agency_source_name text not null,
  job_id bigint not null,
  job_title text,
  submitted_at timestamptz,
  checked_at timestamptz,
  conflict_detected boolean default false,
  conflict_type text check (conflict_type in ('prior_history', 'dual_agency')),
  conflict_detail jsonb,
  created_at timestamptz default now()
);

create index idx_agency_subs_email on agency_submissions(candidate_email);
create index idx_agency_subs_source on agency_submissions(agency_source_id);
create index idx_agency_subs_conflict on agency_submissions(conflict_detected) where conflict_detected = true;

-- New columns on sweep_items for v2 UI
alter table sweep_items add column if not exists referrer_name text;
alter table sweep_items add column if not exists recruiter_name text;
alter table sweep_items add column if not exists urgency_tier text check (urgency_tier in ('breach', 'sla_risk', 'alerted', 'new', 'actioned'));
