import { describe, expect, test } from "vitest"

import {
  isGovernedDeliveryRole,
  legacyArtifactDisplayV1,
  legacyDeliveryRpsParityV1,
  legacyRpsTrackingParityV1,
} from "../lib/recruiting-ops/dimensions/config/legacy-artifact-display.v1"

describe("legacy artifact display dimension", () => {
  test("governs each focus requisition exactly once", () => {
    expect(legacyArtifactDisplayV1.map((entry) => entry.requisitionId)).toEqual([
      "890", "907", "1026", "1027", "1118", "1119",
    ])
    expect(new Set(legacyArtifactDisplayV1.map((entry) => entry.requisitionId)).size).toBe(6)
  })

  test("uses the copied-report req portfolio when identity exists and signals as a fallback", () => {
    expect(isGovernedDeliveryRole({ jobName: "Senior Engineer, Delivery - US" })).toBe(true)
    expect(isGovernedDeliveryRole({ departmentName: "Fulfillment" })).toBe(true)
    expect(isGovernedDeliveryRole({ jobName: "Research Engineer" })).toBe(false)
    expect(isGovernedDeliveryRole({ requisitionId: "907", jobName: "Forward Deployed Engineer - US | Bench" })).toBe(true)
    expect(isGovernedDeliveryRole({ requisitionId: "1206", jobName: "AI Engineering Lead, NY" })).toBe(true)
    expect(isGovernedDeliveryRole({ requisitionId: "890", jobName: "Principal Forward Deployed AI Engineer, NY" })).toBe(false)
  })

  test("governs the copied Delivery RPS compatibility clock and continuous date ordinal", () => {
    expect(legacyDeliveryRpsParityV1).toEqual({
      dateOrderStart: "2026-03-13",
      reportingClock: "legacy_bic_reporting_at",
      reportingWindow: "friday_through_thursday",
      cleanedSheetLocale: "en_US",
      cleanedSheetTimeZone: "Asia/Calcutta",
      cleanedSheetUtcOffsetMinutes: 330,
      requisitionIds: ["752", "774", "907", "993", "1193", "1206", "8888"],
    })
  })

  test("governs the copied RPS Tracking continuous ledger and audited capacity", () => {
    expect(legacyRpsTrackingParityV1).toEqual({
      submittedAtStart: "2026-03-02",
      periodStartMonday: "2026-03-02",
      dataRowCapacity: 4_250,
    })
  })
})
