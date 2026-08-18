import { describe, expect, test } from "vitest"
import { classifyResolution, isRealStage } from "../lib/sweep-action-tracker"
import type { GHApplication } from "../lib/sweep-types"

// Pure coverage for the resolution classifier (P1 keystone). The load-bearing case is the
// 'Unknown' alert-time-stage false-resolution that was ~29% of prod resolutions (7/24): an alert
// that captured the projection-gap sentinel must NOT auto-resolve the instant the real stage name
// becomes readable, because the candidate never moved.

function app(overrides: Partial<GHApplication> = {}): GHApplication {
  return {
    id: 101,
    candidate_id: 201,
    job_id: 301,
    status: "active",
    current_stage: { id: 1, name: "Application Review" },
    stage_name: null,
    source: { id: 4000194004, name: "Referral" },
    credited_to: null,
    applied_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    last_activity_at: "2026-01-02T00:00:00Z",
    ...overrides,
  } as GHApplication
}

describe("isRealStage", () => {
  test("real stage names are real", () => {
    expect(isRealStage("Application Review")).toBe(true)
    expect(isRealStage("Recruiter Phone Screen")).toBe(true)
  })
  test("sentinels and empties are not real", () => {
    for (const s of ["Unknown", "active", "in_process", "", "   ", null, undefined]) {
      expect(isRealStage(s)).toBe(false)
    }
  })
})

describe("classifyResolution", () => {
  test("Unknown alert-time stage -> real stage does NOT resolve (the 7-row prod bug)", () => {
    // Alert captured the 'Unknown' projection sentinel; the app now reads a real stage. The
    // candidate never moved — the real name just became readable. Must stay unresolved.
    const verdict = classifyResolution(
      { greenhouse_stage_at_alert: "Unknown" },
      app({ current_stage: { id: 1, name: "Application Review" } })
    )
    expect(verdict).toBeNull()
  })

  test("agency 'active' alert-time literal -> real stage does NOT resolve (latent agency bug)", () => {
    const verdict = classifyResolution(
      { greenhouse_stage_at_alert: "active" },
      app({ current_stage: { id: 2, name: "Recruiter Phone Screen" } })
    )
    expect(verdict).toBeNull()
  })

  test("real -> real different stage resolves as stage_change", () => {
    const verdict = classifyResolution(
      { greenhouse_stage_at_alert: "Application Review" },
      app({ current_stage: { id: 2, name: "Recruiter Phone Screen" } })
    )
    expect(verdict).not.toBeNull()
    expect(verdict!.resolution_type).toBe("stage_change")
    expect(verdict!.resolution_detail).toBe("Stage changed: Application Review → Recruiter Phone Screen")
    expect(verdict!.greenhouse_stage_at_resolution).toBe("Recruiter Phone Screen")
  })

  test("real -> same stage does NOT resolve", () => {
    const verdict = classifyResolution(
      { greenhouse_stage_at_alert: "Application Review" },
      app({ current_stage: { id: 1, name: "Application Review" } })
    )
    expect(verdict).toBeNull()
  })

  test("real -> Unknown (projection gap at resolution time) does NOT resolve", () => {
    const verdict = classifyResolution(
      { greenhouse_stage_at_alert: "Application Review" },
      app({ current_stage: null, stage_name: null }) // ghStageName -> "Unknown"
    )
    expect(verdict).toBeNull()
  })

  test("rejection resolves regardless of stage sentinels", () => {
    const verdict = classifyResolution(
      { greenhouse_stage_at_alert: "Unknown" },
      app({ status: "rejected", current_stage: null, stage_name: null })
    )
    expect(verdict!.resolution_type).toBe("rejection")
  })

  test("hire resolves regardless of stage sentinels", () => {
    const verdict = classifyResolution(
      { greenhouse_stage_at_alert: "active" },
      app({ status: "hired" })
    )
    expect(verdict!.resolution_type).toBe("hire")
  })
})
