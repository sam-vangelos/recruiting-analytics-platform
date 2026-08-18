import { describe, expect, test } from "vitest"

import {
  renderHydrationRunAlert,
  renderHydrationSlotAlert,
} from "../lib/recruiting-ops/delivery/staging-hydration-alert"
import { stagingArtifactRegistry } from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import type { HydrationArtifactReport } from "../lib/recruiting-ops/delivery/staging-hydration-orchestrator"

function landed(artifactKey: HydrationArtifactReport["artifactKey"]): HydrationArtifactReport {
  return { artifactKey, outcome: "written", certified: true, failureCode: null, failureStage: null }
}

function missed(
  artifactKey: HydrationArtifactReport["artifactKey"],
  failureCode: string | null,
  failureStage: string | null = null
): HydrationArtifactReport {
  return { artifactKey, outcome: "failed", certified: false, failureCode, failureStage }
}

const BASE = {
  status: "succeeded",
  runId: "11111111-1111-4111-8111-111111111111",
  businessDate: "2026-08-13",
  scheduledAt: "2026-08-13T13:30:00.000Z",
  lane: "weekday_morning",
}

describe("hydration run alert", () => {
  test("a clean run says so in the first line and names no failures", () => {
    const alert = renderHydrationRunAlert({
      ...BASE,
      artifactOutcomes: [landed("elt_doc"), landed("all_hires"), landed("final_offer")],
    })

    expect(alert.headline).toBe(":white_check_mark: Recruiting reports updated — all 3 landed")
    expect(alert.text.startsWith(alert.headline)).toBe(true)
    expect(alert.text).not.toContain("Did not update")
    expect(alert.text).toContain("ELT Recruiting Doc, All Hires, Final Offer")
  })

  // The whole point of the message: which reports are stale, and why, without
  // opening the ledger.
  test("a partial run names each report that did not land and its reason", () => {
    const alert = renderHydrationRunAlert({
      ...BASE,
      status: "partial",
      artifactOutcomes: [
        landed("all_hires"),
        missed("final_offer", "blocked", "planning"),
        missed("rps_tracking", "recurring_sheet_lifecycle_blocked"),
      ],
    })

    expect(alert.headline).toBe(
      ":warning: Recruiting reports partly updated — 1 of 3 landed, 2 did not"
    )
    expect(alert.text).toContain("• Final Offer — write blocked before it mutated anything at planning (`blocked`)")
    expect(alert.text).toContain("• RPS Tracking — the dated tab could not be prepared (`recurring_sheet_lifecycle_blocked`)")
    expect(alert.text).toContain("*Updated* — All Hires")
    expect(alert.text).toContain("WEEKLY_AUTOMATION_RUNBOOK.md")
  })

  test("distinguishes a total failure from a partial one in the first line", () => {
    expect(renderHydrationRunAlert({
      ...BASE,
      status: "failed",
      artifactOutcomes: [missed("all_hires", "artifact_execution_failed")],
    }).headline).toBe(":rotating_light: Recruiting reports did not update — 0 of 1 landed")
  })

  test("an artifact the run never reached reads as unattempted, not as a silent omission", () => {
    const alert = renderHydrationRunAlert({
      ...BASE,
      status: "failed",
      artifactOutcomes: [{
        artifactKey: "weekly_progress",
        outcome: null,
        certified: false,
        failureCode: null,
        failureStage: null,
      }],
    })

    expect(alert.text).toContain("• Weekly Progress — never attempted")
  })

  test("an overlap reads as a skipped cycle rather than a failure", () => {
    const alert = renderHydrationRunAlert({
      ...BASE,
      status: "failed",
      reason: "overlap_in_progress",
      artifactOutcomes: [],
    })

    expect(alert.headline).toContain("skipped a cycle")
  })

  test("an unrecognised failure code still reaches the reader verbatim", () => {
    const alert = renderHydrationRunAlert({
      ...BASE,
      status: "partial",
      artifactOutcomes: [missed("all_hires", "some_new_code", "mutation")],
    })

    expect(alert.text).toContain("• All Hires — `some_new_code` at mutation")
  })

  // The message goes to Slack, so it must never carry a person or a req.
  test("carries only artifact vocabulary and the run's own identifiers", () => {
    const alert = renderHydrationRunAlert({
      ...BASE,
      status: "partial",
      artifactOutcomes: [landed("all_hires"), missed("final_offer", "blocked", "planning")],
    })

    expect(alert.text).not.toMatch(/@|candidate|recruiter|requisition|email/i)
  })

  test("labels every artifact the registry can schedule", () => {
    const alert = renderHydrationRunAlert({
      ...BASE,
      artifactOutcomes: stagingArtifactRegistry.map((target) => landed(target.key)),
    })

    expect(alert.headline).toBe(":white_check_mark: Recruiting reports updated — all 11 landed")
    for (const target of stagingArtifactRegistry) {
      expect(alert.text).not.toContain(target.key)
    }
  })
})

describe("hydration missing-slot alert", () => {
  test("names each scheduled slot that produced no run at all", () => {
    const alert = renderHydrationSlotAlert({
      missingSlots: [
        { scheduledAt: "2026-08-13T13:30:00.000Z", lane: "weekday_morning", dueArtifactCount: 10 },
      ],
    })

    expect(alert.headline).toBe(":rotating_light: A recruiting reports run never started")
    expect(alert.text).toContain("2026-08-13T13:30:00.000Z (weekday_morning) — 10 report(s) due")
    expect(alert.text).toContain("did not fire")
  })

  test("pluralises when more than one slot is missing", () => {
    expect(renderHydrationSlotAlert({
      missingSlots: [
        { scheduledAt: "2026-08-12T06:30:00.000Z", lane: "weekday_evening", dueArtifactCount: 1 },
        { scheduledAt: "2026-08-13T13:30:00.000Z", lane: "weekday_morning", dueArtifactCount: 10 },
      ],
    }).headline).toBe(":rotating_light: 2 recruiting reports runs never started")
  })
})
