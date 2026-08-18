-- 019 — Durable safety stores for the Recruiting Ops Command Center (C2).
--
-- Three append-only stores behind the delivery safety machinery:
--   - recruiting_ops_delivery_ledger: the durable twin of the local JSONL
--     delivery ledger (P8 content-aware idempotency enforced by the writer;
--     recipient/payload identity lives as FINGERPRINTS only, never values).
--   - recruiting_ops_kill_switch_events: append-only operator events; current
--     switch state = the latest event per (scope, scope_id). The send
--     chokepoint's kill_switch check passes only on affirmative evidence read
--     from this table — unreachable or absent evidence stays fail-closed.
--   - recruiting_ops_autonomy_state_events: append-only promotion records;
--     current autonomy state = latest APPROVED event per deliverable. The
--     transition state machine stays in code (LEGAL_AUTONOMY_TRANSITIONS).
--
-- Schema only; writers land in lib/recruiting-ops/durable-safety-store.ts.

create table if not exists recruiting_ops_delivery_ledger (
  delivery_log_id text primary key,
  deliverable_id text not null,
  capability_id text not null,
  run_id text not null,
  event_type text not null check (event_type in (
    'shadow_run',
    'delivery_authorization',
    'delivery_attempt',
    'gate_failure',
    'auto_pause',
    'correction',
    'manual_execution_attestation',
    'kill_switch'
  )),
  status text not null,
  payload_fingerprint text not null,
  content_fingerprint text not null,
  created_at timestamptz not null,
  entry jsonb not null,
  inserted_at timestamptz not null default now()
);
create index if not exists idx_recops_delivery_ledger_deliverable
  on recruiting_ops_delivery_ledger (deliverable_id, created_at desc);

create table if not exists recruiting_ops_kill_switch_events (
  event_id text primary key,
  scope text not null check (scope in ('global','capability','deliverable','recipient_scope')),
  scope_id text not null,
  enabled boolean not null,
  reason text not null,
  updated_at timestamptz not null,
  updated_by text not null,
  entry jsonb not null,
  inserted_at timestamptz not null default now()
);
create index if not exists idx_recops_kill_switch_scope
  on recruiting_ops_kill_switch_events (scope, scope_id, updated_at desc);

create table if not exists recruiting_ops_autonomy_state_events (
  promotion_id text primary key,
  deliverable_id text not null,
  capability_id text not null,
  from_state text not null,
  requested_state text not null,
  resolved_state text not null,
  result text not null check (result in ('approved_local_state','blocked')),
  occurred_at timestamptz not null,
  entry jsonb not null,
  inserted_at timestamptz not null default now()
);
create index if not exists idx_recops_autonomy_state_deliverable
  on recruiting_ops_autonomy_state_events (deliverable_id, occurred_at desc);

-- Deny-by-default RLS, same posture as 015/018.
alter table recruiting_ops_delivery_ledger enable row level security;
alter table recruiting_ops_kill_switch_events enable row level security;
alter table recruiting_ops_autonomy_state_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
    and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table recruiting_ops_delivery_ledger from anon, authenticated;
    revoke all on table recruiting_ops_kill_switch_events from anon, authenticated;
    revoke all on table recruiting_ops_autonomy_state_events from anon, authenticated;
  else
    raise warning 'anon/authenticated roles absent (non-Supabase target): PostgREST revokes skipped; RLS deny-by-default still enforced';
  end if;
end $$;
