import { beforeEach, describe, expect, test, vi } from "vitest"

import { PII_FINGERPRINT_SALT_ENV } from "../lib/recruiting-ops/checksums"
import type { OfferLifecycleExportRow } from "../lib/recruiting-ops/delivery-source/offer-lifecycle-export"
import type { ScorecardSubmissionRow } from "../lib/recruiting-ops/delivery-source/scorecard-submission"
import {
  candidateTabTitleForReportingWeek,
  pipelineValueReadTargetForReportingWeek,
  planProjectedDeliveryRpsValues,
  planStagingArtifactValues,
  weeklyProgressHeaderForReportingWeek,
} from "../lib/recruiting-ops/delivery/staging-artifact-value-planner"
import {
  buildDeliveryRpsReportFormatPlan,
  type GoogleWorkspaceStagingClients,
} from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import {
  DELIVERY_RPS_DATED_HEADERS,
  DELIVERY_RPS_HEADERS,
  getStagingSheetContract,
  RPS_HEADERS,
} from "../lib/recruiting-ops/delivery/staging-sheet-contracts"
import { deliveryRpsTargetSheetId } from "../lib/recruiting-ops/delivery/staging-structural-normalization"

const DELIVERY_REPORT_DATE = "2026-07-09"

beforeEach(() => {
  process.env[PII_FINGERPRINT_SALT_ENV] = "staging-artifact-planner-test-key"
})

describe("staging artifact value planner", () => {
  test("derives the legacy candidate-tab stamp from each Friday-Thursday bucket", () => {
    expect(candidateTabTitleForReportingWeek("2026-07-03")).toBe("Candidate Level Data - 10 July")
    expect(candidateTabTitleForReportingWeek("2026-07-31")).toBe("Candidate Level Data - 7 August")
    expect(candidateTabTitleForReportingWeek("2026-12-25")).toBe("Candidate Level Data - 1 January")
  })

  test("rejects non-ISO and normalized-overflow dates", () => {
    expect(() => candidateTabTitleForReportingWeek("07/03/2026")).toThrow(/ISO/)
    expect(() => candidateTabTitleForReportingWeek("2026-02-30")).toThrow(/ISO/)
    expect(() => candidateTabTitleForReportingWeek("2026-07-04")).toThrow(/Friday/)
  })

  test("formats the recurring Weekly Progress header in the copied sheet's DD MMM contract", () => {
    expect(weeklyProgressHeaderForReportingWeek("2026-07-03")).toBe("03 Jul - 09 Jul")
    expect(weeklyProgressHeaderForReportingWeek("2026-07-31")).toBe("31 Jul - 06 Aug")
    expect(weeklyProgressHeaderForReportingWeek("2026-12-25")).toBe("25 Dec - 31 Dec")
    expect(weeklyProgressHeaderForReportingWeek("2027-01-01")).toBe("01 Jan - 07 Jan")
    expect(() => weeklyProgressHeaderForReportingWeek("2026-02-30")).toThrow(/ISO/)
    expect(() => weeklyProgressHeaderForReportingWeek("2026-07-04")).toThrow(/Friday/)
  })

  test.each([
    ["pipeline_890", "Job level pipeline", "Q", "AC"],
    ["pipeline_907", "Job level pipeline", "N", "AC"],
    ["pipeline_1026_1027", "Job Level Pipeline", "N", "AF"],
    ["pipeline_1118_1119", "Job level pipeline", "N", "AF"],
  ] as const)(
    "derives exact open read widths and the dynamic 10 July tab for %s",
    (artifactKey, jobTitle, candidateEndColumn, jobEndColumn) => {
      expect(pipelineValueReadTargetForReportingWeek(artifactKey, "2026-07-03")).toEqual({
        candidateTitle: "Candidate Level Data - 10 July",
        jobTitle,
        ranges: [
          `'Candidate Level Data - 10 July'!A:${candidateEndColumn}`,
          `'${jobTitle}'!A:${jobEndColumn}`,
        ],
      })
    }
  )

  test("plans the Q3 master, performance source, and exact monthly pivot-source tabs", async () => {
    const ids = [
      "final_offer_master",
      "final_offer_performance_data",
      "final_offer_july_data",
      "final_offer_august_data",
      "final_offer_september_data",
    ] as const
    const batchGet = vi.fn(async () => ({
      data: {
        valueRanges: ids.flatMap((id) => [
          { values: [[...getStagingSheetContract(id).headers]] },
          { values: [] },
        ]),
      },
    }))
    const clients = {
      sheets: {
        spreadsheets: {
          values: {
            batchGet,
          },
        },
      },
      docs: {},
      drive: {},
    } as unknown as GoogleWorkspaceStagingClients
    const offer = finalOffer()

    const result = await planStagingArtifactValues({
      artifactKey: "final_offer",
      runId: "final_offer_q3_test",
      facts: {
        generatedAt: "2026-07-11T12:00:00.000Z",
        reportingWeekFriday: "2026-07-03",
        quarterStart: "2026-07-01",
        candidateEvents: [],
        offers: [offer],
        scorecards: [],
        reqWeeks: [],
        diagnostics: [],
      },
      roster: [],
      clients,
      structure: {
        spreadsheetId: "copy",
        properties: { count: 0, fingerprint: `sha256:${"0".repeat(64)}` },
        namedRanges: { count: 0, fingerprint: `sha256:${"0".repeat(64)}` },
        sheets: [],
        structureHash: `sha256:${"a".repeat(64)}`,
      },
    })

    expect(result.plan.approvedRangeIds).toEqual(ids)
    expect(batchGet).toHaveBeenCalledWith(expect.objectContaining({
      ranges: [
        "'Mastersheet'!A1:AE1", "'Mastersheet'!A2:AE1000",
        "'Performance Sheet data'!A1:AE1", "'Performance Sheet data'!A2:AE1000",
        "'July Offer Data'!A1:AE1", "'July Offer Data'!A2:AE1000",
        "'August Offer Data'!A1:AE1", "'August Offer Data'!A2:AE1000",
        "'September Offer Data'!A1:AE1", "'September Offer Data'!A2:AE1000",
      ],
    }))
    expect(result.plan.writes.map((write) => write.a1Range)).toEqual([
      "'Mastersheet'!A2:AE2",
      "'Performance Sheet data'!A2:AE2",
      "'July Offer Data'!A2:AE2",
      "'August Offer Data'!A2:AE2",
      "'September Offer Data'!A2:AE2",
    ])
    expect(result.plan.writes.map((write) => write.changed)).toEqual([true, true, true, false, false])
  })

  test("an identical Final Offer retry no-ops all bounded value ranges", async () => {
    const ids = [
      "final_offer_master",
      "final_offer_performance_data",
      "final_offer_july_data",
      "final_offer_august_data",
      "final_offer_september_data",
    ] as const
    const facts = { ...hydrationFacts([]), offers: [finalOffer()] }
    const first = await planStagingArtifactValues({
      artifactKey: "final_offer",
      runId: "final_offer_first_write",
      facts,
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: {
          valueRanges: ids.flatMap((id) => [
            { values: [[...getStagingSheetContract(id).headers]] },
            { values: [] },
          ]),
        },
      }))),
      structure: emptyStructure(),
    })
    const retry = await planStagingArtifactValues({
      artifactKey: "final_offer",
      runId: "final_offer_retry",
      facts,
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: {
          valueRanges: ids.flatMap((id, index) => [
            { values: [[...getStagingSheetContract(id).headers]] },
            { values: first.plan.writes[index].values },
          ]),
        },
      }))),
      structure: emptyStructure(),
    })

    expect(retry.plan.noOp).toBe(true)
    expect(retry.plan.writes).toHaveLength(5)
    expect(retry.plan.writes.every((write) => !write.changed)).toBe(true)
  })

  test("targets the explicitly prepared Weekly Recruitment tab for a fresh reporting week", async () => {
    const headers = [...getStagingSheetContract("weekly_recruitment_current").headers]
    const existing = Array(26).fill(null)
    existing[0] = "Existing role"
    existing[1] = "closed"
    existing[2] = "999"
    const batchGet = vi.fn(async () => ({
      data: { valueRanges: [{ values: [headers, existing] }] },
    }))
    const futureWeek = {
      ...hydrationFacts([]),
      reportingWeekFriday: "2026-07-10",
    }
    const result = await planStagingArtifactValues({
      artifactKey: "weekly_recruitment",
      runId: "fresh_week_target",
      facts: futureWeek,
      roster: [],
      clients: valueReadClients(batchGet),
      structure: emptyStructure(),
    })
    expect(batchGet).toHaveBeenCalledWith(expect.objectContaining({
      ranges: ["'Weekly Working Report Sheet 10 Jul to 16 Jul 2026'!A1:Z1000"],
    }))
    expect(result.plan.writes.map((write) => write.a1Range)).toEqual([
      "'Weekly Working Report Sheet 10 Jul to 16 Jul 2026'!A2:C2",
      "'Weekly Working Report Sheet 10 Jul to 16 Jul 2026'!E2:F2",
      "'Weekly Working Report Sheet 10 Jul to 16 Jul 2026'!H2:I2",
      "'Weekly Working Report Sheet 10 Jul to 16 Jul 2026'!M2:W2",
      "'Weekly Working Report Sheet 10 Jul to 16 Jul 2026'!Y2:Z2",
    ])
  })

  test("targets only the active year-qualified Q4 Final Offer month tabs", async () => {
    const ids = [
      "final_offer_master",
      "final_offer_performance_data",
      "final_offer_october_data",
      "final_offer_november_data",
      "final_offer_december_data",
    ] as const
    const batchGet = vi.fn(async () => ({
      data: {
        valueRanges: ids.flatMap((id) => [
          { values: [[...getStagingSheetContract(id).headers]] },
          { values: [] },
        ]),
      },
    }))
    const result = await planStagingArtifactValues({
      artifactKey: "final_offer",
      runId: "future_quarter_dynamic",
      facts: {
        ...hydrationFacts([]),
        reportingWeekFriday: "2026-10-02",
        quarterStart: "2026-10-01",
      },
      roster: [],
      clients: valueReadClients(batchGet),
      structure: emptyStructure(),
    })

    expect(result.plan.approvedRangeIds).toEqual(ids)
    expect(result.plan.writes.map((write) => write.a1Range)).toEqual([
      "'Mastersheet'!A2:AE2",
      "'Performance Sheet data'!A2:AE2",
      "'October 2026 Offer Data'!A2:AE2",
      "'November 2026 Offer Data'!A2:AE2",
      "'December 2026 Offer Data'!A2:AE2",
    ])
    expect(result.plan.writes.every((write) => !write.a1Range.includes("July") && !write.a1Range.includes("September")))
      .toBe(true)
  })

  test("targets the observed future Delivery dated destination", async () => {
    const batchGet = vi.fn(async () => ({
      data: { valueRanges: [
        { values: [DELIVERY_RPS_HEADERS] },
        { values: [] },
        { values: [DELIVERY_RPS_HEADERS] },
        { values: [] },
        { values: emptyDeliveryDatedReport() },
      ] },
    }))
    const result = await planStagingArtifactValues({
      artifactKey: "delivery_roles_rps",
      runId: "future_delivery_target",
      deliveryRpsReportDate: "2026-07-16",
      facts: { ...hydrationFacts([]), reportingWeekFriday: "2026-07-10" },
      roster: [],
      clients: valueReadClients(batchGet),
      structure: emptyStructure(),
    })

    expect(batchGet).toHaveBeenCalledWith(expect.objectContaining({
      ranges: expect.arrayContaining(["'16 Jul 2026'!A3:N"]),
    }))
    expect(result.plan.writes[2].a1Range).toBe("'16 Jul 2026'!A3:N20")
    expect(result.plan.writes[2].values.filter((row) => row[0]).map((row) => row[0])).toEqual([
      "Summary by Team",
      "Team",
      "Summary by Submitter",
      "Submitter",
      "Match / Mismatch Check",
      "Match Status",
      "Role-Level Detail",
      "Requisition ID",
      "Raw Detail",
      "Candidate",
    ])
  })

  test("plans the copied RPS ledger continuously from 02 Mar and reports remaining capacity", async () => {
    const batchGet = vi.fn(async () => ({
      data: { valueRanges: [{ values: [RPS_HEADERS] }, { values: [] }] },
    }))
    const result = await planStagingArtifactValues({
      artifactKey: "rps_tracking",
      runId: "rps_history_test",
      facts: hydrationFacts([scorecard("1", "2026-07-08T19:00:00.000Z")]),
      roster: [],
      clients: valueReadClients(batchGet),
      structure: emptyStructure(),
    })

    expect(batchGet).toHaveBeenCalledWith(expect.objectContaining({
      ranges: ["'Data Dump'!A1:R1", "'Data Dump'!A2:R4251"],
    }))
    expect(result.plan.writes[0].values[0][15]).toBe(19)
    expect(result.publicSummary.sourceScope).toMatchObject({
      periodStartMonday: "2026-03-02",
      submittedAtStart: "2026-03-02",
      submittedAtEndExclusive: "2026-07-10",
      includedRowCount: 1,
      dataRowCapacity: 4_250,
      remainingDataRowCapacity: 4_249,
      continuity: {
        mode: "legacy_artifact_seed_append",
        preservedSeedRows: 0,
        appendedPlatformRows: 1,
        totalRows: 1,
      },
    })
  })

  test("uses the observed copied RPS grid capacity after lifecycle expansion", async () => {
    const batchGet = vi.fn(async () => ({
      data: { valueRanges: [{ values: [RPS_HEADERS] }, { values: [] }] },
    }))
    const result = await planStagingArtifactValues({
      artifactKey: "rps_tracking",
      runId: "rps_dynamic_capacity_test",
      facts: hydrationFacts([scorecard("1", "2026-07-08T19:00:00.000Z")]),
      roster: [],
      clients: valueReadClients(batchGet, undefined, true, 5_001),
      structure: emptyStructure(),
    })

    expect(batchGet).toHaveBeenCalledWith(expect.objectContaining({
      ranges: ["'Data Dump'!A1:R1", "'Data Dump'!A2:R5001"],
    }))
    expect(result.publicSummary.sourceScope).toMatchObject({
      dataRowCapacity: 5_000,
      remainingDataRowCapacity: 4_999,
    })
  })

  test("blocks RPS planning before the merged continuity ledger can exceed copied grid capacity", async () => {
    const start = Date.parse("2026-07-08T19:00:00.000Z")
    const rows = Array.from({ length: 4_251 }, (_, index) =>
      scorecard(String(index + 1), new Date(start + index).toISOString())
    )
    await expect(planStagingArtifactValues({
      artifactKey: "rps_tracking",
      runId: "rps_capacity_test",
      facts: hydrationFacts(rows),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [{ values: [RPS_HEADERS] }, { values: [] }] },
      }))),
      structure: emptyStructure(),
    })).rejects.toThrow("requires 4251 merged data rows but the copied Data Dump capacity is 4250")
  })

  test("blocks RPS continuity when the projected source does not cover copied history", async () => {
    const existing = Array<null | string>(18).fill(null)
    existing[2] = "993"
    existing[6] = "Recruiter Phone Screen"
    existing[9] = "2026-03-03 12:00:00.000"
    existing[10] = "Historic Submitter"
    await expect(planStagingArtifactValues({
      artifactKey: "rps_tracking",
      runId: "rps_history_loss_test",
      facts: hydrationFacts([]),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [{ values: [RPS_HEADERS] }, { values: [existing] }] },
      }))),
      structure: emptyStructure(),
    })).rejects.toThrow("existing seed row(s) without exactly one projected source timestamp match")
  })

  test("preserves a transferred RPS seed row exactly and produces an exact no-op", async () => {
    const existing = Array<null | string>(18).fill(null)
    existing[2] = "historic-req"
    existing[6] = "Legacy Interview Label"
    existing[9] = "2026-07-08 19:00:00.00"
    existing[10] = "Legacy Submitter Label"
    const result = await planStagingArtifactValues({
      artifactKey: "rps_tracking",
      runId: "rps_normalized_identity_test",
      facts: hydrationFacts([scorecard("1", "2026-07-08T19:00:00.000Z", {
        interview_name: "Current Interview Label",
        submitter_name: "Current Submitter Label",
      })]),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [{ values: [RPS_HEADERS] }, { values: [existing] }] },
      }))),
      structure: emptyStructure(),
    })
    expect(result.plan.noOp).toBe(true)
    expect(result.plan.writes[0].values[0]).toEqual(existing)
    expect(result.publicSummary.sourceScope).toMatchObject({
      includedRowCount: 1,
      continuity: {
        mode: "legacy_artifact_seed_append",
        preservedSeedRows: 1,
        appendedPlatformRows: 0,
        totalRows: 1,
      },
    })
  })

  test("keeps RPS seed order and appends only unseen projected timestamps deterministically", async () => {
    const existing = Array<null | string>(18).fill(null)
    existing[2] = "historic-req"
    existing[9] = "2026-07-08 19:00:00.000"
    const result = await planStagingArtifactValues({
      artifactKey: "rps_tracking",
      runId: "rps_seed_append_test",
      facts: hydrationFacts([
        scorecard("1", "2026-07-08T19:00:00.000Z"),
        scorecard("3", "2026-07-08T21:00:00.000Z", { requisition_id: "new-req-3" }),
        scorecard("2", "2026-07-08T20:00:00.000Z", { requisition_id: "new-req-2" }),
      ]),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [{ values: [RPS_HEADERS] }, { values: [existing] }] },
      }))),
      structure: emptyStructure(),
    })
    expect(result.plan.writes[0].values.map((row) => row[2])).toEqual([
      "historic-req", "new-req-2", "new-req-3",
    ])
    expect(result.plan.writes[0].values.map((row) => row[9])).toEqual([
      "2026-07-08 19:00:00.000",
      "2026-07-08 20:00:00.000",
      "2026-07-08 21:00:00.000",
    ])
    expect(result.publicSummary.sourceScope).toMatchObject({
      continuity: {
        preservedSeedRows: 1,
        appendedPlatformRows: 2,
        totalRows: 3,
      },
      remainingDataRowCapacity: 4_247,
    })
  })

  test("blocks duplicate reporting timestamps in the existing RPS seed", async () => {
    const existing = Array<null | string>(18).fill(null)
    existing[2] = "993"
    existing[9] = "2026-07-08 19:00:00.000"
    await expect(planStagingArtifactValues({
      artifactKey: "rps_tracking",
      runId: "rps_duplicate_seed_timestamp_test",
      facts: hydrationFacts([scorecard("1", "2026-07-08T19:00:00.000Z")]),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [{ values: [RPS_HEADERS] }, { values: [existing, existing] }] },
      }))),
      structure: emptyStructure(),
    })).rejects.toThrow("existing seed contains duplicate normalized reporting timestamps")
  })

  test("blocks duplicate reporting timestamps in the projected RPS source", async () => {
    await expect(planStagingArtifactValues({
      artifactKey: "rps_tracking",
      runId: "rps_duplicate_projected_timestamp_test",
      facts: hydrationFacts([
        scorecard("1", "2026-07-08T19:00:00.000Z"),
        scorecard("2", "2026-07-08T19:00:00.000Z"),
      ]),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [{ values: [RPS_HEADERS] }, { values: [] }] },
      }))),
      structure: emptyStructure(),
    })).rejects.toThrow("projected source contains duplicate normalized reporting timestamps")
  })

  test("blocks a nonblank RPS seed row without a valid reporting timestamp", async () => {
    const existing = Array<null | string>(18).fill(null)
    existing[2] = "historic-req"
    existing[9] = "not-a-timestamp"
    await expect(planStagingArtifactValues({
      artifactKey: "rps_tracking",
      runId: "rps_invalid_seed_timestamp_test",
      facts: hydrationFacts([]),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [{ values: [RPS_HEADERS] }, { values: [existing] }] },
      }))),
      structure: emptyStructure(),
    })).rejects.toThrow("existing seed row 1 has a missing or invalid reporting timestamp")
  })

  test("blocks an internal all-blank RPS seed row rather than collapsing its position", async () => {
    const first = Array<null | string>(18).fill(null)
    first[2] = "historic-req-1"
    first[9] = "2026-07-08 19:00:00.000"
    const second = Array<null | string>(18).fill(null)
    second[2] = "historic-req-2"
    second[9] = "2026-07-08 20:00:00.000"
    await expect(planStagingArtifactValues({
      artifactKey: "rps_tracking",
      runId: "rps_internal_blank_seed_row_test",
      facts: hydrationFacts([
        scorecard("1", "2026-07-08T19:00:00.000Z"),
        scorecard("2", "2026-07-08T20:00:00.000Z"),
      ]),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [{ values: [RPS_HEADERS] }, { values: [first, [], second] }] },
      }))),
      structure: emptyStructure(),
    })).rejects.toThrow("existing seed contains an internal all-blank row at row 2")
  })

  test("blocks Delivery continuity when the projected source does not cover copied weekly rows", async () => {
    const existing = Array<null | string>(20).fill(null)
    existing[2] = "907"
    existing[6] = "Recruiter Phone Screen"
    existing[9] = "2026-07-08T19:00:00.000+00:00"
    existing[12] = "Historic Submitter"
    await expect(planStagingArtifactValues({
      artifactKey: "delivery_roles_rps",
      runId: "delivery_history_loss_test",
      deliveryRpsReportDate: DELIVERY_REPORT_DATE,
      facts: hydrationFacts([]),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [existing] },
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [existing] },
          { values: deliveryDatedReport([["Team Platform", 4, 0, 0, 0, 0, 0, 4]]) },
        ] },
      }))),
      structure: emptyStructure(),
    })).rejects.toThrow("existing seed row(s) without exactly one projected source timestamp match")
  })

  test("preserves transferred Delivery seed rows independently and produces an exact no-op", async () => {
    const existing = Array<null | string>(20).fill(null)
    existing[2] = "historic-req"
    existing[6] = "Legacy Interview Label"
    existing[9] = "2026-07-08T19:00:00.000+00:00"
    existing[12] = "Legacy Submitter Label"
    const cleanedExisting: Array<null | string | number> = [...existing]
    cleanedExisting[6] = "Legacy Cleaned Interview Label"
    cleanedExisting[9] = indiaWallClockSerial("2026-07-08T19:00:00.000Z")
    const result = await planStagingArtifactValues({
      artifactKey: "delivery_roles_rps",
      runId: "delivery_normalized_identity_test",
      deliveryRpsReportDate: DELIVERY_REPORT_DATE,
      facts: hydrationFacts([scorecard("1", "2026-07-08T19:00:00.000Z", {
        requisition_id: "907",
        job_name: "Forward Deployed Engineer - US | Bench",
        interview_name: "Current Interview Label",
        submitter_name: "Current Submitter Label",
      })]),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [existing] },
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [cleanedExisting] },
          { values: emptyDeliveryDatedReport() },
        ] },
      }))),
      structure: emptyStructure(),
    })
    expect(result.plan.noOp).toBe(true)
    expect(result.plan.writes[0].values[0]).toEqual(existing)
    expect(result.plan.writes[1].values[0]).toEqual(cleanedExisting)
    expect(result.publicSummary.sourceScope).toMatchObject({
      includedRowCount: 1,
      datedIncludedRowCount: 0,
      continuity: {
        raw: {
          preservedSeedRows: 1,
          appendedPlatformRows: 0,
          totalRows: 1,
        },
        clean: {
          preservedSeedRows: 1,
          appendedPlatformRows: 0,
          totalRows: 1,
        },
        mergedIdentityCount: 1,
        reportDateRows: 0,
      },
    })
  })

  test("validates Delivery history without backfilling rows outside the current reporting window", async () => {
    const existing = Array<null | string>(20).fill(null)
    existing[2] = "historic-req"
    existing[9] = "2026-07-08T19:00:00.000+00:00"
    existing[12] = "Legacy Submitter"
    const cleanedExisting: Array<null | string | number> = [...existing]
    cleanedExisting[9] = indiaWallClockSerial("2026-07-08T19:00:00.000Z")
    const deliveryScorecard = (id: string, submittedAt: string) => scorecard(id, submittedAt, {
      requisition_id: "907",
      job_name: "Forward Deployed Engineer - US | Bench",
    })
    const result = await planStagingArtifactValues({
      artifactKey: "delivery_roles_rps",
      runId: "delivery_current_window_append_test",
      deliveryRpsReportDate: "2026-07-10",
      facts: {
        ...hydrationFacts([
          deliveryScorecard("historic-seed", "2026-07-08T19:00:00.000Z"),
          deliveryScorecard("historic-unseen", "2026-07-09T19:00:00.000Z"),
          deliveryScorecard("current-unseen", "2026-07-10T19:00:00.000Z"),
        ]),
        reportingWeekFriday: "2026-07-10",
      },
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [existing] },
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [cleanedExisting] },
          { values: emptyDeliveryDatedReport() },
        ] },
      }))),
      structure: emptyStructure(),
    })

    expect(result.plan.writes[0].values.map((row) => row[9])).toEqual([
      "2026-07-08T19:00:00.000+00:00",
      "2026-07-10T19:00:00.000+00:00",
    ])
    expect(result.plan.writes[1].values.map((row) => row[9])).toEqual([
      indiaWallClockSerial("2026-07-08T19:00:00.000Z"),
      indiaWallClockSerial("2026-07-10T19:00:00.000Z"),
    ])
    expect(result.publicSummary.sourceScope).toMatchObject({
      submittedAtStart: "2026-07-10",
      submittedAtEndExclusive: "2026-07-17",
      includedRowCount: 1,
      continuity: {
        raw: {
          preservedSeedRows: 1,
          appendedPlatformRows: 1,
          totalRows: 2,
        },
        clean: {
          preservedSeedRows: 1,
          appendedPlatformRows: 1,
          totalRows: 2,
        },
      },
    })
  })

  test("opens the new Delivery reporting week from Friday's report date even with prior-week source metadata", async () => {
    const result = await planStagingArtifactValues({
      artifactKey: "delivery_roles_rps",
      runId: "delivery_friday_rollover_test",
      deliveryRpsReportDate: "2026-07-17",
      facts: {
        ...hydrationFacts([scorecard("friday", "2026-07-17T19:00:00.000Z", {
          requisition_id: "907",
          job_name: "Forward Deployed Engineer - US | Bench",
        })]),
        reportingWeekFriday: "2026-07-10",
      },
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [] },
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [] },
          { values: emptyDeliveryDatedReport() },
        ] },
      }))),
      structure: emptyStructure(),
    })

    expect(result.plan.writes[0].values).toHaveLength(1)
    expect(result.publicSummary.sourceScope).toMatchObject({
      submittedAtStart: "2026-07-17",
      submittedAtEndExclusive: "2026-07-24",
      includedRowCount: 1,
      datedIncludedRowCount: 1,
    })
  })

  test("blocks duplicate reporting timestamps in an existing Delivery ledger seed", async () => {
    const existing = Array<null | string>(20).fill(null)
    existing[2] = "907"
    existing[9] = "2026-07-08T19:00:00.000+00:00"
    const source = scorecard("1", "2026-07-08T19:00:00.000Z", {
      requisition_id: "907",
      job_name: "Forward Deployed Engineer - US | Bench",
    })
    const cleanedExisting: Array<null | string | number> = [...existing]
    cleanedExisting[9] = indiaWallClockSerial("2026-07-08T19:00:00.000Z")
    await expect(planStagingArtifactValues({
      artifactKey: "delivery_roles_rps",
      runId: "delivery_duplicate_seed_timestamp_test",
      deliveryRpsReportDate: DELIVERY_REPORT_DATE,
      facts: hydrationFacts([source]),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [existing, existing] },
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [cleanedExisting, cleanedExisting] },
          { values: emptyDeliveryDatedReport() },
        ] },
      }))),
      structure: emptyStructure(),
    })).rejects.toThrow("existing seed contains duplicate normalized reporting timestamps")
  })

  test("blocks duplicate reporting timestamps in the projected Delivery source", async () => {
    const source = scorecard("1", "2026-07-08T19:00:00.000Z", {
      requisition_id: "907",
      job_name: "Forward Deployed Engineer - US | Bench",
    })
    const duplicateSource = scorecard("2", "2026-07-08T19:00:00.000Z", {
      requisition_id: "907",
      job_name: "Forward Deployed Engineer - US | Bench",
    })
    await expect(planStagingArtifactValues({
      artifactKey: "delivery_roles_rps",
      runId: "delivery_duplicate_projected_timestamp_test",
      deliveryRpsReportDate: DELIVERY_REPORT_DATE,
      facts: hydrationFacts([source, duplicateSource]),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [] },
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [] },
          { values: emptyDeliveryDatedReport() },
        ] },
      }))),
      structure: emptyStructure(),
    })).rejects.toThrow("projected source contains duplicate normalized reporting timestamps")
  })

  test("builds the Delivery dated summary from preserved Raw history plus appended rows", async () => {
    const rawExisting = Array<null | string>(20).fill(null)
    rawExisting[2] = "historic-req"
    rawExisting[6] = "Historic Interview"
    rawExisting[9] = "2026-07-09T10:00:00.000+00:00"
    rawExisting[12] = "Historic Submitter"
    rawExisting[13] = "Strong Yes"
    rawExisting[14] = "Match"
    rawExisting[16] = "Historic Team"
    const cleanedExisting: Array<null | string | number> = [...rawExisting]
    cleanedExisting[6] = "Historic Cleaned Interview"
    cleanedExisting[9] = indiaWallClockSerial("2026-07-09T10:00:00.000Z")
    cleanedExisting[16] = "Historic Clean Team"
    const result = await planStagingArtifactValues({
      artifactKey: "delivery_roles_rps",
      runId: "delivery_merged_summary_test",
      deliveryRpsReportDate: DELIVERY_REPORT_DATE,
      facts: hydrationFacts([
        scorecard("1", "2026-07-09T10:00:00.000Z", {
          requisition_id: "907",
          job_name: "Forward Deployed Engineer - US | Bench",
          submitter_name: "Current Submitter",
          overall_recommendation: "no",
          match_mismatch: "mismatch",
        }),
        scorecard("2", "2026-07-09T11:00:00.000Z", {
          requisition_id: "907",
          job_name: "Forward Deployed Engineer - US | Bench",
          submitter_name: "Appended Submitter",
          overall_recommendation: "yes",
          match_mismatch: "mismatch",
        }),
      ]),
      roster: [
        { recruiterName: "Current Submitter", teamId: "current", teamName: "Current Team", hodName: "Current HOD" },
        { recruiterName: "Appended Submitter", teamId: "appended", teamName: "Appended Team", hodName: "Appended HOD" },
      ],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [rawExisting] },
          { values: [DELIVERY_RPS_HEADERS] },
          { values: [cleanedExisting] },
          { values: deliveryDatedReport([["Stale Current Team", 1, 0, 1, 0, 0, 1, 0]]) },
        ] },
      }))),
      structure: emptyStructure(),
    })

    expect(result.plan.writes[0].values[0]).toEqual(rawExisting)
    expect(result.plan.writes[1].values[0]).toEqual(cleanedExisting)
    expect(result.plan.writes[0].values[1][16]).toBe("Appended Team")
    expect(result.plan.writes[1].values[1][16]).toBe("Appended Team")
    expect(result.plan.writes[0].values[1][9]).toBe("2026-07-09T11:00:00.000+00:00")
    expect(result.plan.writes[0].values[1][10]).toBe(46_212)
    expect(result.plan.writes[1].values[1][9]).toBe(indiaWallClockSerial("2026-07-09T11:00:00.000Z"))
    expect(result.plan.writes[1].values[1][10]).toBe(
      "Thu Jul 09 2026 00:00:00 GMT+0530 (India Standard Time)"
    )
    expect(result.plan.writes[0].a1Range).toBe("'Raw_Daily_RPS'!A2:T3")
    expect(result.plan.writes[1].a1Range).toBe("'Cleaned_RPS'!A2:T3")
    expect(result.plan.writes[2].a1Range).toBe("'09 Jul 2026'!A3:N30")
    expect(result.plan.writes[2].values.slice(0, 4).map((row) => row.slice(0, 8))).toEqual([
      ["Summary by Team", null, null, null, null, null, null, null],
      DELIVERY_RPS_DATED_HEADERS,
      ["Appended Team", 1, 0, 1, 0, 1, 0, 0],
      ["Historic Team", 1, 1, 0, 1, 0, 0, 0],
    ])
    const datedValues = result.plan.writes[2].values
    const roleIndex = datedValues.findIndex((row) => row[0] === "Role-Level Detail")
    const rawIndex = datedValues.findIndex((row) => row[0] === "Raw Detail")
    expect(datedValues[roleIndex + 2].slice(0, 3)).toEqual([907, "Forward Deployed Engineer - US | Bench", 1])
    expect(datedValues[roleIndex + 3].slice(0, 3)).toEqual(["historic-req", null, 1])
    expect(datedValues.slice(rawIndex + 2).map((row) => row.slice(2, 10))).toEqual([
      ["historic-req", null, "Historic Submitter", "Historic Team", "Historic Interview", null, "Strong Yes", "Match"],
      [907, null, "Appended Submitter", "Appended Team", null, null, "Yes", "Mismatch"],
    ])
    expect(result.publicSummary.sourceScope).toMatchObject({
      datedIncludedRowCount: 2,
      continuity: {
        raw: {
          mode: "legacy_artifact_seed_append",
          preservedSeedRows: 1,
          appendedPlatformRows: 1,
          totalRows: 2,
        },
        clean: {
          mode: "legacy_artifact_seed_append",
          preservedSeedRows: 1,
          appendedPlatformRows: 1,
          totalRows: 2,
        },
        mergedIdentityCount: 2,
        reportDateRows: 2,
      },
    })

    const second = await planStagingArtifactValues({
      artifactKey: "delivery_roles_rps",
      runId: "delivery_merged_summary_noop_test",
      deliveryRpsReportDate: DELIVERY_REPORT_DATE,
      facts: hydrationFacts([
        scorecard("1", "2026-07-09T10:00:00.000Z", {
          requisition_id: "907",
          job_name: "Forward Deployed Engineer - US | Bench",
          submitter_name: "Current Submitter",
          overall_recommendation: "no",
          match_mismatch: "mismatch",
        }),
        scorecard("2", "2026-07-09T11:00:00.000Z", {
          requisition_id: "907",
          job_name: "Forward Deployed Engineer - US | Bench",
          submitter_name: "Appended Submitter",
          overall_recommendation: "yes",
          match_mismatch: "mismatch",
        }),
      ]),
      roster: [
        { recruiterName: "Current Submitter", teamId: "current", teamName: "Current Team", hodName: "Current HOD" },
        { recruiterName: "Appended Submitter", teamId: "appended", teamName: "Appended Team", hodName: "Appended HOD" },
      ],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [
          { values: [DELIVERY_RPS_HEADERS] },
          { values: result.plan.writes[0].values },
          { values: [DELIVERY_RPS_HEADERS] },
          { values: result.plan.writes[1].values },
          { values: result.plan.writes[2].values },
        ] },
      }))),
      structure: emptyStructure(),
    })
    expect(second.plan.noOp).toBe(true)
    expect(second.plan.writes.every((write) => !write.changed)).toBe(true)
  })

  test("certifies the exact zero-mutation Delivery projection for an absent dated target", async () => {
    const reportDate = "2026-07-21"
    const target = {
      targetSheetId: deliveryRpsTargetSheetId(reportDate),
      targetSheetTitle: "21 Jul 2026",
      templateSheetId: 2061940582,
      templateSheetTitle: "16 Jul 2026",
      firstValueRow: 3 as const,
      preservedValueRowCount: 2 as const,
    }
    const structure = projectedDeliveryStructure("62", reportDate)
    const fixture = projectedDeliveryClients({ template: target })

    const result = await planProjectedDeliveryRpsValues({
      runId: "delivery_projected_absent_target_test",
      facts: hydrationFacts([]),
      roster: [],
      clients: fixture.clients,
      deliveryRpsReportDate: reportDate,
      target,
      structure,
    })

    expect(result.plan).not.toHaveProperty("structureHash")
    expect(result.plan.writes.map((write) => write.rangeId)).toEqual([
      "delivery_rps_raw",
      "delivery_rps_clean",
      "delivery_rps_dated",
    ])
    expect(result.plan.writes[2]).toMatchObject({
      a1Range: "'21 Jul 2026'!A3:N20",
      changed: true,
    })
    expect(result.publicSummary).toMatchObject({
      artifactKey: "delivery_roles_rps",
      rangeCount: 3,
      projectedChangedRangeCount: 1,
      projectedValueNoOp: false,
      projectedPreimageFingerprint: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/),
      desiredPayloadFingerprint: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/),
      formatFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    })
    expect(fixture.driveGet).toHaveBeenCalledTimes(2)
    expect(fixture.batchGet).toHaveBeenCalledWith(expect.objectContaining({
      ranges: expect.arrayContaining(["'16 Jul 2026'!A3:N"]),
    }))
    expect(fixture.sheetsGet).toHaveBeenCalledWith(expect.objectContaining({
      fields: "spreadsheetId,sheets(properties(sheetId,title))",
    }))
  })

  test("rejects a Delivery projection when the paired Drive fence changes", async () => {
    const reportDate = "2026-07-21"
    const target = {
      targetSheetId: deliveryRpsTargetSheetId(reportDate),
      targetSheetTitle: "21 Jul 2026",
      templateSheetId: 2061940582,
      templateSheetTitle: "16 Jul 2026",
      firstValueRow: 3 as const,
      preservedValueRowCount: 2 as const,
    }
    const fixture = projectedDeliveryClients({ template: target, versions: ["62", "63"] })

    await expect(planProjectedDeliveryRpsValues({
      runId: "delivery_projected_drive_drift_test",
      facts: hydrationFacts([]),
      roster: [],
      clients: fixture.clients,
      deliveryRpsReportDate: reportDate,
      target,
      structure: projectedDeliveryStructure("62", reportDate),
    })).rejects.toThrow("changed during projected dry-run planning")
  })

  test.each([
    ["wrong MIME type", { mimeType: "text/csv" }],
    ["trashed workbook", { trashed: true }],
    ["missing edit capability", { capabilities: { canEdit: false, canModifyContent: true } }],
    ["missing content capability", { capabilities: { canEdit: true, canModifyContent: false } }],
  ] as const)("rejects a Delivery projection with %s", async (_label, metadata) => {
    const reportDate = "2026-07-21"
    const target = {
      targetSheetId: deliveryRpsTargetSheetId(reportDate),
      targetSheetTitle: "21 Jul 2026",
      templateSheetId: 2061940582,
      templateSheetTitle: "16 Jul 2026",
      firstValueRow: 3 as const,
      preservedValueRowCount: 2 as const,
    }
    const fixture = projectedDeliveryClients({ template: target, metadata })

    await expect(planProjectedDeliveryRpsValues({
      runId: "delivery_projected_drive_capability_test",
      facts: hydrationFacts([]),
      roster: [],
      clients: fixture.clients,
      deliveryRpsReportDate: reportDate,
      target,
      structure: projectedDeliveryStructure("62", reportDate),
    })).rejects.toThrow("changed during projected dry-run planning")
  })

  test("rejects a Delivery projection whose structural basis belongs to another date", async () => {
    const reportDate = "2026-07-21"
    const target = {
      targetSheetId: deliveryRpsTargetSheetId(reportDate),
      targetSheetTitle: "21 Jul 2026",
      templateSheetId: 2061940582,
      templateSheetTitle: "16 Jul 2026",
      firstValueRow: 3 as const,
      preservedValueRowCount: 2 as const,
    }
    const fixture = projectedDeliveryClients({ template: target })

    await expect(planProjectedDeliveryRpsValues({
      runId: "delivery_projected_wrong_structure_date_test",
      facts: hydrationFacts([]),
      roster: [],
      clients: fixture.clients,
      deliveryRpsReportDate: reportDate,
      target,
      structure: {
        ...projectedDeliveryStructure("62", reportDate),
        normalizationId: "delivery_rps_dated_rollover_20260720",
      },
    })).rejects.toThrow("does not match the dated rollover contract")
    expect(fixture.driveGet).not.toHaveBeenCalled()
  })

  test.each([
    ["wrong workbook", { readbackSpreadsheetId: "wrong-copy" }, "unexpected spreadsheet"],
    ["target race", { targetAppears: true }, "target appeared during planning"],
  ] as const)("rejects a projected Delivery %s during the absence read", async (_label, options, message) => {
    const reportDate = "2026-07-21"
    const target = {
      targetSheetId: deliveryRpsTargetSheetId(reportDate),
      targetSheetTitle: "21 Jul 2026",
      templateSheetId: 2061940582,
      templateSheetTitle: "16 Jul 2026",
      firstValueRow: 3 as const,
      preservedValueRowCount: 2 as const,
    }
    const fixture = projectedDeliveryClients({ template: target, ...options })

    await expect(planProjectedDeliveryRpsValues({
      runId: "delivery_projected_absence_read_test",
      facts: hydrationFacts([]),
      roster: [],
      clients: fixture.clients,
      deliveryRpsReportDate: reportDate,
      target,
      structure: projectedDeliveryStructure("62", reportDate),
    })).rejects.toThrow(message)
  })

  test("fails closed if the copied Delivery workbook leaves the audited India-time contract", async () => {
    await expect(planStagingArtifactValues({
      artifactKey: "delivery_roles_rps",
      runId: "delivery_time_zone_contract_test",
      deliveryRpsReportDate: DELIVERY_REPORT_DATE,
      facts: hydrationFacts([]),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [
          { values: [DELIVERY_RPS_HEADERS] }, { values: [] },
          { values: [DELIVERY_RPS_HEADERS] }, { values: [] },
          { values: emptyDeliveryDatedReport() },
        ] },
      })), { locale: "en_US", timeZone: "UTC" }),
      structure: emptyStructure(),
    })).rejects.toThrow("audited legacy locale/time-zone contract")
  })

  test("plans appended Delivery date serials into a runway the sheet has never formatted", async () => {
    // Rows below the sheet's last formatted row are never pre-formatted, so a
    // planner that demanded the format up front could only ever refuse the very
    // append that would establish it. Planning must now succeed here.
    const planned = await planStagingArtifactValues({
      artifactKey: "delivery_roles_rps",
      runId: "delivery_number_format_runway_test",
      deliveryRpsReportDate: DELIVERY_REPORT_DATE,
      facts: hydrationFacts([scorecard("1", "2026-07-08T19:00:00.000Z", {
        requisition_id: "907",
        job_name: "Forward Deployed Engineer - US | Bench",
      })]),
      roster: [],
      clients: valueReadClients(vi.fn(async () => ({
        data: { valueRanges: [
          { values: [DELIVERY_RPS_HEADERS] }, { values: [] },
          { values: [DELIVERY_RPS_HEADERS] }, { values: [] },
          { values: emptyDeliveryDatedReport() },
        ] },
      })), undefined, false),
      structure: emptyStructure(),
    })

    const rawWrite = planned.plan.writes.find((write) => write.rangeId === "delivery_rps_raw")
    const cleanWrite = planned.plan.writes.find((write) => write.rangeId === "delivery_rps_clean")
    expect(rawWrite?.values.length).toBeGreaterThan(0)
    expect(cleanWrite?.values.length).toBeGreaterThan(0)

    // The format has to travel in the same mutation as the serial, over exactly
    // the rows being written, touching nothing but the number format.
    const formatPlan = buildDeliveryRpsReportFormatPlan(planned.plan)
    const ledgerRequests = formatPlan?.ledgerRequests ?? []
    // updateCells, never repeatCell: Google silently drops repeatCell on at
    // least one canonical spreadsheet while accepting the batch (2026-08-13).
    const raw = ledgerRequests.find((request) => request.updateCells?.start?.sheetId === 1072762955)
    const clean = ledgerRequests.find((request) => request.updateCells?.start?.sheetId === 1598905318)

    expect(raw?.updateCells?.start).toEqual({ sheetId: 1072762955, rowIndex: 1, columnIndex: 10 })
    expect(raw?.updateCells?.rows).toHaveLength(rawWrite?.values.length ?? 0)
    expect(raw?.updateCells?.rows?.[0]?.values?.[0]?.userEnteredFormat?.numberFormat)
      .toEqual({ type: "DATE", pattern: "d mmmm yyyy" })
    expect(raw?.updateCells?.fields).toBe("userEnteredFormat.numberFormat")

    expect(clean?.updateCells?.start).toEqual({ sheetId: 1598905318, rowIndex: 1, columnIndex: 8 })
    expect(clean?.updateCells?.rows).toHaveLength(cleanWrite?.values.length ?? 0)
    expect(clean?.updateCells?.rows?.[0]?.values).toHaveLength(2)
    expect(clean?.updateCells?.rows?.[0]?.values?.[0]?.userEnteredFormat?.numberFormat).toEqual({ type: "DATE" })
    expect(clean?.updateCells?.fields).toBe("userEnteredFormat.numberFormat")

    // Every appended date cell must fall inside a planned format range, or the
    // serial reaches the sheet with nothing to render it.
    const rawCheck = formatPlan?.ledgerDateFormatChecks
      ?.find((check) => check.sheetTitle === "Raw_Daily_RPS")
    expect(rawCheck?.endRowIndex).toBe(1 + (rawWrite?.values.length ?? 0))
    expect(rawCheck?.requiredPattern).toBe("d mmmm yyyy")
  })
})

function deliveryDatedReport(
  teamRows: readonly (readonly (string | number | null)[])[] = []
): (string | number | null)[][] {
  const padded = (row: readonly (string | number | null)[]) =>
    Array.from({ length: 14 }, (_, column) => row[column] ?? null)
  return [
    padded(["Summary by Team"]),
    padded(DELIVERY_RPS_DATED_HEADERS),
    ...teamRows.map(padded),
    padded([]),
    padded([]),
    padded(["Summary by Submitter"]),
    padded(["Submitter", ...DELIVERY_RPS_DATED_HEADERS.slice(1)]),
    padded([]),
    padded([]),
    padded(["Match / Mismatch Check"]),
    padded(["Match Status", "Count"]),
    padded([]),
    padded([]),
    padded(["Role-Level Detail"]),
    padded(["Requisition ID", "Job Name", "Total RPS", "Submitters", "Recruiters", "Sourcers"]),
    padded([]),
    padded([]),
    padded(["Raw Detail"]),
    padded([
      "Candidate", "Job", "Req ID", "Status", "Submitter", "Submitter Team", "Interview",
      "Interviewer", "Recommendation", "Match/Mismatch", "Recruiters", "Sourcers", "Week", "Key Takeaways",
    ]),
  ]
}

function emptyDeliveryDatedReport(): (string | number | null)[][] {
  return deliveryDatedReport()
}

function finalOffer(): OfferLifecycleExportRow {
  return {
    source_system: "greenhouse",
    offer_id: "7001",
    offer_status: "accepted",
    application_id: "101",
    application_status: "hired",
    application_stage: "Offer",
    candidate_id: "501",
    candidate_name: "Fixture Candidate",
    job_id: "900",
    requisition_id: "1027",
    job_name: "Research Engineer, RL Gyms - US",
    detailed_job_title: "Research Engineer, RL Gyms - US",
    job_status: "open",
    job_level: "IC",
    department_name: "R&D / Engineering",
    hiring_location: "Remote",
    recruiter_of_record_id: "21",
    recruiter_of_record_name: "Fixture Recruiter",
    sourcer_id: "24",
    sourcer_name: "Fixture Sourcer",
    hod_id: null,
    hod_name: "Fixture HOD",
    created_by_id: "22",
    created_by_name: "Fixture Creator",
    approver_id: null,
    approver_name: null,
    rejection_reason_id: null,
    rejection_reason_name: null,
    rejection_type: null,
    rejected_at: null,
    candidate_source_id: "77",
    candidate_source_name: "Referral",
    candidate_source_type: "Referrals",
    created_at: "2026-07-02T10:00:00.000Z",
    sent_at: "2026-07-03T10:00:00.000Z",
    resolved_at: "2026-07-05T10:00:00.000Z",
    start_date: "2026-07-20",
    custom_field_metadata: [],
  }
}

function scorecard(
  scorecardId: string,
  submittedAt: string,
  overrides: Partial<ScorecardSubmissionRow> = {}
): ScorecardSubmissionRow {
  return {
    scorecard_id: scorecardId,
    application_id: null,
    candidate_id: null,
    candidate_name: null,
    application_status: null,
    job_id: null,
    requisition_id: "993",
    job_name: null,
    job_status: null,
    recruiter_names: [],
    sourcer_names: [],
    interview_kit_id: null,
    job_interview_id: null,
    interview_name: null,
    interviewer_id: null,
    interviewer_name: null,
    scheduled_interview_ended_at: null,
    interviewed_at: null,
    created_at: null,
    updated_at: null,
    submitted_at: submittedAt,
    legacy_bic_reporting_at: submittedAt,
    submitter_id: null,
    submitter_name: null,
    scorecard_status: "complete",
    candidate_rating: null,
    overall_recommendation: null,
    match_mismatch: "unknown",
    month_bucket: null,
    month_ordinal: null,
    week_bucket: null,
    week_ordinal: null,
    qa_summary: null,
    key_takeaways: null,
    ...overrides,
  }
}

function hydrationFacts(scorecards: readonly ScorecardSubmissionRow[]) {
  return {
    generatedAt: "2026-07-11T12:00:00.000Z",
    reportingWeekFriday: "2026-07-03",
    quarterStart: "2026-07-01",
    candidateEvents: [],
    offers: [],
    scorecards,
    reqWeeks: [],
    diagnostics: [],
  }
}

function indiaWallClockSerial(timestamp: string): number {
  return (Date.parse(timestamp) + 330 * 60_000) / 86_400_000 + 25_569
}

function projectedDeliveryStructure(version: string, reportDate: string) {
  return {
    kind: "projected_post_normalization" as const,
    normalizationId: `delivery_rps_dated_rollover_${reportDate.replaceAll("-", "")}`,
    normalizationFingerprint: `sha256:${"1".repeat(64)}`,
    observedDriveVersion: version,
    observedStructureFingerprint: `sha256:${"2".repeat(64)}`,
    expectedAfterStateFingerprint: `sha256:${"3".repeat(64)}`,
    forwardRequestsFingerprint: `sha256:${"4".repeat(64)}`,
    rollbackRequestsFingerprint: `sha256:${"5".repeat(64)}`,
  }
}

function projectedDeliveryClients(input: {
  template: {
    targetSheetId?: number
    targetSheetTitle?: string
    templateSheetId: number
    templateSheetTitle: string
  }
  versions?: readonly string[]
  readbackSpreadsheetId?: string
  targetAppears?: boolean
  metadata?: {
    mimeType?: string
    trashed?: boolean
    capabilities?: { canEdit: boolean; canModifyContent: boolean }
  }
}) {
  const canonicalId = "1ExampleDriveId00000000000000000000000000013"
  const versions = input.versions ?? ["62", "62"]
  let driveRead = 0
  const driveGet = vi.fn(async () => ({
    data: {
      id: canonicalId,
      version: versions[driveRead++] ?? versions.at(-1),
      mimeType: input.metadata?.mimeType ?? "application/vnd.google-apps.spreadsheet",
      trashed: input.metadata?.trashed ?? false,
      capabilities: input.metadata?.capabilities ?? { canEdit: true, canModifyContent: true },
    },
  }))
  const batchGet = vi.fn(async () => ({
    data: {
      valueRanges: [
        { values: [DELIVERY_RPS_HEADERS] },
        { values: [] },
        { values: [DELIVERY_RPS_HEADERS] },
        { values: [] },
        { values: emptyDeliveryDatedReport() },
      ],
    },
  }))
  const sheetsGet = vi.fn(async (request: { fields?: string }) => {
    if (request.fields === "spreadsheetId,sheets(properties(sheetId,title))") {
      return {
        data: {
          spreadsheetId: input.readbackSpreadsheetId ?? canonicalId,
          sheets: [
            { properties: { sheetId: 1072762955, title: "Raw_Daily_RPS" } },
            { properties: { sheetId: 1598905318, title: "Cleaned_RPS" } },
            { properties: {
              sheetId: input.template.templateSheetId,
              title: input.template.templateSheetTitle,
            } },
            ...(input.targetAppears
              ? [{ properties: {
                  sheetId: input.template.targetSheetId,
                  title: input.template.targetSheetTitle,
                } }]
              : []),
          ],
        },
      }
    }
    return {
      data: {
        spreadsheetId: canonicalId,
        properties: { locale: "en_US", timeZone: "Asia/Calcutta" },
      },
    }
  })
  return {
    clients: {
      sheets: { spreadsheets: { get: sheetsGet, values: { batchGet } } },
      docs: {},
      drive: { files: { get: driveGet } },
    } as unknown as GoogleWorkspaceStagingClients,
    batchGet,
    driveGet,
    sheetsGet,
  }
}

function valueReadClients(
  batchGet: ReturnType<typeof vi.fn>,
  properties: { locale: string; timeZone: string } = {
    locale: "en_US",
    timeZone: "Asia/Calcutta",
  },
  appendFormatsReady = true,
  rpsDataRowCount = 4_251
): GoogleWorkspaceStagingClients {
  return {
    sheets: {
      spreadsheets: {
        get: vi.fn(async (request: { includeGridData?: boolean; fields?: string }) => {
          if (request.fields?.includes("gridProperties(rowCount,columnCount)")) {
            return {
              data: {
                spreadsheetId: "1ExampleDriveId00000000000000000000000000008",
                sheets: [{
                  properties: {
                    sheetId: 1092300150,
                    title: "Data Dump",
                    gridProperties: { rowCount: rpsDataRowCount, columnCount: 18 },
                  },
                }],
              },
            }
          }
          if (!request.includeGridData) {
            return {
              data: {
                spreadsheetId: "1ExampleDriveId00000000000000000000000000013",
                properties,
              },
            }
          }
          const rawNumberFormat = appendFormatsReady
            ? { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "d mmmm yyyy" } } }
            : {}
          const cleanNumberFormat = appendFormatsReady
            ? { userEnteredFormat: { numberFormat: { type: "DATE" } } }
            : {}
          return {
            data: {
              spreadsheetId: "1ExampleDriveId00000000000000000000000000013",
              sheets: [
                {
                  properties: { title: "Raw_Daily_RPS" },
                  data: [{
                    startRow: 0,
                    startColumn: 10,
                    rowData: Array.from({ length: 100 }, () => ({ values: [rawNumberFormat] })),
                  }],
                },
                {
                  properties: { title: "Cleaned_RPS" },
                  data: [{
                    startRow: 0,
                    startColumn: 8,
                    rowData: Array.from(
                      { length: 100 },
                      () => ({ values: [cleanNumberFormat, cleanNumberFormat] })
                    ),
                  }],
                },
              ],
            },
          }
        }),
        values: { batchGet },
      },
    },
    docs: {},
    drive: {},
  } as unknown as GoogleWorkspaceStagingClients
}

function emptyStructure() {
  return {
    spreadsheetId: "copy",
    properties: { count: 0, fingerprint: `sha256:${"0".repeat(64)}` },
    namedRanges: { count: 0, fingerprint: `sha256:${"0".repeat(64)}` },
    sheets: [],
    structureHash: `sha256:${"a".repeat(64)}`,
  }
}
