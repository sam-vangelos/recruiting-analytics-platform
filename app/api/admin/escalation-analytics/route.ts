import { supabase } from "@/lib/supabase"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireCronSecret,
} from "../../ytd/route-utils"

export const runtime = "nodejs"

// P5 escalation analytics (CRON_SECRET-gated, read-only). Answers the three questions the operator asked,
// per escalated application + in aggregate:
//   1. Did it resolve BEFORE the escalation email was sent? (the Slack DM did its job)
//   2. How long AFTER the escalation email did it resolve?
//   3. Was the Slack DM acted on? — Slack exposes NO read receipt for bot DMs, so "opened" is not
//      measurable. The honest proxy: did the candidate resolve after the first Slack DM but before
//      the email (Slack worked) vs only after the email (Slack alone didn't move it). We surface
//      time-to-resolve from BOTH the first Slack DM and the escalation email so the gap is visible.
function hoursBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const h = (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000
  return Number.isFinite(h) ? Math.round(h * 10) / 10 : null
}

export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  const [outboxRes, attemptsRes, ledgerRes] = await Promise.all([
    supabase
      .from("notification_outbox")
      .select("id, application_id, channel, notification_type")
      .range(0, 99999),
    supabase
      .from("notification_delivery_attempts")
      .select("notification_type, status, sent_at, outbox_ids, provider")
      .range(0, 99999),
    supabase
      .from("alert_ledger")
      .select("application_id, sweep_type, first_alerted_at, resolved_at, resolution_type")
      .range(0, 99999),
  ])
  for (const r of [outboxRes, attemptsRes, ledgerRes]) {
    if (r.error) return noStoreServerErrorJson("api/admin/escalation-analytics", r.error)
  }

  const outbox = (outboxRes.data ?? []) as Array<{
    id: string
    application_id: number
    channel: string
    notification_type: string
  }>
  const attempts = (attemptsRes.data ?? []) as Array<{
    notification_type: string
    status: string
    sent_at: string | null
    outbox_ids: string[]
    provider: string
  }>
  const ledger = (ledgerRes.data ?? []) as Array<{
    application_id: number
    sweep_type: string
    first_alerted_at: string | null
    resolved_at: string | null
    resolution_type: string | null
  }>

  const outboxById = new Map(outbox.map((o) => [o.id, o]))
  const ledgerByApp = new Map(ledger.map((l) => [`${l.sweep_type}:${l.application_id}`, l]))

  // Earliest SENT attempt timestamp per (application, kind), where kind = 'escalation' (email) or
  // 'alert' (the Slack DM). outbox_ids[] maps an attempt back to its intent.
  const escalationEmailSentAt = new Map<string, string>()
  const slackFirstSentAt = new Map<string, string>()
  for (const a of attempts) {
    if (a.status !== "sent" || !a.sent_at) continue
    for (const oid of a.outbox_ids ?? []) {
      const o = outboxById.get(oid)
      if (!o) continue
      const key = `${o.channel}:${o.application_id}`
      if (o.notification_type === "escalation") {
        const prev = escalationEmailSentAt.get(key)
        if (!prev || a.sent_at < prev) escalationEmailSentAt.set(key, a.sent_at)
      } else {
        const prev = slackFirstSentAt.get(key)
        if (!prev || a.sent_at < prev) slackFirstSentAt.set(key, a.sent_at)
      }
    }
  }

  // One analytics row per app that has an escalation INTENT (sent or suppressed).
  const escalationApps = new Set(
    outbox.filter((o) => o.notification_type === "escalation").map((o) => `${o.channel}:${o.application_id}`)
  )

  const rows = [...escalationApps].map((key) => {
    const led = ledgerByApp.get(key) ?? null
    const emailAt = escalationEmailSentAt.get(key) ?? null
    const slackAt = slackFirstSentAt.get(key) ?? null
    const resolvedAt = led?.resolved_at ?? null
    const resolvedBeforeEmail =
      resolvedAt != null && (emailAt == null || resolvedAt < emailAt)
    return {
      key,
      resolution_type: led?.resolution_type ?? null,
      first_alerted_at: led?.first_alerted_at ?? null,
      slack_first_sent_at: slackAt,
      escalation_email_sent_at: emailAt,
      resolved_at: resolvedAt,
      resolved_before_email: resolvedBeforeEmail,
      hours_slack_to_resolution: hoursBetween(slackAt, resolvedAt),
      hours_email_to_resolution: hoursBetween(emailAt, resolvedAt),
    }
  })

  const emailed = rows.filter((r) => r.escalation_email_sent_at)
  const emailToResolveHours = emailed
    .map((r) => r.hours_email_to_resolution)
    .filter((h): h is number => typeof h === "number" && h >= 0)

  return noStoreJson({
    checked_at: new Date().toISOString(),
    escalation_apps: rows.length,
    emails_sent: emailed.length,
    resolved_before_email: rows.filter((r) => r.resolved_before_email).length,
    still_unresolved: rows.filter((r) => !r.resolved_at).length,
    avg_hours_email_to_resolution:
      emailToResolveHours.length > 0
        ? Math.round((emailToResolveHours.reduce((a, b) => a + b, 0) / emailToResolveHours.length) * 10) / 10
        : null,
    rows,
  })
}
