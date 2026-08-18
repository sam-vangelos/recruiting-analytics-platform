import { describe, expect, test } from "vitest"

import {
  googleDateSerial,
  monthOrder,
  projectAllHires,
  renderAllHiresRows,
} from "../lib/recruiting-ops/delivery/all-hires-renderer"
import type { OfferLifecycleExportRow } from "../lib/recruiting-ops/delivery-source/offer-lifecycle-export"

function offer(overrides: Partial<OfferLifecycleExportRow> = {}): OfferLifecycleExportRow {
  return {
    offer_id: "offer-1",
    offer_status: "accepted",
    requisition_id: "1027",
    candidate_name: "Candidate One",
    resolved_at: "2026-06-15T12:00:00Z",
    start_date: "2026-07-01",
    ...overrides,
  } as OfferLifecycleExportRow
}

describe("All Hires renderer", () => {
  test("matches the live full-month label, Sep-2025 ordinal and numeric date contract", () => {
    const rows = renderAllHiresRows({
      offers: [offer()],
      displayDimensions: [{ requisitionId: "1027", jobCategory: "FDL", jobName: "Frontier Data Lead - RL Gyms" }],
    })
    expect(rows).toEqual([
      {
        upsertKey: "offer-1",
        cells: [
          "FDL",
          "Frontier Data Lead - RL Gyms",
          "Candidate One",
          googleDateSerial("2026-06-15"),
          "June 2026",
          10,
          googleDateSerial("2026-07-01"),
          "July 2026",
          11,
        ],
      },
    ])
    expect(monthOrder("2025-09-01")).toBe(1)
  })

  test("keeps Dec and Jan labels and ordinals continuous in rendered rows", () => {
    const rows = renderAllHiresRows({
      offers: [
        offer({ offer_id: "dec", resolved_at: "2026-12-31T12:00:00Z", start_date: "2027-01-04" }),
        offer({ offer_id: "jan", resolved_at: "2027-01-01T12:00:00Z", start_date: "2027-01-11" }),
      ],
      displayDimensions: [{ requisitionId: "1027", jobCategory: "FDL", jobName: "FDL" }],
    })

    expect(rows.map((row) => [row.upsertKey, row.cells[4], row.cells[5], row.cells[7], row.cells[8]]))
      .toEqual([
        ["dec", "December 2026", 16, "January 2027", 17],
        ["jan", "January 2027", 17, "January 2027", 17],
      ])
  })

  test("filters to governed display dimensions and accepted offers only", () => {
    const rows = renderAllHiresRows({
      offers: [
        offer({ offer_id: "tracked" }),
        offer({ offer_id: "untracked", requisition_id: "999" }),
        offer({ offer_id: "declined", offer_status: "declined" }),
      ],
      displayDimensions: [{ requisitionId: "1027", jobCategory: "FDL", jobName: "FDL" }],
    })
    expect(rows.map((row) => row.upsertKey)).toEqual(["tracked"])
  })

  test("fails closed when an accepted mapped row lacks its candidate or resolution date", () => {
    const dimensions = [{ requisitionId: "1027", jobCategory: "FDL", jobName: "FDL" }]
    expect(() => renderAllHiresRows({ offers: [offer({ candidate_name: null })], displayDimensions: dimensions })).toThrow("candidate_name")
    expect(() => renderAllHiresRows({ offers: [offer({ resolved_at: null })], displayDimensions: dimensions })).toThrow("resolved_at")
  })
})

describe("All Hires unmapped-hire reporting", () => {
  const dimensions = [
    { requisitionId: "1027", jobCategory: "FDL" as const, jobName: "Frontier Data Lead - RL Gyms" },
  ]

  test("reports an accepted hire the display vocabulary has no entry for", () => {
    // The sheet holds roughly twenty job names against six mapped requisitions,
    // so hires on the rest were dropped before the diff and the artifact
    // reported a clean no-change while going stale.
    const projection = projectAllHires({
      offers: [
        offer(),
        offer({ offer_id: "offer-2", requisition_id: "1164", job_name: "Architect - US", department_name: "R&D / Engineering" }),
        offer({ offer_id: "offer-3", requisition_id: null, job_name: "No Requisition" }),
      ],
      displayDimensions: dimensions,
    })

    expect(projection.rows.map((row) => row.upsertKey)).toEqual(["offer-1"])
    expect(projection.unmapped).toEqual([
      {
        requisitionId: "1164",
        jobName: "Architect - US",
        departmentName: "R&D / Engineering",
        acceptedDate: "2026-06-15",
      },
      {
        requisitionId: null,
        jobName: "No Requisition",
        departmentName: undefined,
        acceptedDate: "2026-06-15",
      },
    ])
  })

  test("does not report a hire that was never accepted", () => {
    const projection = projectAllHires({
      offers: [offer({ offer_id: "offer-4", requisition_id: "9999", offer_status: "rejected" })],
      displayDimensions: dimensions,
    })
    expect(projection.rows).toEqual([])
    expect(projection.unmapped).toEqual([])
  })
})
