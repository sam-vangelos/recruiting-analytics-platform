import { beforeEach, describe, expect, test } from "vitest"

import { PII_FINGERPRINT_SALT_ENV } from "../lib/recruiting-ops/checksums"
import type { OfferLifecycleExportRow } from "../lib/recruiting-ops/delivery-source/offer-lifecycle-export"
import { googleDateSerial, renderAllHiresRows } from "../lib/recruiting-ops/delivery/all-hires-renderer"
import {
  buildAllHiresBoundedValueInput,
  buildFinalOfferBoundedValueInput,
} from "../lib/recruiting-ops/delivery/bounded-value-plan-inputs"
import { projectFinalOfferSheet } from "../lib/recruiting-ops/delivery/final-offer-sheet-renderer"
import { getStagingSheetContract } from "../lib/recruiting-ops/delivery/staging-sheet-contracts"
import { buildStagingSheetValuePlan } from "../lib/recruiting-ops/delivery/staging-value-plan"

const q3 = { startDate: "2026-07-01", endDateExclusive: "2026-10-01" }
const q2 = { startDate: "2026-04-01", endDateExclusive: "2026-07-01" }

beforeEach(() => {
  process.env[PII_FINGERPRINT_SALT_ENV] = "bounded-value-plan-test-key"
})

function offer(overrides: Partial<OfferLifecycleExportRow> = {}): OfferLifecycleExportRow {
  return {
    source_system: "greenhouse",
    offer_id: "7001",
    offer_status: "accepted",
    application_id: "101",
    application_status: "hired",
    application_stage: "Offer",
    candidate_id: "501",
    candidate_name: "Candidate One",
    job_id: "900",
    requisition_id: "1027",
    job_name: "Research Engineer",
    detailed_job_title: "Research Engineer, RL Gyms - US",
    job_status: "open",
    job_level: "IC",
    department_name: "Engineering",
    hiring_location: "Remote",
    recruiter_of_record_id: "21",
    recruiter_of_record_name: "Offer Recruiter",
    sourcer_id: "24",
    sourcer_name: "Offer Sourcer",
    hod_id: "25",
    hod_name: "HOD",
    created_by_id: "22",
    created_by_name: "Creator",
    approver_id: "23",
    approver_name: "Approver",
    rejection_reason_id: null,
    rejection_reason_name: null,
    rejection_type: null,
    rejected_at: null,
    candidate_source_id: "77",
    candidate_source_name: "Referral",
    candidate_source_type: "Referral",
    created_at: "2026-07-02T10:00:00.000Z",
    sent_at: "2026-07-03T10:00:00.000Z",
    resolved_at: "2026-07-05T10:00:00.000Z",
    start_date: "2026-07-20",
    custom_field_metadata: [],
    ...overrides,
  }
}

function finalProjection(rows: readonly OfferLifecycleExportRow[], quarter = q3) {
  return projectFinalOfferSheet({ rows, roster: [], quarter })
}

describe("bounded Final Offer value-plan input", () => {
  test("preserves history, replaces the quarter, and explicitly clears stale tail rows", () => {
    const historical = finalProjection(
      [
        offer({
          offer_id: "6001",
          application_id: "91",
          created_at: "2026-06-20T10:00:00.000Z",
        }),
      ],
      q2
    ).rows[0].values
    const projection = finalProjection([offer()])
    const oldCurrent = [...projection.rows[0].values]
    oldCurrent[0] = "Stale Candidate Display"
    const staleQuarter = finalProjection([
      offer({
        offer_id: "7002",
        application_id: "102",
        created_at: "2026-07-03T10:00:00.000Z",
      }),
    ]).rows[0].values

    const result = buildFinalOfferBoundedValueInput({
      currentValues: [historical, oldCurrent, staleQuarter],
      projection,
      quarter: q3,
    })

    expect(result).toMatchObject({
      preservedHistoryRowCount: 1,
      replacedQuarterRowCount: 2,
      staleQuarterRowCount: 1,
      clearedTrailingRowCount: 1,
    })
    expect(result.range.rangeId).toBe("final_offer_master")
    expect(result.range.a1Range).toBe("'Mastersheet'!A2:AE4")
    expect(result.range.currentValues).toHaveLength(3)
    expect(result.range.desiredValues[0]).toEqual(historical)
    expect(result.range.desiredValues[1]).toEqual(projection.rows[0].values)
    expect(result.range.desiredValues[2]).toEqual(Array(31).fill(null))

    const plan = buildStagingSheetValuePlan({
      artifactKey: "final_offer",
      runId: "final_offer_bounded_1",
      sourceGeneratedAt: "2026-07-11T12:00:00Z",
      structureHash: `sha256:${"a".repeat(64)}`,
      dataProvenance: "fixture",
      ranges: [result.range],
    })
    expect(plan.writes[0].a1Range).toBe("'Mastersheet'!A2:AE4")
    expect(plan.writes[0].values).toEqual(result.range.desiredValues)
  })

  test("fails closed on duplicate current keys and a projection outside the replacement quarter", () => {
    const projection = finalProjection([offer()])
    expect(() =>
      buildFinalOfferBoundedValueInput({
        currentValues: [projection.rows[0].values, projection.rows[0].values],
        projection,
        quarter: q3,
      })
    ).toThrow("duplicate application/created-at")

    const q2Projection = finalProjection(
      [offer({ created_at: "2026-06-20T10:00:00.000Z" })],
      q2
    )
    expect(() =>
      buildFinalOfferBoundedValueInput({ currentValues: [], projection: q2Projection, quarter: q3 })
    ).toThrow("outside the replacement quarter")
  })
})

describe("bounded All Hires value-plan input", () => {
  test("appends each accepted offer once across consecutive source cuts", () => {
    const dimensions = [{
      requisitionId: "1027",
      jobCategory: "FDL",
      jobName: "Governed Frontier Data Lead - RL Gyms",
    }]
    const historical = [
      "FDL", "Historical Role", "Historical Candidate", googleDateSerial("2026-05-01"),
      "May 2026", 9, null, null, null,
    ]
    const firstOffer = offer({
      offer_id: "offer-1",
      candidate_name: "Candidate One",
      resolved_at: "2026-06-15T12:00:00Z",
    })
    const secondOffer = offer({
      offer_id: "offer-2",
      candidate_name: "Candidate Two",
      resolved_at: "2026-06-16T12:00:00Z",
    })

    const first = buildAllHiresBoundedValueInput({
      currentValues: [historical],
      projectedRows: renderAllHiresRows({ offers: [firstOffer], displayDimensions: dimensions }),
    })
    const retry = buildAllHiresBoundedValueInput({
      currentValues: first.range.desiredValues,
      projectedRows: renderAllHiresRows({ offers: [firstOffer], displayDimensions: dimensions }),
    })
    const nextCut = buildAllHiresBoundedValueInput({
      currentValues: retry.range.desiredValues,
      projectedRows: renderAllHiresRows({ offers: [firstOffer, secondOffer], displayDimensions: dimensions }),
    })

    expect(first).toMatchObject({ preservedExistingRowCount: 1, appendedRowCount: 1 })
    expect(retry).toMatchObject({ preservedExistingRowCount: 2, correctedRowCount: 1, appendedRowCount: 0 })
    expect(retry.range.desiredValues).toEqual(first.range.desiredValues)
    const retryPlan = buildStagingSheetValuePlan({
      artifactKey: "all_hires",
      runId: "all_hires_retry",
      sourceGeneratedAt: "2026-07-11T12:00:00Z",
      structureHash: `sha256:${"b".repeat(64)}`,
      dataProvenance: "fixture",
      ranges: [retry.range],
    })
    expect(retryPlan.noOp).toBe(true)
    expect(retryPlan.writes[0].changed).toBe(false)
    expect(nextCut).toMatchObject({ preservedExistingRowCount: 2, correctedRowCount: 1, appendedRowCount: 1 })
    expect(nextCut.range.desiredValues[0]).toEqual(historical)
    expect(nextCut.offerRowBindings).toEqual([
      { offerId: "offer-1", sheetRow: 3, action: "corrected" },
      { offerId: "offer-2", sheetRow: 4, action: "appended" },
    ])
    expect(nextCut.range.desiredValues.filter((row) => row[2] === "Candidate One")).toHaveLength(1)
  })

  test("preserves older history, safely corrects a natural-key match, and appends offer-backed rows", () => {
    const oldHistory = [
      "FDL",
      "Historical Role",
      "Historical Candidate",
      googleDateSerial("2026-05-01"),
      "May 2026",
      9,
      null,
      null,
      null,
    ]
    const existingMatch = [
      "Old Category",
      "Old Display Name",
      "Candidate One",
      googleDateSerial("2026-06-15"),
      "June 2026",
      10,
      null,
      null,
      null,
    ]
    const projectedRows = renderAllHiresRows({
      offers: [
        offer({
          offer_id: "offer-1",
          candidate_name: "Candidate One",
          resolved_at: "2026-06-15T12:00:00Z",
          start_date: "2026-07-01",
        }),
        offer({
          offer_id: "offer-2",
          candidate_name: "Candidate Two",
          resolved_at: "2026-06-16T12:00:00Z",
          start_date: "2026-07-02",
        }),
      ],
      displayDimensions: [
        {
          requisitionId: "1027",
          jobCategory: "FDL",
          jobName: "Governed Frontier Data Lead - RL Gyms",
        },
      ],
    })

    const result = buildAllHiresBoundedValueInput({
      currentValues: [oldHistory, existingMatch],
      projectedRows,
    })

    expect(result).toMatchObject({
      preservedExistingRowCount: 2,
      correctedRowCount: 1,
      appendedRowCount: 1,
    })
    expect(result.offerRowBindings).toEqual([
      { offerId: "offer-1", sheetRow: 3, action: "corrected" },
      { offerId: "offer-2", sheetRow: 4, action: "appended" },
    ])
    expect(result.range.a1Range).toBe("'Data sheet'!A2:I4")
    expect(result.range.desiredValues[0]).toEqual(oldHistory)
    expect(result.range.desiredValues[1]).toEqual(projectedRows[0].cells)
    expect(result.range.desiredValues[2]).toEqual(projectedRows[1].cells)
    expect(result.range.currentValues[2]).toEqual(Array(9).fill(null))

    const plan = buildStagingSheetValuePlan({
      artifactKey: "all_hires",
      runId: "all_hires_bounded_1",
      sourceGeneratedAt: "2026-07-11T12:00:00Z",
      structureHash: `sha256:${"b".repeat(64)}`,
      dataProvenance: "fixture",
      ranges: [result.range],
    })
    expect(plan.writes[0].values).toEqual(result.range.desiredValues)
  })

  test("fails closed when natural-key matches are ambiguous or non-canonical", () => {
    const [projected] = renderAllHiresRows({
      offers: [offer({ offer_id: "offer-1", resolved_at: "2026-06-15T12:00:00Z" })],
      displayDimensions: [{ requisitionId: "1027", jobCategory: "FDL", jobName: "FDL" }],
    })
    const current = [
      "FDL",
      "Role",
      "Candidate One",
      googleDateSerial("2026-06-15"),
      null,
      null,
      null,
      null,
      null,
    ]
    expect(() =>
      buildAllHiresBoundedValueInput({
        currentValues: [current, current],
        projectedRows: [projected],
      })
    ).toThrow("ambiguous candidate/accepted-date")
    expect(() =>
      buildAllHiresBoundedValueInput({
        currentValues: [[...current.slice(0, 3), "not-an-unformatted-date", ...current.slice(4)]],
        projectedRows: [projected],
      })
    ).toThrow("invalid accepted date")
    expect(() =>
      buildAllHiresBoundedValueInput({
        currentValues: [],
        projectedRows: [projected, { ...projected, upsertKey: "different-offer" }],
      })
    ).toThrow("ambiguous offers")
  })

  test("rejects matrices that include the protected header row", () => {
    const headers = getStagingSheetContract("all_hires_data").headers
    expect(() =>
      buildAllHiresBoundedValueInput({ currentValues: [headers], projectedRows: [] })
    ).toThrow("exclude the protected header")
  })
})
