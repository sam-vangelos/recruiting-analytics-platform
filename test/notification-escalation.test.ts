// P5 — email escalation. Two layers:
//   1. PURE buildEscalationEmail (no I/O): subject/age/PII.
//   2. enqueueEscalations against a compact Supabase mock: the window trap (first_alerted_at vs
//      last_alerted_at), idempotency on the escalation dedupe_key, and the P1 health interlock.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { buildEscalationEmail, type NotificationIntent } from "../lib/notification-render"

// ---------------------------------------------------------------------------
// Compact Supabase mock shaped to exactly the chains enqueueEscalations issues:
//   from('sweep_runs').select().eq().eq().order().limit()        -> resolver heartbeat
//   from('alert_ledger').select().range()                        -> ledger scan
//   from('notification_outbox').select().range()                 -> existing dedupe keys
//   from(items/subs/ytd).select().in()[.order()]                 -> hydration
//   from('notification_outbox').upsert(rows,opts).select()       -> insert
// Each terminal resolves from a per-table script; the upsert payload is recorded.
// ---------------------------------------------------------------------------
const sb = vi.hoisted(() => {
  const selectScript = new Map<string, () => { data: unknown; error: unknown }>()
  const upserts: Array<{ table: string; payload: Array<Record<string, unknown>>; options: unknown }> = []
  const ok = (data: unknown) => ({ data, error: null })

  function from(table: string) {
    const resolve = () => (selectScript.get(table) ?? (() => ok([])))()
    const chain: Record<string, unknown> = {
      then<R>(onf?: (v: { data: unknown; error: unknown }) => R) {
        return Promise.resolve(resolve()).then(onf)
      },
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      range: () => chain,
      limit: () => chain,
    }
    return {
      select: () => chain,
      upsert(payload: Array<Record<string, unknown>>, options: unknown) {
        upserts.push({ table, payload, options })
        return { select: () => Promise.resolve(ok((payload ?? []).map((_, i) => ({ id: `esc-${i}` })))) }
      },
    }
  }

  return {
    client: { from, rpc: () => Promise.resolve(ok(null)) },
    selectScript,
    upserts,
    ok,
    reset() {
      selectScript.clear()
      upserts.length = 0
    },
  }
})

vi.mock("../lib/supabase", () => ({ supabase: sb.client, getSupabase: () => sb.client }))

import { enqueueEscalations } from "../lib/notification-delivery"

// A "now" anchor. The mock can't use real time-relative data deterministically, so we make
// alert ages relative to a fixed recent sweep heartbeat and well-separated alert timestamps.
const HOUR = 3_600_000
function isoHoursAgo(h: number): string {
  return new Date(Date.now() - h * HOUR).toISOString()
}

function ledgerRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    application_id: 5001,
    sweep_type: "referral",
    greenhouse_stage_at_alert: "Application Review",
    first_alerted_at: isoHoursAgo(60), // > 48h referral window
    last_alerted_at: isoHoursAgo(1),
    resolved_at: null,
    ...over,
  }
}

function healthySweepRun() {
  // resolverLooksHealthy: a completed referral sweep within 2h => healthy.
  sb.selectScript.set("sweep_runs", () => sb.ok([{ completed_at: isoHoursAgo(0.2) }]))
}

describe("buildEscalationEmail (pure)", () => {
  function intent(over: Partial<NotificationIntent> = {}): NotificationIntent {
    return {
      channel: "referral",
      notification_type: "escalation",
      reason: "escalation",
      application_id: 5001,
      candidate_id: 9001,
      candidate_name: "Jane Candidate",
      job_title: "Staff Engineer",
      recruiter_owner_name: "Avery Collins",
      referrer_name: "Pat Referrer",
      current_stage: "Application Review",
      escalation_age_hours: 60,
      ...over,
    }
  }

  test("subject is the [ACTION REQUIRED] review-request form with channel + candidate", () => {
    expect(buildEscalationEmail(intent()).subject).toBe(
      "[ACTION REQUIRED] New referral candidate in need of review: Jane Candidate"
    )
    expect(buildEscalationEmail(intent({ channel: "agency" })).subject).toContain(
      "New agency candidate"
    )
  })

  test("referral body links the candidate to Greenhouse and names the referrer + experience CTA", () => {
    const { html } = buildEscalationEmail(intent())
    expect(html).toContain('href="https://app.greenhouse.io/people/9001"')
    expect(html).toContain("Jane Candidate")
    expect(html).toContain("referred by")
    expect(html).toContain("Pat Referrer")
    expect(html).toContain("best possible experience")
    expect(html).toContain("60 hours")
  })

  test("agency body names the agency and uses the avoid-undue-spend CTA", () => {
    const { html } = buildEscalationEmail(
      intent({ channel: "agency", agency_name: "Superlink AI", referrer_name: null })
    )
    expect(html).toContain("submitted by")
    expect(html).toContain("Superlink AI")
    expect(html).toContain("already exists in Greenhouse")
    expect(html).toContain("undue agency spend")
  })

  test("candidate name renders unlinked when the candidate id is unknown", () => {
    const { html } = buildEscalationEmail(intent({ candidate_id: null }))
    expect(html).not.toContain("app.greenhouse.io")
    expect(html).toContain("Jane Candidate")
  })

  test("html is HTML-escaped + PII-scrubbed", () => {
    const { html } = buildEscalationEmail(
      intent({ candidate_name: "A <script> & Co", recruiter_owner_name: "Avery Collins" })
    )
    expect(html).toContain("Avery Collins")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
  })

  test("null owner renders an honest defect, never a sentinel", () => {
    const { html } = buildEscalationEmail(intent({ recruiter_owner_name: null }))
    expect(html).toContain("not resolved")
    expect(html).not.toMatch(/Unknown|UNASSIGNED/)
  })

  test("an email/phone leaked into a display field is scrubbed", () => {
    const { html } = buildEscalationEmail(intent({ candidate_name: "Jane jane@x.com" }))
    expect(html).not.toContain("jane@x.com")
    expect(html).toContain("[redacted]")
  })
})

describe("enqueueEscalations", () => {
  beforeEach(() => {
    sb.reset()
    healthySweepRun()
    sb.selectScript.set("notification_outbox", () => sb.ok([])) // no existing intents
    sb.selectScript.set("sweep_items", () => sb.ok([]))
    sb.selectScript.set("agency_submissions", () => sb.ok([]))
    sb.selectScript.set("ytd_application_facts", () => sb.ok([]))
    vi.stubEnv("NOTIFY_DELIVERY_CUTOVER_AT", "") // no cutover -> rows enqueue pending
  })
  afterEach(() => vi.unstubAllEnvs())

  test("an unresolved alert past the 48h window enqueues an escalation intent", async () => {
    sb.selectScript.set("alert_ledger", () => sb.ok([ledgerRow()]))
    const result = await enqueueEscalations()
    expect(result.skipped_resolver_unhealthy).toBe(false)
    expect(result.candidates).toBe(1)
    const upsert = sb.upserts.find((u) => u.table === "notification_outbox")
    expect(upsert!.payload[0].dedupe_key).toBe("referral:5001:escalation")
    expect(upsert!.payload[0].delivery_target).toBe("email")
    expect(upsert!.payload[0].notification_type).toBe("escalation")
  })

  test("THE TRAP: last_alerted_at fresh but first_alerted_at old STILL escalates", async () => {
    // The sweep bumps last_alerted_at hourly; the window must key on first_alerted_at.
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([ledgerRow({ first_alerted_at: isoHoursAgo(72), last_alerted_at: isoHoursAgo(0.5) })])
    )
    const result = await enqueueEscalations()
    expect(result.candidates).toBe(1)
  })

  test("an alert inside the window does NOT escalate", async () => {
    sb.selectScript.set("alert_ledger", () => sb.ok([ledgerRow({ first_alerted_at: isoHoursAgo(20) })]))
    const result = await enqueueEscalations()
    expect(result.candidates).toBe(0)
    expect(sb.upserts.length).toBe(0)
  })

  test("a resolved alert never escalates, even past the window", async () => {
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([ledgerRow({ resolved_at: isoHoursAgo(1) })])
    )
    const result = await enqueueEscalations()
    expect(result.candidates).toBe(0)
  })

  test("idempotent: an app already escalated is not re-enqueued", async () => {
    sb.selectScript.set("alert_ledger", () => sb.ok([ledgerRow()]))
    sb.selectScript.set("notification_outbox", () =>
      sb.ok([{ application_id: 5001, channel: "referral", reason: "escalation" }])
    )
    const result = await enqueueEscalations()
    expect(result.candidates).toBe(0)
    expect(sb.upserts.length).toBe(0)
  })

  test("resolver unhealthy (stale sweep heartbeat) skips the whole pass", async () => {
    sb.selectScript.set("sweep_runs", () => sb.ok([{ completed_at: isoHoursAgo(9) }])) // > 2h
    sb.selectScript.set("alert_ledger", () => sb.ok([ledgerRow()]))
    const result = await enqueueEscalations()
    expect(result.skipped_resolver_unhealthy).toBe(true)
    expect(result.candidates).toBe(0)
    expect(sb.upserts.length).toBe(0)
  })
})
