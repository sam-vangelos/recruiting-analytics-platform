import { drain, enqueueEscalations, enqueuePending, reap } from "@/lib/notification-delivery"
import { readEnv } from "@/lib/env"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireCronSecret,
} from "../../ytd/route-utils"

// Sane bound: drain() claims at most batchLimit intents (default 50) and does one
// Slack round-trip per intent. 120s mirrors the sweep crons and leaves ample headroom
// over the lib's 120s lease — a drain tick finishes well inside this.
export const maxDuration = 120

// Node runtime: the drain opens a Slack conversation + posts via fetch and talks to
// Supabase through the service client; no edge-incompatible deps, but pin Node so the
// supabase client and process.env-backed gates behave as in the sweeps.
export const runtime = "nodejs"

/**
 * notify-drain (W3) — the outbox drain worker's cron entrypoint.
 *
 * Decoupled from the sweep cadence on purpose: the sweeps capture INTENT into
 * notification_outbox; this cron owns SEND. Three ordered phases, each surfaced in the
 * response so a cron log line tells the whole story:
 *
 *   1. enqueuePending() — scan alert_ledger for alerts lacking an outbox row and
 *      materialize their current intent (idempotent on dedupe_key; a re-run inserts 0).
 *   2. reap()           — return any leaked 'sending' leases to 'pending' so a crashed
 *      prior tick self-heals before we claim. (drain() also reaps internally; this
 *      explicit call surfaces the count and guarantees a clean slate pre-claim — the
 *      second reap inside drain() then finds nothing.)
 *   3. drain(batchLimit) — claim a bounded batch under FOR UPDATE SKIP LOCKED and
 *      deliver each: gate off => suppressed(policy_disabled); recipient unresolved =>
 *      suppressed(recipient_unresolved); else POST to Slack and record sent/failed.
 *
 * Returns the four canonical counts {enqueued, sent, suppressed, failed} the task
 * contracts, plus reaped/claimed/byChannel for observability. Send stays behavior-
 * neutral until NOTIFY_REFERRAL_SEND / NOTIFY_AGENCY_SEND are explicitly "true";
 * everything else suppresses with a full would-send audit row.
 */
export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  // Activation gate (default OFF): the enqueue/claim/drain phases below read and write
  // the 006 notification_outbox/notification_delivery_attempts tables and the enqueue
  // loaders SELECT 005-only columns, so invoking this route before migrations 005/006
  // are applied would 500. Until NOTIFY_DELIVERY_ENABLED is explicitly "true", skip the
  // whole pipeline and return a clean no-op — deploy is behavior-neutral and pre-005/006
  // safe. The per-channel send gates (NOTIFY_REFERRAL_SEND / NOTIFY_AGENCY_SEND) still
  // govern actual send once this is on.
  if (readEnv("NOTIFY_DELIVERY_ENABLED")?.toLowerCase() !== "true") {
    return noStoreJson({
      skipped: true,
      reason: "notification delivery not activated",
    })
  }

  try {
    const enqueue = await enqueuePending()
    // P5: escalation enqueue pass (unresolved past window -> email intents). Gated default-OFF by
    // NOTIFY_ESCALATION_ENABLED so the deploy is behavior-neutral AND safe BEFORE migration 008
    // (which adds 'escalation' to the reason CHECK) is applied — otherwise the reason='escalation'
    // upsert would fail the CHECK and break the whole drain cron. Activation order: apply 008 ->
    // flip NOTIFY_ESCALATION_ENABLED (intents enqueue, drain suppresses policy_disabled while
    // NOTIFY_EMAIL_SEND is off) -> set Resend env + NOTIFY_EMAIL_SEND. Self-gated further on the
    // resolver health interlock inside enqueueEscalations.
    const escalation =
      readEnv("NOTIFY_ESCALATION_ENABLED")?.toLowerCase() === "true"
        ? await enqueueEscalations()
        : { candidates: 0, inserted: 0, skipped_resolver_unhealthy: false }
    const reaped = await reap()
    const drainResult = await drain()

    return noStoreJson({
      enqueued: enqueue.inserted,
      escalations_enqueued: escalation.inserted,
      escalation_skipped_resolver_unhealthy: escalation.skipped_resolver_unhealthy,
      sent: drainResult.sent,
      suppressed: drainResult.suppressed,
      failed: drainResult.failed,
      reaped,
      claimed: drainResult.claimed,
      byChannel: enqueue.byChannel,
    })
  } catch (err) {
    return noStoreServerErrorJson("cron/notify-drain", err)
  }
}
