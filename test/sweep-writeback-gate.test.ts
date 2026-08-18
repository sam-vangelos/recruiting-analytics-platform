// Anti-regression for the sweep 005 writeback gate (lib/sweep-writeback.ts gateSweepRow).
//
// Same bug class as the YTD writeback gate, but higher-stakes: both sweeps run on the cron schedule
// (vercel.json), so an insert that references 005 columns against a pre-005 DB fails the whole batch
// on the next scheduled run. The gate strips the 005 columns when YTD/SWEEP_OWNERSHIP_WRITEBACK is
// off (default), keeping the pre-005 insert legal; with it on, every column passes through. The
// per-table column lists differ — recruiter_name is a 002 column on sweep_items but a 005 column on
// agency_submissions — so both lists are asserted.

import { describe, expect, test } from "vitest"
import {
  AGENCY_SUBMISSIONS_005_COLUMNS,
  SWEEP_ITEMS_005_COLUMNS,
  gateSweepRow,
} from "../lib/sweep-writeback"

const sweepItemRow = () => ({
  application_id: 1,
  candidate_name: "C",
  recruiter_name: "R", // 002 column on sweep_items — must survive
  referrer_name: "F", // 002 column on sweep_items — must survive
  recruiter_id: 7,
  referrer_id: 8,
  ownership_confidence: "high",
  ownership_resolution_status: "resolved",
})

const agencySubmissionRow = () => ({
  application_id: 1,
  agency_source_id: 100,
  agency_source_name: "Acme",
  source_resolution_status: "resolved",
  recruiter_id: 7,
  recruiter_name: "R", // on agency_submissions this is a 005 column — must be stripped
  ownership_resolution_status: "resolved",
})

describe("sweep 005 writeback gate — gateSweepRow", () => {
  test("OFF strips exactly the sweep_items 005 columns and keeps the 002 columns", () => {
    const row = gateSweepRow(sweepItemRow(), SWEEP_ITEMS_005_COLUMNS, false)
    for (const c of SWEEP_ITEMS_005_COLUMNS) expect(row).not.toHaveProperty(c)
    expect(row).toHaveProperty("application_id", 1)
    expect(row).toHaveProperty("recruiter_name", "R") // 002 — NOT stripped on sweep_items
    expect(row).toHaveProperty("referrer_name", "F") // 002 — NOT stripped
  })

  test("OFF strips agency_submissions' four 005 columns — including recruiter_name (005 there)", () => {
    const row = gateSweepRow(agencySubmissionRow(), AGENCY_SUBMISSIONS_005_COLUMNS, false)
    for (const c of AGENCY_SUBMISSIONS_005_COLUMNS) expect(row).not.toHaveProperty(c)
    // the legacy non-null identity columns the pre-005 schema requires survive
    expect(row).toHaveProperty("agency_source_id", 100)
    expect(row).toHaveProperty("agency_source_name", "Acme")
  })

  test("ON passes every column through unchanged", () => {
    const original = sweepItemRow()
    const row = gateSweepRow(original, SWEEP_ITEMS_005_COLUMNS, true)
    expect(row).toEqual(original)
    for (const c of SWEEP_ITEMS_005_COLUMNS) expect(row).toHaveProperty(c)
  })

  test("does not mutate the input row", () => {
    const original = sweepItemRow()
    gateSweepRow(original, SWEEP_ITEMS_005_COLUMNS, false)
    expect(original).toHaveProperty("recruiter_id", 7)
  })
})
