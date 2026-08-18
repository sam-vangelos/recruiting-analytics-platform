import { describe, expect, test } from "vitest"

import {
  buildDeliveryRpsReportFormatPlan,
} from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import { deliveryRpsTargetSheetId } from "../lib/recruiting-ops/delivery/staging-structural-normalization"
import { buildStagingSheetValuePlan, type SheetCellValue } from "../lib/recruiting-ops/delivery/staging-value-plan"

const WIDTH = 14

function row(values: readonly SheetCellValue[]): SheetCellValue[] {
  return Array.from({ length: WIDTH }, (_, index) => values[index] ?? null)
}

function reportRows(): SheetCellValue[][] {
  return [
    row(["Summary by Team"]),
    row(["Team", "Total RPS", "Match", "Mismatch", "Strong Yes", "Yes", "No", "Other"]),
    row(["Team Sana", 2, 2, 0, 0, 1, 1, 0]),
    row([]), row([]),
    row(["Summary by Submitter"]),
    row(["Submitter", "Total RPS", "Match", "Mismatch", "Strong Yes", "Yes", "No", "Other"]),
    row(["Recruiter", 2, 2, 0, 0, 1, 1, 0]),
    row([]), row([]),
    row(["Match / Mismatch Check"]),
    row(["Match Status", "Count"]),
    row(["match", 2]),
    row([]), row([]),
    row(["Role-Level Detail"]),
    row(["Requisition ID", "Job Name", "Total RPS", "Submitters", "Recruiters", "Sourcers"]),
    row([907, "Role", 2, "Recruiter", "Owner", "Sourcer"]),
    row([]), row([]),
    row(["Raw Detail"]),
    row([
      "Candidate", "Job", "Req ID", "Status", "Submitter", "Submitter Team", "Interview",
      "Interviewer", "Recommendation", "Match/Mismatch", "Recruiters", "Sourcers", "Week",
      "Key Takeaways",
    ]),
    row(["Candidate", "Role", 907, "Active", "Recruiter", "Team Sana", "Screen"]),
  ]
}

const LEDGER_WIDTH = 20

/** One ledger row per tab, matching the shape a real Delivery plan always carries. */
function ledgerRows(): SheetCellValue[][] {
  return [Array.from({ length: LEDGER_WIDTH }, () => null)]
}

function valuePlan(rows = reportRows()) {
  const ledger = ledgerRows()
  return buildStagingSheetValuePlan({
    artifactKey: "delivery_roles_rps",
    runId: "delivery_20260716",
    sourceGeneratedAt: "2026-07-16T20:00:00.000Z",
    structureHash: `sha256:${"0".repeat(64)}`,
    dataProvenance: "fixture",
    ranges: [
      {
        rangeId: "delivery_rps_raw",
        a1Range: `'Raw_Daily_RPS'!A2:T${ledger.length + 1}`,
        currentValues: ledger,
        desiredValues: ledger,
      },
      {
        rangeId: "delivery_rps_clean",
        a1Range: `'Cleaned_RPS'!A2:T${ledger.length + 1}`,
        currentValues: ledger,
        desiredValues: ledger,
      },
      {
        rangeId: "delivery_rps_dated",
        a1Range: `'16 Jul 2026'!A3:N${rows.length + 2}`,
        currentValues: rows,
        desiredValues: rows,
      },
    ],
  })
}

describe("Delivery RPS dated-report formatting", () => {
  test("derives exact base, five header, and trailing-clear requests from the report", () => {
    const plan = buildDeliveryRpsReportFormatPlan(valuePlan())

    expect(plan).not.toBeNull()
    expect(plan).toMatchObject({
      sheetId: deliveryRpsTargetSheetId("2026-07-16"),
      sheetTitle: "16 Jul 2026",
    })
    expect(plan?.requests).toHaveLength(7)
    expect(plan?.requests.map((request) => request.repeatCell?.range)).toEqual([
      expect.objectContaining({ startRowIndex: 1, endRowIndex: 25, startColumnIndex: 0, endColumnIndex: 14 }),
      expect.objectContaining({ startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 8 }),
      expect.objectContaining({ startRowIndex: 8, endRowIndex: 9, startColumnIndex: 0, endColumnIndex: 8 }),
      expect.objectContaining({ startRowIndex: 13, endRowIndex: 14, startColumnIndex: 0, endColumnIndex: 2 }),
      expect.objectContaining({ startRowIndex: 18, endRowIndex: 19, startColumnIndex: 0, endColumnIndex: 6 }),
      expect.objectContaining({ startRowIndex: 23, endRowIndex: 24, startColumnIndex: 0, endColumnIndex: 14 }),
      expect.objectContaining({ startRowIndex: 25, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 14 }),
    ])
    expect(plan?.desiredFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("fails closed when a governed section header drifts", () => {
    const rows = reportRows()
    rows[1][1] = "Wrong"
    expect(() => buildDeliveryRpsReportFormatPlan(valuePlan(rows))).toThrow(
      "Summary by Team headers drifted"
    )
  })
})
