import { beforeEach, describe, expect, test, vi } from "vitest"

import { PII_FINGERPRINT_SALT_ENV } from "../lib/recruiting-ops/checksums"
import {
  runStagingHydration,
  stagingHydrationSourceRequirementsForArtifacts,
} from "../lib/recruiting-ops/delivery/staging-hydration-runner"
import type { GoogleWorkspaceStagingClients } from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import { getStagingArtifact } from "../lib/recruiting-ops/delivery/staging-artifact-registry"
import type { StagingHydrationFacts } from "../lib/recruiting-ops/delivery-source/staging-hydration-source-loader"
import type { OfferLifecycleExportRow } from "../lib/recruiting-ops/delivery-source/offer-lifecycle-export"
import type { ScorecardSubmissionRow } from "../lib/recruiting-ops/delivery-source/scorecard-submission"
import { RPS_HEADERS } from "../lib/recruiting-ops/delivery/staging-sheet-contracts"
import { assertPublicSafe } from "../lib/recruiting-ops/safe-public-output"

describe("staging hydration runner", () => {
  beforeEach(() => {
    process.env[PII_FINGERPRINT_SALT_ENV] = "runner-test-hmac-key"
  })

  test("requests expensive all-status scorecard sources only for their artifact lanes", () => {
    expect(stagingHydrationSourceRequirementsForArtifacts(["all_hires"])).toEqual({
      includeLegacyRpsHistory: false,
      includeDeliveryRpsCurrentWeek: false,
    })
    expect(stagingHydrationSourceRequirementsForArtifacts(["rps_tracking"])).toEqual({
      includeLegacyRpsHistory: true,
      includeDeliveryRpsCurrentWeek: false,
    })
    expect(stagingHydrationSourceRequirementsForArtifacts(["delivery_roles_rps"])).toEqual({
      includeLegacyRpsHistory: false,
      includeDeliveryRpsCurrentWeek: true,
    })
  })

  test("dry-runs one copied artifact with zero Google mutations", async () => {
    const artifact = getStagingArtifact("all_hires")
    const batchUpdate = vi.fn()
    const clients = {
      sheets: {
        spreadsheets: {
          get: vi.fn(async () => ({
            data: {
              spreadsheetId: artifact.artifactId,
              properties: { title: "Copy of All Hires", locale: "en_US", timeZone: "UTC" },
              sheets: [{
                properties: {
                  sheetId: 1324142221,
                  title: "Data sheet",
                  index: 0,
                  sheetType: "GRID",
                  gridProperties: { rowCount: 1009, columnCount: 29 },
                },
              }],
            },
          })),
          getByDataFilter: emptyStructureDataFilterRead(1324142221),
          values: {
            batchGet: vi.fn(async () => ({
              data: {
                valueRanges: [
                  { values: [[
                    "Job Category", "Job Name", "Candidate Name", "Accepted Date", "Accepted Month",
                    "Month Order (Acc)", "Start Date", "Start Month", "Month Order(Start)",
                  ]] },
                  { values: [] },
                ],
              },
            })),
            batchUpdate,
          },
        },
      },
      docs: {},
      drive: {},
    } as unknown as GoogleWorkspaceStagingClients
    const offer = {
      offer_id: "offer-1",
      offer_status: "accepted",
      requisition_id: "1027",
      candidate_name: "Fixture Candidate",
      resolved_at: "2026-07-08T00:00:00Z",
      start_date: "2026-08-01",
      created_at: "2026-07-04T00:00:00Z",
    } as OfferLifecycleExportRow
    const facts: StagingHydrationFacts = {
      generatedAt: "2026-07-11T12:00:00.000Z",
      reportingWeekFriday: "2026-07-03",
      quarterStart: "2026-07-01",
      candidateEvents: [],
      offers: [offer],
      scorecards: [],
      reqWeeks: [],
      diagnostics: [],
    }

    const result = await runStagingHydration({
      artifactKeys: ["all_hires"],
      mode: "dry_run",
      nowMs: Date.parse("2026-07-11T12:00:00Z"),
      clients,
      facts,
      roster: [],
      stageTaxonomy: [],
    })
    expect(result.artifactOutcomes).toHaveLength(1)
    expect(result.artifactOutcomes[0]).toMatchObject({
      artifactKey: "all_hires",
      status: "dry_run",
      plan: { rangeCount: 1, changedRangeCount: 1, noOp: false },
    })
    expect(batchUpdate).not.toHaveBeenCalled()
  })

  test("returns bounded no-mutation evidence without exposing a private planning error", async () => {
    const clients = {
      sheets: {
        spreadsheets: {
          get: vi.fn(async () => {
            throw new Error("Candidate Amina Vega private source detail")
          }),
        },
      },
      docs: {},
      drive: {},
    } as unknown as GoogleWorkspaceStagingClients
    const facts: StagingHydrationFacts = {
      generatedAt: "2026-07-11T12:00:00.000Z",
      reportingWeekFriday: "2026-07-03",
      quarterStart: "2026-07-01",
      candidateEvents: [],
      offers: [],
      scorecards: [],
      reqWeeks: [],
      diagnostics: [],
    }

    const result = await runStagingHydration({
      artifactKeys: ["all_hires"],
      mode: "dry_run",
      nowMs: Date.parse("2026-07-11T12:00:00Z"),
      clients,
      facts,
      roster: [],
    })

    expect(result.artifactOutcomes[0]).toEqual({
      artifactKey: "all_hires",
      status: "blocked",
      failure: {
        failureStage: "planning",
        mutationCallCount: 0,
        beforeDriveVersion: null,
        afterDriveVersion: null,
        certificationStatus: "not_attempted",
      },
      reason: "Staging hydration failed at planning.",
    })
    expect(JSON.stringify(result)).not.toContain("Amina Vega")
    expect(() => assertPublicSafe(result)).not.toThrow()
  })

  test("reports RPS submitted-period exclusions in the public dry-run summary", async () => {
    const artifact = getStagingArtifact("rps_tracking")
    const batchUpdate = vi.fn()
    const clients = {
      sheets: {
        spreadsheets: {
          get: vi.fn(async () => ({
            data: {
              spreadsheetId: artifact.artifactId,
              properties: { title: "Copy of RPS Tracking", locale: "en_US", timeZone: "UTC" },
              sheets: [{
                properties: {
                  sheetId: 1092300150,
                  title: "Data Dump",
                  index: 0,
                  sheetType: "GRID",
                  gridProperties: { rowCount: 4252, columnCount: 18 },
                },
              }],
            },
          })),
          getByDataFilter: emptyStructureDataFilterRead(1092300150),
          values: {
            batchGet: vi.fn(async () => ({
              data: { valueRanges: [{ values: [RPS_HEADERS] }, { values: [] }] },
            })),
            batchUpdate,
          },
        },
      },
      docs: {},
      drive: {},
    } as unknown as GoogleWorkspaceStagingClients
    const baseScorecard = {
      scorecard_id: "1",
      application_id: null,
      candidate_id: null,
      candidate_name: null,
      application_status: null,
      job_id: null,
      requisition_id: null,
      job_name: null,
      job_status: null,
      recruiter_names: [],
      sourcer_names: [],
      interview_kit_id: null,
      job_interview_id: null,
      interview_name: null,
      interviewer_id: null,
      interviewer_name: null,
      scheduled_interview_ended_at: "2026-06-20T18:00:00.000Z",
      interviewed_at: "2026-06-20T17:00:00.000Z",
      created_at: null,
      updated_at: null,
      submitted_at: "2026-07-01T00:00:00.000Z",
      legacy_bic_reporting_at: "2026-07-01T00:00:00.000Z",
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
    } satisfies ScorecardSubmissionRow
    const facts: StagingHydrationFacts = {
      generatedAt: "2026-07-11T12:00:00.000Z",
      reportingWeekFriday: "2026-07-03",
      quarterStart: "2026-07-01",
      candidateEvents: [],
      offers: [],
      scorecards: [
        baseScorecard,
        {
          ...baseScorecard,
          scorecard_id: "2",
          submitted_at: "2026-03-01T23:59:59.999Z",
          legacy_bic_reporting_at: "2026-03-01T23:59:59.999Z",
        },
        { ...baseScorecard, scorecard_id: "3", submitted_at: null, legacy_bic_reporting_at: null },
      ],
      reqWeeks: [],
      diagnostics: [],
    }

    const result = await runStagingHydration({
      artifactKeys: ["rps_tracking"],
      mode: "dry_run",
      nowMs: Date.parse("2026-07-11T12:00:00Z"),
      clients,
      facts,
      roster: [],
      stageTaxonomy: [],
    })

    expect(result.artifactOutcomes[0]).toMatchObject({
      artifactKey: "rps_tracking",
      status: "dry_run",
      plan: {
        sourceScope: {
          sourceRowCount: 3,
          includedRowCount: 1,
          excludedRowCount: 2,
          excludedReasonCounts: {
            missing_or_invalid_submitted_at: 1,
            submitted_before_period: 1,
            submitted_at_or_after_period_end: 0,
          },
        },
      },
    })
    expect(batchUpdate).not.toHaveBeenCalled()
  })
})

function emptyStructureDataFilterRead(sheetId: number) {
  return vi.fn(async (request: {
    requestBody?: { dataFilters?: readonly { gridRange?: { startRowIndex?: number; startColumnIndex?: number } }[] }
  }) => ({
    data: {
      sheets: [{
        properties: { sheetId },
        data: (request.requestBody?.dataFilters ?? []).map((filter) => ({
          startRow: filter.gridRange?.startRowIndex ?? 0,
          startColumn: filter.gridRange?.startColumnIndex ?? 0,
        })),
      }],
    },
  }))
}
