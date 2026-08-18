-- 018 — Governed dimension tables for the Recruiting Ops Command Center (C2).
--
-- Moves recruiter→team→HOD attribution from compiled fixture config to a
-- governed table (the C1b live runs surfaced real roster drift: recruiter
-- names present in Greenhouse but absent from the compiled v1 config), and
-- gives T05's interview-stage classification a governed override table (slot
-- labels are org-specific; heuristics remain the fallback for unlisted labels).
--
-- Also realigns the recruiting_ops_runs mode check with the application's
-- CommandCenterMode vocabulary: the TypeScript union is
-- 'fixture' | 'local' | 'shadow' | 'production_disabled' — migration 015
-- carried 'production', a value the application can never produce.
--
-- Schema + seed-target only; the seed itself runs from
-- scripts/recruiting-ops-seed-roster.ts (idempotent upserts).

create table if not exists recruiting_ops_recruiter_roster (
  id uuid primary key default gen_random_uuid(),
  recruiter_name text not null,
  team_id text not null,
  team_name text not null,
  hod_name text not null,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (recruiter_name, team_id)
);
create index if not exists idx_recops_roster_recruiter
  on recruiting_ops_recruiter_roster (lower(recruiter_name));

create table if not exists recruiting_ops_interview_stage_taxonomy (
  stage_label text primary key,
  stage_class text not null check (stage_class in ('rps','technical','onsite')),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table recruiting_ops_runs
  drop constraint if exists recruiting_ops_runs_mode_check;
alter table recruiting_ops_runs
  add constraint recruiting_ops_runs_mode_check
  check (mode in ('fixture','local','shadow','production_disabled'));

-- Deny-by-default RLS, same posture as 015: RLS with NO policies; PostgREST
-- roles revoked behind the role guard (non-Supabase targets warn loudly).
alter table recruiting_ops_recruiter_roster enable row level security;
alter table recruiting_ops_interview_stage_taxonomy enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
    and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table recruiting_ops_recruiter_roster from anon, authenticated;
    revoke all on table recruiting_ops_interview_stage_taxonomy from anon, authenticated;
  else
    raise warning 'anon/authenticated roles absent (non-Supabase target): PostgREST revokes skipped; RLS deny-by-default still enforced';
  end if;
end $$;
