-- 008 — extend notification_outbox.reason CHECK to allow 'escalation' (P5 email escalation).
--
-- WHY A SEPARATE MIGRATION (not an edit to 006): 006 is already APPLIED in prod (live
-- notification_outbox rows + sent DMs). Editing the applied file's text would desync the
-- canonical migration history from what actually ran — the green-build-that-lies trap 007's
-- header warns about. This is the additive forward delta; 006 stays immutable.
--
-- The escalation intent carries reason='escalation' so its dedupe_key ({channel}:{app}:escalation)
-- is distinct from the original alert intent's key and the idempotent upsert never collapses them.
--
-- 006 wrote the reason CHECK as an INLINE UNNAMED constraint. Discover it via pg_constraint
-- (its system-generated name is non-deterministic) and drop it, then re-add a NAMED constraint
-- with 'escalation' so future edits/rollbacks are deterministic. Idempotent: re-running finds the
-- already-widened named constraint and the lookup matches nothing to drop.

do $$
declare
  cname text;
begin
  -- Find the reason CHECK that still lacks 'escalation' (the original 006 inline one, or none).
  select conname into cname
  from pg_constraint
  where conrelid = 'notification_outbox'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%reason%in%sla_alerted%'
    and pg_get_constraintdef(oid) not ilike '%escalation%';
  if cname is not null then
    execute format('alter table notification_outbox drop constraint %I', cname);
  end if;
end $$;

alter table notification_outbox
  drop constraint if exists notification_outbox_reason_check;

alter table notification_outbox
  add constraint notification_outbox_reason_check
  check (reason in ('sla_alerted','sla_risk','breach','prior_history','dual_agency','escalation'));
