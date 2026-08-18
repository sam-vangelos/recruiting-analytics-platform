-- supabase/migrations/006_notification_delivery.sql
-- Notification delivery model: operational delivery state for referral + agency
-- sweep alerts, decoupled from urgency classification.
--
-- Three concerns, three storage shapes, one worker:
--   * Urgency stays where it is (sweep_items.urgency_tier) — UNTOUCHED here.
--   * INTENT (what should be delivered) lives in notification_outbox, written by
--     sweeps under a deterministic dedupe_key.
--   * ATTEMPT (what physically happened) lives in append-only
--     notification_delivery_attempts, carrying the Slack `ts` slack-notify.ts
--     already returns and currently discards.
--
-- This migration is SCHEMA ONLY. The drain worker + send wiring is W3 — not built
-- here. Operational tables ONLY: ytd_* never read/write these (migration 003/004
-- isolation canon). recipient_user_id NULL is a data-quality DEFECT, surfaced via
-- recipient_resolution_status — never the literal "Unknown"/"UNASSIGNED".
--
-- Apply via Supabase dashboard SQL editor or `supabase db push`. Idempotent.

-- gen_random_uuid() is provided by pgcrypto on this project's Postgres version.
create extension if not exists pgcrypto;

-- INTENT: one row per (channel, application_id, reason). Idempotent via dedupe_key.
create table if not exists notification_outbox (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null,                  -- '{channel}:{application_id}:{reason}'
  channel text not null check (channel in ('referral','agency')),
  notification_type text not null
    check (notification_type in ('referral_alert','agency_conflict','agency_dual_agency','escalation')),
  reason text not null                        -- referral: 'sla_alerted'|'sla_risk'|'breach'; agency: 'prior_history'|'dual_agency'
    check (reason in ('sla_alerted','sla_risk','breach','prior_history','dual_agency')),
  application_id bigint not null,
  candidate_id bigint,
  job_id bigint,
  recipient_user_id text,                     -- NULL is a DEFECT, never a label
  recipient_resolution_status text not null default 'resolved'
    check (recipient_resolution_status in ('resolved','unresolved','ambiguous')),
  delivery_target text not null default 'slack_dm'
    check (delivery_target in ('slack_dm','email','dashboard_only')),
  payload jsonb not null,                     -- denormalized render snapshot; drain never re-hits Greenhouse
  status text not null default 'pending'
    check (status in ('pending','sending','sent','failed','suppressed')),
  attempt_count int not null default 0,
  max_attempts int not null default 5,
  next_attempt_at timestamptz not null default now(),
  leased_until timestamptz,
  last_delivery_attempt_id uuid,
  suppression_reason text
    check (suppression_reason in
      ('policy_disabled','recipient_unresolved','resolved_before_send','duplicate_window','backfill_predates_log')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint notification_outbox_dedupe_key_uniq unique (dedupe_key)
);
create index if not exists idx_outbox_claimable on notification_outbox (next_attempt_at) where status = 'pending';
create index if not exists idx_outbox_leases on notification_outbox (leased_until) where status = 'sending';
create index if not exists idx_outbox_app on notification_outbox (channel, application_id);

-- ATTEMPT: append-only audit of physical Slack sends. Carries the ts slack-notify.ts already returns.
create table if not exists notification_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('referral','agency')),
  notification_type text not null,
  recipient_user_id text,
  delivery_target text not null,
  status text not null check (status in ('sent','failed','suppressed')),
  provider text not null default 'slack',
  provider_message_id text,                   -- Slack chat.postMessage ts (currently discarded)
  outbox_ids uuid[] not null,                 -- intents this single Slack message covered (batch fan-in)
  intent_count int not null,
  error_message text,
  suppression_reason text,
  attempted_at timestamptz not null default now(),
  sent_at timestamptz,
  metadata jsonb                              -- { slack_channel_id, batch_render:'detail'|'summary', sla_violation_count }
);
create index if not exists idx_delivery_attempts_recipient on notification_delivery_attempts (recipient_user_id, attempted_at desc);
create index if not exists idx_delivery_attempts_status on notification_delivery_attempts (status, attempted_at desc);

-- GRAFT (C2): per-application read view for the Live surfaces (unnest the batch fan-in).
create or replace view notification_delivery_by_application as
select unnest(a.outbox_ids) as outbox_id, o.application_id, o.channel,
       o.status as outbox_status, o.suppression_reason, o.sent_at,
       a.provider_message_id, a.status as attempt_status, a.attempted_at
from notification_delivery_attempts a
join notification_outbox o on o.id = any(a.outbox_ids);

-- Atomic claim: lease a bounded batch of due pending intents. SKIP LOCKED => no double-send.
create or replace function claim_notification_outbox(p_limit int, p_lease_seconds int)
returns setof notification_outbox language plpgsql as $$
begin
  return query
  update notification_outbox o
     set status = 'sending',
         leased_until = now() + make_interval(secs => p_lease_seconds),
         attempt_count = o.attempt_count + 1,
         updated_at = now()
   where o.id in (
     select id from notification_outbox
      where status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at
      for update skip locked
      limit p_limit)
   returning o.*;
end; $$;

-- Reaper: return leaked 'sending' leases to 'pending' so a crashed drain self-heals.
create or replace function reap_stale_notification_leases()
returns int language plpgsql as $$
declare reaped int;
begin
  update notification_outbox set status='pending', leased_until=null, updated_at=now()
   where status='sending' and leased_until < now();
  get diagnostics reaped = row_count;
  return reaped;
end; $$;

-- NOTE: alert_ledger.slack_ts is now DEAD (superseded by delivery_attempts.provider_message_id).
-- Left in place this migration; drop in a later non-destructive cleanup once nothing reads it.
