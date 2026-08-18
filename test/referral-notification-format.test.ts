import { describe, expect, test } from "vitest"

import { buildNotification } from "../lib/notification-render"
import type { NotificationIntent } from "../lib/notification-render"

// Regression locks for the referral DM body (the operator, 2026-08-06).
//
// WHY THIS FILE EXISTS: before it, NOT ONE test asserted anything about the referral message
// body. The restructure below (drop Stage/Recruiter, add Requisition/Referrer) passed the full
// suite without a single failure, which means every line of that message could have been deleted
// silently. These are content locks, not smoke tests: each one names the exact string the
// recruiter reads, so a future edit to referralLines() has to break a test to change the message.

function referralIntent(
  overrides: Partial<NotificationIntent> = {}
): NotificationIntent {
  return {
    channel: "referral",
    notification_type: "referral_alert",
    reason: "sla_alerted",
    application_id: 5001,
    candidate_name: "Harsh Dwivedi",
    job_title: "Technical Business Analyst",
    referrer_name: "Shreya Verma",
    recruiter_owner_name: "Mateo Vargas",
    current_stage: "Application Review",
    hours_in_stage: 25,
    urgency_since: "1 day ago",
    ...overrides,
  }
}

describe("referral DM body", () => {
  test("carries candidate, requisition, referrer and submitted — each on its own labelled line", () => {
    const { text } = buildNotification(referralIntent())

    expect(text).toContain("*Candidate:* Harsh Dwivedi")
    expect(text).toContain("*Requisition:* Technical Business Analyst")
    expect(text).toContain("*Referrer:* Shreya Verma")
    expect(text).toContain("*Submitted:* 1 day ago")
  })

  test("does NOT render stage or recruiter", () => {
    // Stage is invariably "Application Review" (urgencyTier only classifies in-review items as
    // alertable — sweep-types.ts:79), and the recruiter IS the recipient once
    // NOTIFY_RECIPIENT_MODE=recruiter, so both told the reader something they already knew.
    // Asserted against the intent ABOVE, which deliberately supplies both fields — so this fails
    // if the lines come back, not merely if the data goes missing.
    const { text } = buildNotification(referralIntent())

    expect(text).not.toContain("*Stage:*")
    expect(text).not.toContain("*Recruiter:*")
    expect(text).not.toContain("Application Review")
    expect(text).not.toContain("Mateo Vargas")
    expect(text).not.toContain("h in stage")
  })

  test("does not pack candidate and requisition onto one line", () => {
    // The old form was "*Candidate:* name → role". Two facts on one line read as one fact.
    const { text } = buildNotification(referralIntent())

    expect(text).not.toContain("Harsh Dwivedi → Technical Business Analyst")
  })

  test("base heading states the 48h action window", () => {
    const { text } = buildNotification(referralIntent({ reason: "sla_alerted" }))

    expect(text).toContain("*Employee Referral — please action within 48h*")
  })

  test("urgency headings survive for the 36h reminder and the breach", () => {
    // Dropping these would lose the only signal separating a fresh referral from one about to
    // miss its SLA — the messages the operator actually acts on.
    expect(buildNotification(referralIntent({ reason: "sla_risk" })).text).toContain(
      ":warning: *Referral Approaching SLA*"
    )
    expect(buildNotification(referralIntent({ reason: "breach" })).text).toContain(
      ":rotating_light: *Referral SLA Breach*"
    )
  })

  test("an unnamed referrer renders as an honest defect, never a dropped line", () => {
    // referrer_name is null when the /v3/referrers join finds no name for the application's
    // referrer_id. Dropping the line would make a data gap indistinguishable from a referral
    // nobody made; the recruiter must be able to see that we failed to name the referrer.
    const { text } = buildNotification(referralIntent({ referrer_name: null }))

    expect(text).toContain("*Referrer:* _not resolved_")
    expect(text).not.toContain("Unknown")
    expect(text).not.toContain("UNASSIGNED")
  })

  test("body and Block Kit blocks carry the same content", () => {
    // referralLines feeds both outputs, so they cannot drift by construction — this locks that
    // property rather than trusting the comment asserting it.
    const built = buildNotification(referralIntent())
    const blockText = built.blocks
      .map((b) => ("text" in b ? b.text.text : ""))
      .join("\n")

    expect(blockText).toContain("*Requisition:* Technical Business Analyst")
    expect(blockText).toContain("*Referrer:* Shreya Verma")
    expect(blockText).not.toContain("*Stage:*")
  })
})
