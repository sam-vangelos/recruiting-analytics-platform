import { describe, expect, test } from "vitest"

import { eltReportingFriday } from "../lib/recruiting-ops/exec-definitions"
import { stagingArtifactRegistry } from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import { resolveScheduledHydrationCycle } from "../lib/recruiting-ops/delivery/staging-maintenance-cadence"

const ELIGIBLE_ARTIFACTS = stagingArtifactRegistry
  .filter((target) => target.maintenanceLane !== null)
  .map((target) => target.key)
const INVALID_ELIGIBILITY: readonly [readonly string[]][] = [
  [[]],
  [["all_hires", "all_hires"]],
  [["unknown"]],
]

describe("canonical scheduled hydration cadence", () => {
  test("binds exactly ten canonical Sheets and the canonical ELT Doc to private lanes", () => {
    const sheets = stagingArtifactRegistry.filter((target) => target.kind === "google_sheet")
    expect(sheets).toHaveLength(10)
    expect(
      sheets.every((target) => target.mutationTarget === "canonical" && target.maintenanceLane !== null)
    ).toBe(true)
    expect(stagingArtifactRegistry.find((target) => target.key === "elt_doc")).toMatchObject({
      kind: "google_doc",
      cadence: "weekly",
      maintenanceLane: "weekday_morning",
      mutationTarget: "canonical",
    })
    expect(stagingArtifactRegistry.find((target) => target.key === "final_offer")?.cadence).toBe("weekly")
  })

  test("selects Thursday morning copies in deterministic daily-then-weekly order", () => {
    expect(resolveScheduledHydrationCycle({
      scheduledAt: "2026-07-16T13:30:00Z",
      eligibleArtifacts: ELIGIBLE_ARTIFACTS,
    })).toEqual({
      scheduledAt: "2026-07-16T13:30:00.000Z",
      lane: "weekday_morning",
      businessDate: "2026-07-16",
      reportingWeekFriday: "2026-07-10",
      quarterStart: "2026-07-01",
      dueArtifacts: [
        "all_hires",
        "elt_doc",
        "weekly_recruitment",
        "weekly_progress",
        "pipeline_890",
        "pipeline_907",
        "pipeline_1026_1027",
        "pipeline_1118_1119",
        "final_offer",
        "rps_tracking",
      ],
    })
  })

  test("runs only All Hires on other weekday mornings and starts a new reporting week on Friday", () => {
    const monday = resolveScheduledHydrationCycle({
      scheduledAt: "2026-07-13T13:30:00Z",
      eligibleArtifacts: ELIGIBLE_ARTIFACTS,
    })
    expect(monday.dueArtifacts).toEqual(["all_hires"])
    expect(monday.reportingWeekFriday).toBe("2026-07-10")

    const friday = resolveScheduledHydrationCycle({
      scheduledAt: "2026-07-17T13:30:00Z",
      eligibleArtifacts: ELIGIBLE_ARTIFACTS,
    })
    expect(friday.dueArtifacts).toEqual(["all_hires", "elt_doc"])
    expect(friday.reportingWeekFriday).toBe("2026-07-17")
  })

  // Two anchors, deliberately different, and the Friday ELT slot only makes
  // sense once both are on the page. A cycle's reportingWeekFriday is the
  // in-progress week the state-of-play rollup covers; the ELT Doc separately
  // uses eltReportingFriday, the last COMPLETE Fri-Thu week. They coincide only
  // on Thursday. So the Thursday and Friday ELT slots write the SAME week
  // block: Thursday gives the meeting a near-final read, Friday rewrites it
  // once the week has actually closed. Deleting the Friday slot as a duplicate
  // would silently leave every week finalised on incomplete Thursday data.
  test("the Thursday and Friday ELT slots target the same completed reporting week", () => {
    const thursday = "2026-07-16T13:30:00Z"
    const friday = "2026-07-17T13:30:00Z"

    expect(eltReportingFriday(new Date(thursday))).toBe("2026-07-10")
    expect(eltReportingFriday(new Date(friday))).toBe("2026-07-10")

    // The cycle anchor moves on Friday even though the ELT week does not.
    expect(resolveScheduledHydrationCycle({
      scheduledAt: thursday,
      eligibleArtifacts: ELIGIBLE_ARTIFACTS,
    }).reportingWeekFriday).toBe("2026-07-10")
    expect(resolveScheduledHydrationCycle({
      scheduledAt: friday,
      eligibleArtifacts: ELIGIBLE_ARTIFACTS,
    }).reportingWeekFriday).toBe("2026-07-17")
  })

  test.each([
    ["2026-07-14T06:30:00Z", "2026-07-13"],
    ["2026-01-13T07:30:00Z", "2026-01-12"],
  ])("selects Delivery at 23:30 Pacific across UTC dates and offsets", (scheduledAt, businessDate) => {
    const cycle = resolveScheduledHydrationCycle({ scheduledAt, eligibleArtifacts: ELIGIBLE_ARTIFACTS })
    expect(cycle.lane).toBe("weekday_evening")
    expect(cycle.businessDate).toBe(businessDate)
    expect(cycle.dueArtifacts).toEqual(["delivery_roles_rps"])
  })

  test("normalizes Scheduler fractional seconds to the whole-minute durable identity", () => {
    expect(resolveScheduledHydrationCycle({
      scheduledAt: "2026-07-21T06:30:00.536623Z",
      eligibleArtifacts: ELIGIBLE_ARTIFACTS,
    })).toEqual({
      scheduledAt: "2026-07-21T06:30:00.000Z",
      lane: "weekday_evening",
      businessDate: "2026-07-20",
      reportingWeekFriday: "2026-07-17",
      quarterStart: "2026-07-01",
      dueArtifacts: ["delivery_roles_rps"],
    })
  })

  test("derives quarter start from the Pacific business date instead of the prior Friday", () => {
    const cycle = resolveScheduledHydrationCycle({
      scheduledAt: "2026-10-01T13:30:00Z",
      eligibleArtifacts: ELIGIBLE_ARTIFACTS,
    })
    expect(cycle.businessDate).toBe("2026-10-01")
    expect(cycle.reportingWeekFriday).toBe("2026-09-25")
    expect(cycle.quarterStart).toBe("2026-10-01")
    expect(cycle.dueArtifacts).toContain("final_offer")
  })

  test.each([
    ["2026-07-13T13:30:00Z", "weekday_morning", ["all_hires"]],
    ["2026-07-14T13:30:00Z", "weekday_morning", ["all_hires"]],
    ["2026-07-15T13:30:00Z", "weekday_morning", ["all_hires"]],
    ["2026-07-16T13:30:00Z", "weekday_morning", [
      "all_hires", "elt_doc", "weekly_recruitment", "weekly_progress", "pipeline_890", "pipeline_907",
      "pipeline_1026_1027", "pipeline_1118_1119", "final_offer", "rps_tracking",
    ]],
    ["2026-07-17T13:30:00Z", "weekday_morning", ["all_hires", "elt_doc"]],
    ["2026-07-14T06:30:00Z", "weekday_evening", ["delivery_roles_rps"]],
    ["2026-07-15T06:30:00Z", "weekday_evening", ["delivery_roles_rps"]],
    ["2026-07-16T06:30:00Z", "weekday_evening", ["delivery_roles_rps"]],
    ["2026-07-17T06:30:00Z", "weekday_evening", ["delivery_roles_rps"]],
    ["2026-07-18T06:30:00Z", "weekday_evening", ["delivery_roles_rps"]],
  ] as const)("resolves every weekday slot: %s", (scheduledAt, lane, dueArtifacts) => {
    const cycle = resolveScheduledHydrationCycle({ scheduledAt, eligibleArtifacts: ELIGIBLE_ARTIFACTS })
    expect(cycle.lane).toBe(lane)
    expect(cycle.dueArtifacts).toEqual(dueArtifacts)
  })

  test.each([
    ["2026-03-06T14:30:00Z", "2026-03-06"],
    ["2026-03-09T13:30:00Z", "2026-03-09"],
    ["2026-10-30T13:30:00Z", "2026-10-30"],
    ["2026-11-02T14:30:00Z", "2026-11-02"],
  ])("uses Pacific wall time on both sides of DST: %s", (scheduledAt, businessDate) => {
    const cycle = resolveScheduledHydrationCycle({
      scheduledAt,
      eligibleArtifacts: ELIGIBLE_ARTIFACTS,
    })
    expect(cycle.businessDate).toBe(businessDate)
    if (businessDate === "2026-03-06" || businessDate === "2026-10-30") {
      expect(cycle.dueArtifacts).toEqual(["all_hires", "elt_doc"])
    }
  })

  test.each([
    ["2026-03-05T14:30:00Z", "Thursday"],
    ["2026-03-06T14:30:00Z", "Friday"],
    ["2026-03-12T13:30:00Z", "Thursday"],
    ["2026-03-13T13:30:00Z", "Friday"],
    ["2026-10-29T13:30:00Z", "Thursday"],
    ["2026-10-30T13:30:00Z", "Friday"],
    ["2026-11-05T14:30:00Z", "Thursday"],
    ["2026-11-06T14:30:00Z", "Friday"],
  ])("keeps ELT eligible at the %s 06:30 slot across DST: %s", (scheduledAt, weekday) => {
    const cycle = resolveScheduledHydrationCycle({
      scheduledAt,
      eligibleArtifacts: ELIGIBLE_ARTIFACTS,
    })
    expect(cycle.dueArtifacts).toContain("elt_doc")
    if (weekday === "Friday") {
      expect(cycle.dueArtifacts).toEqual(["all_hires", "elt_doc"])
    } else {
      expect(cycle.dueArtifacts[0]).toBe("all_hires")
      expect(cycle.dueArtifacts[1]).toBe("elt_doc")
    }
  })

  test("keeps reporting week and quarter correct across the year boundary", () => {
    expect(resolveScheduledHydrationCycle({
      scheduledAt: "2026-01-01T14:30:00Z",
      eligibleArtifacts: ELIGIBLE_ARTIFACTS,
    })).toMatchObject({
      businessDate: "2026-01-01",
      reportingWeekFriday: "2025-12-26",
      quarterStart: "2026-01-01",
    })
  })

  test("intersects an explicit eligibility list without accepting caller order", () => {
    const cycle = resolveScheduledHydrationCycle({
      scheduledAt: "2026-07-16T06:30:00-07:00",
      eligibleArtifacts: ["rps_tracking", "weekly_recruitment", "all_hires"],
    })
    expect(cycle.scheduledAt).toBe("2026-07-16T13:30:00.000Z")
    expect(cycle.dueArtifacts).toEqual(["all_hires", "weekly_recruitment", "rps_tracking"])

    expect(resolveScheduledHydrationCycle({
      scheduledAt: "2026-07-13T13:30:00Z",
      eligibleArtifacts: ["weekly_recruitment"],
    }).dueArtifacts).toEqual([])
  })

  test.each(INVALID_ELIGIBILITY)("rejects an invalid eligibility list %#", (eligibleArtifacts) => {
    expect(() => resolveScheduledHydrationCycle({
      scheduledAt: "2026-07-16T13:30:00Z",
      eligibleArtifacts,
    })).toThrow()
  })

  test.each([
    "not-a-timestamp",
    "2026-02-30T14:30:00Z",
    "2026-07-16T13:30:01Z",
    "2026-07-16T13:31:00Z",
    "2026-07-18T13:30:00Z",
  ])("rejects an invalid or off-cadence schedule time %s", (scheduledAt) => {
    expect(() => resolveScheduledHydrationCycle({
      scheduledAt,
      eligibleArtifacts: ELIGIBLE_ARTIFACTS,
    })).toThrow()
  })
})
