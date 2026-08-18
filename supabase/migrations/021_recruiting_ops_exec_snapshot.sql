-- 021 — Exec state-of-play snapshot + funnel columns on the stage taxonomy.
--
-- The run store deliberately persists public-safe summaries, never row
-- content, so a serverless page cannot read per-req facts from anything that
-- exists. This table is the FIRST row-content store in the plane, scoped to
-- exactly what the /state-of-play page renders: per-req fact rows whose only
-- person-identifying content is finalist candidate NAMES + Greenhouse profile
-- URLs (no emails, no phone numbers, no raw application ids), the org rollup,
-- and the ELT facts artifact. One row per E01 run; the page reads the latest.
--
-- Also extends the interview-stage taxonomy with the exec funnel mapping:
-- stage_class (rps/technical/onsite) answers T05's 3-class question; the exec
-- funnel needs the full 8-stage ordinal. Rows without funnel_stage simply
-- don't join the governed funnel map (heuristic fallback + a named gap).

create table if not exists recruiting_ops_exec_snapshot (
  snapshot_id uuid primary key default gen_random_uuid(),
  run_id text not null unique,
  workflow_id text not null default 'E01',
  mode text not null check (mode in ('fixture','local','shadow','production_disabled')),
  generated_at timestamptz not null,
  org_rollup jsonb not null,
  req_rows jsonb not null,
  hires jsonb not null,
  elt_facts jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_recops_exec_snapshot_generated
  on recruiting_ops_exec_snapshot (generated_at desc);

alter table recruiting_ops_interview_stage_taxonomy
  add column if not exists funnel_stage text
  check (funnel_stage is null or funnel_stage in (
    'Sourced','Application Review','Recruiter Phone Screen','Hiring Manager Review',
    'Manager / Tech Screen','Skills Assessment','Onsite Interview','Offer'
  ));

-- Deny-by-default RLS, same posture as 015/018/019: RLS with NO policies;
-- PostgREST roles revoked behind the role guard.
alter table recruiting_ops_exec_snapshot enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
    and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table recruiting_ops_exec_snapshot from anon, authenticated;
  else
    raise warning 'anon/authenticated roles absent (non-Supabase target): PostgREST revokes skipped; RLS deny-by-default still enforced';
  end if;
end $$;
