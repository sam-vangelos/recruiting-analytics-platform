import { describe, expect, test } from "vitest"

import {
  assertExactHeaders,
  FINAL_OFFER_Q3_SHEET_IDS,
  getStagingSheetContract,
  stagingSheetContracts,
} from "../lib/recruiting-ops/delivery/staging-sheet-contracts"

describe("staging sheet range contracts", () => {
  test("binds every contract to a staging artifact and a unique range id", () => {
    expect(stagingSheetContracts).toHaveLength(36)
    expect(new Set(stagingSheetContracts.map((contract) => contract.id)).size).toBe(36)
    expect(stagingSheetContracts.every((contract) => contract.sheetTitle && contract.headers.length > 0)).toBe(true)
  })

  test("makes all six Weekly Recruitment human-owned columns unwriteable by mapping", () => {
    const contract = getStagingSheetContract("weekly_recruitment_current")
    expect(contract.headers).toEqual([
      "Job Name", "Job Status", "Req ID", "Billable (Y/N)", "Department Name", "Job Location",
      "Priority", "HC Open", "HC Closed", "Job Health", "Job Progress", "Comments/Updates",
      "Offer Extended", "Offer Signed", "Offer Declined", "Joined", "Earliest Opening Date",
      "Number Of Days Open", "Recruiters", "Recruiter Team", "Sourcers", "Hiring Manager", "Hod",
      "Role Type", "Job URL", "Job Closed Date",
    ])
    expect(contract.humanOwnedHeaders).toEqual([
      "Billable (Y/N)",
      "Priority",
      "Job Health",
      "Job Progress",
      "Comments/Updates",
      "Role Type",
    ])
  })

  test("binds legacy Q3 to the canonical Google-assigned sheet ids, not the retired copy-era ones", () => {
    // These are the real ids on the canonical workbook
    // (1ExampleDriveId00000000000000000000000000003), confirmed by a live
    // read. If this regresses to the old synthetic copy ids
    // (1801000701/702/703, 1801000801/802/803, 1801000901/902/903), every
    // legacy-Q3 id assertion in the canonical write path silently starts
    // rejecting the real workbook again.
    expect(FINAL_OFFER_Q3_SHEET_IDS).toEqual({
      July: { offerData: 875303902, recruiterPerformance: 536416048, sourcerPerformance: 2030343642 },
      August: { offerData: 1503185686, recruiterPerformance: 329204596, sourcerPerformance: 387711499 },
      September: { offerData: 1209354173, recruiterPerformance: 950128212, sourcerPerformance: 1131599123 },
    })
  })

  test("reads every Final Offer quarter tab's headers from row 1, as canonical has them", () => {
    // Read off canonical (1ExampleDriveId00000000000000000000000000003) on
    // 2026-08-07: Mastersheet, Performance Sheet data, and every month tab carry
    // their header run on row 1. `Performance Sheet data` row 2 is already offer
    // data; `August Offer Data` and `September Offer Data` row 2 is empty.
    //
    // eed9882 set Performance/August/September to row 2 with no recorded
    // evidence. Nothing caught it because Final Offer has never completed a
    // write: reading row 2 as the header run makes `assertExactHeaders` reject
    // the real workbook, which is the value-phase `planning` block on this
    // artifact. A regression here re-breaks Final Offer silently.
    for (const id of [
      "final_offer_master",
      "final_offer_performance_data",
      "final_offer_july_data",
      "final_offer_august_data",
      "final_offer_september_data",
    ] as const) {
      expect(getStagingSheetContract(id).headerRow).toBe(1)
    }
  })

  test("fails closed on a shifted or renamed header", () => {
    const contract = getStagingSheetContract("rps_data_dump")
    expect(() => assertExactHeaders(contract.id, contract.headers)).not.toThrow()
    expect(() => assertExactHeaders(contract.id, ["changed", ...contract.headers.slice(1)])).toThrow("header contract drifted")
  })

  test("records every required structural prerequisite in the contract", () => {
    for (const id of [
      "all_hires_data",
      "pipeline_890_candidate",
      "pipeline_1026_1027_candidate",
      "pipeline_1118_1119_candidate",
      "final_offer_master",
      "rps_data_dump",
      "delivery_rps_raw",
      "delivery_rps_clean",
      "delivery_rps_dated",
    ] as const) {
      expect(getStagingSheetContract(id).structuralNormalization).toBeTruthy()
    }
  })

  test("locks the dated Delivery RPS title, merge, section label, and eight-column headers", () => {
    expect(getStagingSheetContract("delivery_rps_dated")).toMatchObject({
      headerRow: 4,
      headers: ["Team", "Total RPS", "Match", "Mismatch", "Strong Yes", "Yes", "No", "Other"],
      staticLayout: {
        titleCell: "A1",
        titleTemplate: "Recruiter Role Report - {DD MMM YYYY}",
        mergeRanges: ["A1:N1"],
        labels: { A3: "Summary by Team" },
      },
    })
  })
})
