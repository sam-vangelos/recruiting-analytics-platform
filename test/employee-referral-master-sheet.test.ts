import { describe, expect, test, vi } from "vitest"

import {
  employeeReferralMasterSheetRecordKey,
  mergeEmployeeReferralMasterSheetRows,
  writeEmployeeReferralMasterSheet,
  type EmployeeReferralMasterSheetClient,
} from "../lib/recruiting-ops/employee-referral-master-sheet"
import {
  createEmployeeReferralReportPeriod,
  type EmployeeReferralReport,
  type EmployeeReferralReportRow,
} from "../lib/recruiting-ops/employee-referral-report"

const spreadsheetId = "1abcdefghijklmnopqrstuvwxyzABCDE"

function row(
  overrides: Partial<EmployeeReferralReportRow> = {}
): EmployeeReferralReportRow {
  return {
    recordType: "CURRENT_ACCEPTED_COHORT",
    rowKey: "CURRENT_ACCEPTED_COHORT:10:1:100",
    candidateName: "Candidate",
    offerResolvedAt: "2026-05-15T20:00:00.000Z",
    greenhousePlannedStartDate: "2026-06-01",
    currentApplicationStatus: "hired",
    currentOfferStatus: "Accepted",
    referringEmployeeName: "Referrer",
    hiringManagerNames: ["Hiring Manager"],
    offerJobTitle: "Engineer",
    offerJobFunction: "R&D / Engineering",
    currentApplicationJob: "Engineer",
    policyFunctionBand: "Delivery and R&D",
    greenhouseHiringLocation: "USA",
    policyCountry: "United States",
    policyReferenceBonusAmount: 3000,
    policyReferenceCurrency: "USD",
    bonusResolutionStatus: "PAYROLL_CONVERSION_REQUIRED - Payroll",
    preliminaryEligibility: "PENDING - 90 DAYS NOT COMPLETED",
    eligibilityReason: "Estimated 90-day date is 2026-08-30",
    estimatedNinetyDayDate: "2026-08-30",
    mappingReviewStatusReason: "NONE",
    greenhouseApplicationId: "100",
    greenhouseOfferIdAndVersion: "10 v1",
    ...overrides,
  }
}

function report(rows: EmployeeReferralReportRow[]): EmployeeReferralReport {
  return {
    period: createEmployeeReferralReportPeriod("2026-04-01", "2026-07-01"),
    rows,
    counts: {
      currentCohortCount: rows.length,
      deprecatedReviewCount: 0,
      ungovernedSourceReviewCount: 0,
      amountMappedCount: rows.length,
      mappingReviewCount: 0,
      totalRowCount: rows.length,
    },
    observedReferralSourceIds: ["4000194004"],
    policyVersion: "test",
    policyExportSha256: "test",
    subject: "test",
    html: "test",
    csv: "test",
    publicDiagnostics: {
      correlationId: "test",
      periodStartLocal: "2026-04-01",
      periodEndLocalExclusive: "2026-07-01",
      policyVersion: "test",
      currentCohortCount: rows.length,
      deprecatedReviewCount: 0,
      ungovernedSourceReviewCount: 0,
      mappingReviewCount: 0,
      totalRowCount: rows.length,
    },
  }
}

describe("employee referral master sheet", () => {
  test("upserts by stable Greenhouse key and preserves manual decision columns", () => {
    const input = row()
    const first = mergeEmployeeReferralMasterSheetRows([], [input])
    first[1][3] = "INELIGIBLE"
    first[1][4] = "New hire resigned before 90 days"
    first[1][5] = "DO NOT PAY"
    first[1][6] = "2026-07-24"

    const changed = row({
      preliminaryEligibility: "PRELIMINARILY ELIGIBLE",
      eligibilityReason: "No automated exclusion found",
      greenhouseOfferIdAndVersion: "10 v2",
    })
    const second = mergeEmployeeReferralMasterSheetRows(first, [changed])

    expect(second).toHaveLength(2)
    expect(second[1].slice(0, 7)).toEqual([
      "PRELIMINARILY ELIGIBLE",
      "No automated exclusion found",
      "2026-08-30",
      "INELIGIBLE",
      "New hire resigned before 90 days",
      "DO NOT PAY",
      "2026-07-24",
    ])
    expect(second[1][26]).toBe("10 v2")
    expect(second[1][27]).toBe(employeeReferralMasterSheetRecordKey(changed))
    expect(mergeEmployeeReferralMasterSheetRows(second, [changed])).toEqual(second)
  })

  test("creates plain monthly tabs only for months containing accepted referrals", async () => {
    const tabs = new Map<string, { sheetId: number; values: readonly (readonly unknown[])[] }>()
    let nextSheetId = 1
    const client: EmployeeReferralMasterSheetClient = {
      listSheets: vi.fn(async () => []),
      addSheet: vi.fn(async (_id, title) => {
        const sheetId = nextSheetId++
        tabs.set(title, { sheetId, values: [] })
        return sheetId
      }),
      getValues: vi.fn(async (_id, range) => {
        const title = range.match(/^'([^']+)'/)?.[1] ?? ""
        return tabs.get(title)?.values ?? []
      }),
      updateValues: vi.fn(async (_id, range, values) => {
        const title = range.match(/^'([^']+)'/)?.[1] ?? ""
        const current = tabs.get(title)
        if (!current) throw new Error("missing tab")
        tabs.set(title, { ...current, values })
      }),
      formatNewSheet: vi.fn(async () => undefined),
    }

    const result = await writeEmployeeReferralMasterSheet(
      report([
        row(),
        row({
          rowKey: "CURRENT_ACCEPTED_COHORT:11:1:101",
          greenhouseApplicationId: "101",
          greenhouseOfferIdAndVersion: "11 v1",
          offerResolvedAt: "2026-06-15T20:00:00.000Z",
        }),
      ]),
      { env: () => spreadsheetId, client }
    )

    expect(result.updatedTabs).toEqual(["2026-05", "2026-06"])
    expect(client.formatNewSheet).toHaveBeenCalledTimes(2)
    expect(tabs.has("2026-04")).toBe(false)
    expect(tabs.get("2026-05")?.values).toHaveLength(2)
    expect(tabs.get("2026-06")?.values).toHaveLength(2)
  })
})
