import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("../lib/recruiting-ops/delivery/google-workspace-staging-client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../lib/recruiting-ops/delivery/google-workspace-staging-client")
  >()
  return {
    ...actual,
    normalizeStagingSheetStructure: vi.fn(),
    readStagingDriveMetadata: vi.fn(),
    readStagingSpreadsheet: vi.fn(),
    readStagingStructuralNormalizationSnapshot: vi.fn(),
    readStagingValueRanges: vi.fn(),
  }
})

vi.mock("../lib/recruiting-ops/delivery/staging-structural-normalization-observer", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../lib/recruiting-ops/delivery/staging-structural-normalization-observer")
  >()
  return {
    ...actual,
    bindStagingStructuralFilterPreimages: vi.fn((spec) => spec),
    projectStagingStructuralNormalizationState: vi.fn((_snapshot, spec) => spec.expectedBefore),
  }
})

import type { KillSwitchState } from "../lib/recruiting-ops/autonomy"
import { fridayWeekLabels } from "../lib/recruiting-ops/exec-definitions"
import {
  normalizeStagingSheetStructure,
  readStagingDriveMetadata,
  readStagingSpreadsheet,
  readStagingStructuralNormalizationSnapshot,
  readStagingValueRanges,
  StagingStructuralNormalizationExecutionError,
  type GoogleWorkspaceStagingClients,
} from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import { planProjectedDeliveryRpsValues } from "../lib/recruiting-ops/delivery/staging-artifact-value-planner"
import { STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID } from "../lib/recruiting-ops/delivery/staging-kill-switch"
import {
  pipelineJobSummaryLifecycleSheet,
  runStagingRecurringSheetLifecycle,
} from "../lib/recruiting-ops/delivery/staging-recurring-sheet-lifecycle-runner"
import {
  finalOfferMonthSheetIds,
  finalOfferMonthTabTitles,
  pipelineCandidateRolloverNormalizationSpec,
  pipelineCandidateTargetSheetId,
  planStagingStructuralNormalization,
  type FinalOfferLifecycleSheet,
  type StagingStructuralNormalizationSpec,
} from "../lib/recruiting-ops/delivery/staging-structural-normalization"
import {
  pipelineLegacyWeekOrder,
  pipelineRenderContracts,
  type PipelineArtifactKey,
} from "../lib/recruiting-ops/delivery/pipeline-sheet-renderer"
import { getStagingSheetContract } from "../lib/recruiting-ops/delivery/staging-sheet-contracts"
import { projectStagingStructuralNormalizationState } from "../lib/recruiting-ops/delivery/staging-structural-normalization-observer"

/**
 * The pipeline candidate rollover spec builder returns null when there is no
 * structural work left to do (target tab already present, no filter to carry,
 * no job-summary block). Tests that exercise a real rollover assert a spec.
 */
function requirePipelineRolloverSpec(
  spec: StagingStructuralNormalizationSpec | null
): StagingStructuralNormalizationSpec {
  if (!spec) throw new Error("Expected a pipeline candidate rollover spec")
  return spec
}


const NOW = Date.parse("2026-07-14T16:00:00.000Z")
const PIPELINE_CANONICAL_ID = "1ExampleDriveId00000000000000000000000000009"
const WEEKLY_PROGRESS_CANONICAL_ID = "1ExampleDriveId00000000000000000000000000002"
const DELIVERY_CANONICAL_ID = "1ExampleDriveId00000000000000000000000000013"
const RPS_CANONICAL_ID = "1ExampleDriveId00000000000000000000000000008"
const FINAL_OFFER_CANONICAL_ID = "1ExampleDriveId00000000000000000000000000003"
const STRUCTURE_FINGERPRINT = `sha256:${"a".repeat(64)}`
const CLEAR_SWITCH: KillSwitchState = {
  scope: "global",
  scopeId: STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID,
  enabled: false,
  reason: "copy lifecycle test authorized",
  updatedAt: "2026-07-14T15:59:00.000Z",
  updatedBy: "test",
}

describe("recurring copied-sheet lifecycle runner", () => {
  beforeEach(() => {
    vi.mocked(normalizeStagingSheetStructure).mockReset()
    vi.mocked(readStagingDriveMetadata).mockReset()
    vi.mocked(readStagingSpreadsheet).mockReset()
    vi.mocked(readStagingStructuralNormalizationSnapshot).mockReset()
    vi.mocked(readStagingValueRanges).mockReset()
    installPipelineBeforeState()
  })

  test("dry-runs a next pipeline tab from the exact predecessor without mutation", async () => {
    const loadKillSwitchStates = vi.fn<() => Promise<readonly KillSwitchState[]>>()
    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "pipeline_907",
      clients: {} as GoogleWorkspaceStagingClients,
      nowMs: NOW,
      mode: "dry_run",
      loadKillSwitchStates,
      pipelineJobWeekRows: pipelineDesiredRows("pipeline_907", "2026-07-10"),
    })

    expect(result).toMatchObject({
      mode: "dry_run",
      reportingWeekFriday: "2026-07-10",
      copyOnly: false,
      canonicalWriteAuthorized: true,
      outcome: {
        artifactKey: "pipeline_907",
        status: "dry_run",
        plan: {
          normalizationId: "pipeline_907_candidate_rollover_20260710",
          status: "planned",
          forwardRequestCount: 4,
          rollbackRequestCount: 2,
          driveVersion: "41",
          copyOnly: false,
          canonicalWriteAuthorized: true,
        },
      },
    })
    expect(loadKillSwitchStates).not.toHaveBeenCalled()
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test.each([
    "pipeline_890",
    "pipeline_907",
    "pipeline_1026_1027",
    "pipeline_1118_1119",
  ] as const)("binds recurring %s summary prep to observed history across a year boundary", (artifactKey) => {
    const contract = getStagingSheetContract(`${artifactKey}_job_week`)
    const physicalWidth = artifactKey === "pipeline_1026_1027" ? 33 : contract.headers.length
    const matrix = pipelineJobMatrix(artifactKey, "2026-12-18", true)
    const jobSummary = pipelineJobSummaryLifecycleSheet({
      artifactKey,
      reportingWeekFriday: "2026-12-25",
      sheet: {
        sheetId: contract.sheetId,
        sheetTitle: contract.sheetTitle,
        sheetIndex: 0,
        gridRowCount: 2_000,
        gridColumnCount: physicalWidth,
        basicFilter: {
          sheetId: contract.sheetId,
          startRowIndex: pipelineJobFilterStart(artifactKey),
          startColumnIndex: 0,
          endColumnIndex: physicalWidth,
        },
      },
      values: matrix,
      desiredRows: pipelineDesiredRows(artifactKey, "2026-12-25"),
    })
    const expectedAppendStart = matrix.length
    expect(jobSummary).toMatchObject({
      templateStartRowIndex: 2,
      appendStartRowIndex: expectedAppendStart,
      blockRowCount: pipelineRenderContracts[artifactKey].requisitionIds.length,
    })

    const spec = requirePipelineRolloverSpec(pipelineCandidateRolloverNormalizationSpec({
      artifactKey,
      reportingWeekFriday: "2026-12-25",
      sheets: [{
        sheetId: 123,
        sheetTitle: "Candidate Level Data - 25 December",
        sheetIndex: 1,
        gridRowCount: 1_000,
        gridColumnCount: artifactKey === "pipeline_890" ? 17 : 14,
        basicFilter: {
          sheetId: 123,
          startRowIndex: 0,
          startColumnIndex: 0,
          endColumnIndex: artifactKey === "pipeline_890" ? 17 : 14,
        },
      }],
      jobSummary,
    }))
    expect(spec.expectedAfter).toMatchObject({
      pipelineCandidateRollover: {
        targetSheet: { sheetTitle: "Candidate Level Data - 1 January" },
        jobSummary: {
          appendedTemplate: {
            source: { startRowIndex: 2 },
            destination: { startRowIndex: expectedAppendStart },
            valuesOwnedByBoundedWriter: true,
          },
        },
      },
    })
    expect(spec.forwardRequests.at(-1)).toMatchObject({
      copyPaste: {
        source: { startRowIndex: 2 },
        destination: { startRowIndex: expectedAppendStart },
        pasteType: "PASTE_FORMAT",
      },
    })
    expect(planStagingStructuralNormalization(spec, spec.expectedAfter)).toMatchObject({
      status: "already_normalized",
      requests: [],
    })
  })

  test.each([
    "pipeline_890",
    "pipeline_907",
    "pipeline_1026_1027",
    "pipeline_1118_1119",
  ] as const)("treats %s's existing filtered target with no summary work as finished", (artifactKey) => {
    // The production shape for every pipeline: the weekly tab exists,
    // its filter already matches the predecessor-derived one, and job-summary
    // metadata drifted (swallowed). The builder must return null -- the same
    // "nothing to do" exit the unfiltered pipelines always took -- rather than
    // a spec whose two states are byte-identical and can only project as
    // "ambiguously matches both structural states".
    const width = artifactKey === "pipeline_890" ? 17 : 14
    const predecessor = {
      sheetId: 123,
      sheetTitle: "Candidate Level Data - 25 December",
      sheetIndex: 2,
      gridRowCount: 1_000,
      gridColumnCount: width,
      basicFilter: {
        sheetId: 123,
        startRowIndex: 0,
        startColumnIndex: 0,
        endColumnIndex: width,
      },
    }
    const targetSheetId = pipelineCandidateTargetSheetId("2026-12-25")
    expect(pipelineCandidateRolloverNormalizationSpec({
      artifactKey,
      reportingWeekFriday: "2026-12-25",
      sheets: [
        {
          ...predecessor,
          sheetId: targetSheetId,
          sheetTitle: "Candidate Level Data - 1 January",
          sheetIndex: 1,
          basicFilter: { ...predecessor.basicFilter, sheetId: targetSheetId },
        },
        predecessor,
      ],
    })).toBeNull()
  })

  test("fails closed when the observed current pipeline summary block is ambiguous", () => {
    const contract = getStagingSheetContract("pipeline_907_job_week")
    const values = pipelineJobMatrix("pipeline_907", "2026-07-10")
    values.push([...values[2]])
    expect(() => pipelineJobSummaryLifecycleSheet({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-07-10",
      sheet: {
        sheetId: contract.sheetId,
        sheetTitle: contract.sheetTitle,
        sheetIndex: 0,
        gridRowCount: 998,
        gridColumnCount: contract.headers.length,
        basicFilter: {
          sheetId: contract.sheetId,
          startRowIndex: pipelineJobFilterStart("pipeline_907"),
          startColumnIndex: 0,
          endColumnIndex: contract.headers.length,
        },
      },
      values,
      desiredRows: pipelineDesiredRows("pipeline_907", "2026-07-10"),
    })).toThrow("current reporting block is partial or ambiguous")
  })

  test("rejects a pipeline target discovered across changing Drive versions", async () => {
    vi.mocked(readStagingDriveMetadata).mockReset()
    vi.mocked(readStagingDriveMetadata)
      .mockResolvedValueOnce(editableMetadata(PIPELINE_CANONICAL_ID, "41"))
      .mockResolvedValueOnce(editableMetadata(PIPELINE_CANONICAL_ID, "42"))

    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "pipeline_907",
      clients: {} as GoogleWorkspaceStagingClients,
      nowMs: NOW,
      pipelineJobWeekRows: pipelineDesiredRows("pipeline_907", "2026-07-10"),
    })

    expect(result.outcome).toMatchObject({
      status: "blocked",
      reason: "Recurring sheet lifecycle failed.",
    })
    expect(readStagingStructuralNormalizationSnapshot).not.toHaveBeenCalled()
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("preserves a differing manual current-week block and prepares the next append", () => {
    const contract = getStagingSheetContract("pipeline_907_job_week")
    const desiredRows = pipelineDesiredRows("pipeline_907", "2026-07-10")
    const values = pipelineJobMatrix("pipeline_907", "2026-07-03")
    values.push([...desiredRows[0]])
    values.at(-1)![5] = 99
    values.push([null, "manual note"])

    expect(pipelineJobSummaryLifecycleSheet({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-07-10",
      sheet: {
        sheetId: contract.sheetId,
        sheetTitle: contract.sheetTitle,
        sheetIndex: 0,
        gridRowCount: 998,
        gridColumnCount: contract.headers.length,
        basicFilter: {
          sheetId: contract.sheetId,
          startRowIndex: pipelineJobFilterStart("pipeline_907"),
          startColumnIndex: 0,
          endColumnIndex: contract.headers.length,
        },
      },
      values,
      desiredRows,
    })).toMatchObject({
      templateStartRowIndex: 3,
      appendStartRowIndex: 5,
      blockRowCount: 1,
    })

    const identicalValues = pipelineJobMatrix("pipeline_907", "2026-07-03")
    identicalValues.push([...desiredRows[0]])
    expect(pipelineJobSummaryLifecycleSheet({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-07-10",
      sheet: {
        sheetId: contract.sheetId,
        sheetTitle: contract.sheetTitle,
        sheetIndex: 0,
        gridRowCount: 998,
        gridColumnCount: contract.headers.length,
        basicFilter: {
          sheetId: contract.sheetId,
          startRowIndex: pipelineJobFilterStart("pipeline_907"),
          startColumnIndex: 0,
          endColumnIndex: contract.headers.length,
        },
      },
      values: identicalValues,
      desiredRows,
    })).toMatchObject({
      templateStartRowIndex: 2,
      appendStartRowIndex: 3,
      blockRowCount: 1,
    })
  })

  test("writes a pipeline rollover only with a fresh exact copy permit", async () => {
    vi.mocked(normalizeStagingSheetStructure).mockResolvedValue({
      artifactKey: "pipeline_907",
      runId: "pipeline_907_lifecycle_20260710_20260714160000000",
      normalizationId: "pipeline_907_candidate_rollover_20260710",
      status: "normalized",
      forwardRequestCount: 4,
      rollbackRequestCount: 2,
      mutationCallCount: 1,
      rollbackAttempted: false,
      beforeDriveVersion: "41",
      afterDriveVersion: "42",
      beforeStructureFingerprint: STRUCTURE_FINGERPRINT,
      afterStructureFingerprint: `sha256:${"b".repeat(64)}`,
      beforeStateFingerprint: `sha256:${"c".repeat(64)}`,
      afterStateFingerprint: `sha256:${"d".repeat(64)}`,
      forwardRequestsFingerprint: `sha256:${"e".repeat(64)}`,
      rollbackRequestsFingerprint: `sha256:${"f".repeat(64)}`,
      nonApprovedStructureUnchanged: true,
    })

    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "pipeline_907",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      nowMs: NOW,
      mode: "write",
      sourceGeneratedAt: "2026-07-14T15:30:00.000Z",
      currentTimeMs: () => NOW,
      loadKillSwitchStates: async () => [CLEAR_SWITCH],
      pipelineJobWeekRows: pipelineDesiredRows("pipeline_907", "2026-07-10"),
    })

    expect(result.outcome).toMatchObject({ status: "normalized", write: { mutationCallCount: 1 } })
    const call = vi.mocked(normalizeStagingSheetStructure).mock.calls[0][0]
    expect(call).toMatchObject({
      spec: {
        artifactKey: "pipeline_907",
        spreadsheetId: PIPELINE_CANONICAL_ID,
        id: "pipeline_907_candidate_rollover_20260710",
      },
      permit: {
        artifactKey: "pipeline_907",
        artifactId: PIPELINE_CANONICAL_ID,
        expectedStatus: "planned",
        observedStructureFingerprint: STRUCTURE_FINGERPRINT,
        expectedDriveVersion: "41",
        sourceGeneratedAt: "2026-07-14T15:30:00.000Z",
        killSwitchStoreReachable: true,
        killSwitchClear: true,
        canonicalOnly: true,
      },
    })
    expect(Date.parse(call.permit.expiresAt) - Date.parse(call.permit.issuedAt)).toBe(10 * 60_000)
  })

  test("blocks a stale persisted source before a recurring structural mutation", async () => {
    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "pipeline_907",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      nowMs: NOW,
      mode: "write",
      sourceGeneratedAt: "2026-07-14T13:59:59.999Z",
      currentTimeMs: () => NOW,
      loadKillSwitchStates: async () => [CLEAR_SWITCH],
      pipelineJobWeekRows: pipelineDesiredRows("pipeline_907", "2026-07-10"),
    })

    expect(result.outcome).toMatchObject({
      status: "blocked",
      reason: "Recurring sheet lifecycle failed.",
    })
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("plans exact copied RPS row headroom and an open pivot before value hydration", async () => {
    installRpsDiscovery(4_251)

    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "rps_tracking",
      clients: {} as GoogleWorkspaceStagingClients,
      nowMs: NOW,
      mode: "dry_run",
      requiredDataRows: 3_448,
    })

    expect(result.outcome).toMatchObject({
      artifactKey: "rps_tracking",
      status: "dry_run",
      plan: {
        normalizationId: "rps_tracking_capacity_3448_4448",
        status: "planned",
        forwardRequestCount: 2,
        rollbackRequestCount: 2,
        driveVersion: "24",
      },
    })
    expect(readStagingStructuralNormalizationSnapshot).toHaveBeenCalledOnce()
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("recognizes sufficient copied RPS row headroom and open pivot as a no-op", async () => {
    installRpsDiscovery(5_001)

    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "rps_tracking",
      clients: {} as GoogleWorkspaceStagingClients,
      nowMs: NOW,
      mode: "write",
      requiredDataRows: 3_448,
    })

    expect(result.outcome).toMatchObject({
      artifactKey: "rps_tracking",
      status: "already_normalized",
      plan: {
        normalizationId: "rps_tracking_lifecycle_20260710",
        status: "already_normalized",
        forwardRequestCount: 0,
        rollbackRequestCount: 0,
        driveVersion: "24",
      },
    })
    expect(readStagingStructuralNormalizationSnapshot).not.toHaveBeenCalled()
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("recognizes an existing pipeline target through the guarded zero-mutation writer", async () => {
    vi.mocked(projectStagingStructuralNormalizationState).mockImplementationOnce(
      (_snapshot, spec) => spec.expectedAfter
    )
    vi.mocked(normalizeStagingSheetStructure).mockResolvedValue({
      artifactKey: "pipeline_907",
      runId: "pipeline_907_lifecycle_20260710_20260714160000000",
      normalizationId: "pipeline_907_candidate_rollover_20260710",
      status: "already_normalized",
      forwardRequestCount: 0,
      rollbackRequestCount: 0,
      mutationCallCount: 0,
      rollbackAttempted: false,
      beforeDriveVersion: "41",
      afterDriveVersion: "41",
      beforeStructureFingerprint: STRUCTURE_FINGERPRINT,
      afterStructureFingerprint: STRUCTURE_FINGERPRINT,
      beforeStateFingerprint: `sha256:${"c".repeat(64)}`,
      afterStateFingerprint: `sha256:${"d".repeat(64)}`,
      forwardRequestsFingerprint: `sha256:${"e".repeat(64)}`,
      rollbackRequestsFingerprint: `sha256:${"f".repeat(64)}`,
      nonApprovedStructureUnchanged: true,
    })

    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "pipeline_907",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      nowMs: NOW,
      mode: "write",
      loadKillSwitchStates: async () => [CLEAR_SWITCH],
      pipelineJobWeekRows: pipelineDesiredRows("pipeline_907", "2026-07-10"),
    })

    expect(result.outcome).toMatchObject({
      status: "already_normalized",
      plan: { status: "already_normalized" },
      write: { mutationCallCount: 0, forwardRequestCount: 0 },
    })
    expect(vi.mocked(normalizeStagingSheetStructure).mock.calls[0][0].permit.expectedStatus)
      .toBe("already_normalized")
  })

  test("recognizes complete Weekly Progress columns as a zero-mutation no-op", async () => {
    vi.mocked(readStagingSpreadsheet).mockResolvedValue(weeklyProgressDiscovery())
    vi.mocked(readStagingDriveMetadata).mockResolvedValue(editableMetadata(WEEKLY_PROGRESS_CANONICAL_ID, "26"))
    const loadKillSwitchStates = vi.fn<() => Promise<readonly KillSwitchState[]>>()

    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "weekly_progress",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      weeklyProgressQuarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
      nowMs: NOW,
      mode: "write",
      loadKillSwitchStates,
    })

    expect(result.outcome).toMatchObject({
      artifactKey: "weekly_progress",
      status: "already_normalized",
      plan: {
        normalizationId: "weekly_progress_rollover_20260710",
        status: "already_normalized",
        forwardRequestCount: 0,
        rollbackRequestCount: 0,
        driveVersion: "26",
      },
    })
    expect(loadKillSwitchStates).not.toHaveBeenCalled()
    expect(readStagingStructuralNormalizationSnapshot).not.toHaveBeenCalled()
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("dry-runs only QTD formula corrections when the current week crosses quarter end", async () => {
    vi.mocked(readStagingSpreadsheet).mockResolvedValue(weeklyProgressDiscovery({
      weekHeaders: weeklyProgressQ3ClosingHeaders(),
      qtdFormula: (_sheetId, row) => `=SUM(B${row + 2}:N${row + 2})`,
    }))
    vi.mocked(readStagingDriveMetadata).mockResolvedValue(
      editableMetadata(WEEKLY_PROGRESS_CANONICAL_ID, "27")
    )

    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "weekly_progress",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-09-25",
      weeklyProgressQuarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
      weeklyProgressQuarterClosingOffsets: [
        { sheetId: 0, rowOffsets: [1, 0, 0, 0, 0, 0, 0] },
        { sheetId: 242118538, rowOffsets: [0, 0, 0, 0, 0, 3] },
        { sheetId: 1450892249, rowOffsets: [0, 0, 0, 0, 0, 0, 1] },
      ],
      nowMs: Date.parse("2026-09-29T16:00:00.000Z"),
    })

    expect(result.outcome).toMatchObject({
      artifactKey: "weekly_progress",
      status: "dry_run",
      plan: {
        normalizationId: "weekly_progress_rollover_20260925",
        status: "planned",
        forwardRequestCount: 3,
        rollbackRequestCount: 3,
        driveVersion: "27",
      },
    })
    expect(readStagingStructuralNormalizationSnapshot).toHaveBeenCalledOnce()
  })

  test("validates the existing Final Offer Q3 triplets as a zero-mutation no-op", async () => {
    installFinalOfferDiscovery(finalOfferQ3Sheets())
    const loadKillSwitchStates = vi.fn<() => Promise<readonly KillSwitchState[]>>()

    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "final_offer",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      quarterStart: "2026-07-01",
      nowMs: NOW,
      mode: "write",
      loadKillSwitchStates,
    })

    expect(result.outcome).toMatchObject({
      artifactKey: "final_offer",
      status: "already_normalized",
      plan: {
        normalizationId: "final_offer_quarter_rollover_20260701",
        status: "already_normalized",
        forwardRequestCount: 0,
        rollbackRequestCount: 0,
        driveVersion: "41",
      },
    })
    expect(loadKillSwitchStates).not.toHaveBeenCalled()
    expect(readStagingStructuralNormalizationSnapshot).not.toHaveBeenCalled()
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("dry-runs all nine year-qualified Final Offer Q4 sheets before value hydration", async () => {
    installFinalOfferDiscovery(finalOfferQ3Sheets())
    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "final_offer",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-10-02",
      quarterStart: "2026-10-01",
      nowMs: Date.parse("2026-10-05T16:00:00.000Z"),
    })

    expect(result.outcome).toMatchObject({
      artifactKey: "final_offer",
      status: "dry_run",
      plan: {
        normalizationId: "final_offer_quarter_rollover_20261001",
        status: "planned",
        forwardRequestCount: 21,
        rollbackRequestCount: 9,
        driveVersion: "41",
      },
    })
    expect(readStagingStructuralNormalizationSnapshot).toHaveBeenCalledOnce()
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("plans one Weekly Progress insert when one copied tab lacks the period", async () => {
    const discovery = weeklyProgressDiscovery()
    const codeSheet = discovery.sheets[0]
    codeSheet.properties.gridProperties.columnCount = 3
    codeSheet.data[0].rowData.forEach((row) => row.values.splice(2, 1))
    vi.mocked(readStagingSpreadsheet).mockResolvedValue(discovery)
    vi.mocked(readStagingDriveMetadata).mockResolvedValue(editableMetadata(WEEKLY_PROGRESS_CANONICAL_ID, "26"))

    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "weekly_progress",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      weeklyProgressQuarterOpeningOffsets: weeklyProgressQuarterOpeningOffsets(),
      nowMs: NOW,
    })

    expect(result.outcome).toMatchObject({
      status: "dry_run",
      plan: {
        normalizationId: "weekly_progress_rollover_20260710",
        status: "planned",
        forwardRequestCount: 3,
        rollbackRequestCount: 2,
      },
    })
    expect(readStagingStructuralNormalizationSnapshot).toHaveBeenCalledTimes(1)
  })

  test("dry-runs the current copied Delivery fixed-filter prerequisite and dated destination together", async () => {
    installDeliveryBeforeState()
    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "delivery_roles_rps",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      deliveryRpsReportDate: "2026-07-16",
      nowMs: NOW,
    })

    expect(result.outcome).toMatchObject({
      artifactKey: "delivery_roles_rps",
      status: "dry_run",
      plan: {
        normalizationId: "delivery_rps_dated_rollover_20260716",
        status: "planned",
        forwardRequestCount: 5,
        rollbackRequestCount: 2,
        driveVersion: "20",
        projectedDryRun: {
          target: {
            targetSheetId: 1980009693,
            targetSheetTitle: "16 Jul 2026",
            templateSheetId: 2061940582,
            templateSheetTitle: "09 Jul 2026",
            firstValueRow: 3,
            preservedValueRowCount: 2,
          },
          structure: {
            kind: "projected_post_normalization",
            normalizationId: "delivery_rps_dated_rollover_20260716",
            normalizationFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            observedDriveVersion: "20",
            observedStructureFingerprint: STRUCTURE_FINGERPRINT,
            expectedAfterStateFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            forwardRequestsFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            rollbackRequestsFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          },
        },
      },
    })
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("composes the real Delivery lifecycle projection into the real zero-mutation value planner", async () => {
    process.env.RECOPS_PII_FINGERPRINT_SALT = "delivery-composition-test-key"
    installDeliveryBeforeState()
    const clients = {} as GoogleWorkspaceStagingClients
    const lifecycle = await runStagingRecurringSheetLifecycle({
      artifactKey: "delivery_roles_rps",
      clients,
      reportingWeekFriday: "2026-07-10",
      deliveryRpsReportDate: "2026-07-16",
      nowMs: NOW,
    })
    const projectedDryRun = lifecycle.outcome.plan?.projectedDryRun
    expect(projectedDryRun).toBeDefined()

    vi.mocked(readStagingDriveMetadata).mockReset()
    vi.mocked(readStagingDriveMetadata).mockResolvedValue(
      editableMetadata(DELIVERY_CANONICAL_ID, "20")
    )
    vi.mocked(readStagingValueRanges).mockReset()
    vi.mocked(readStagingValueRanges).mockResolvedValue([
      { range: "'Raw_Daily_RPS'!A1:T1", values: [[...getStagingSheetContract("delivery_rps_raw").headers]] },
      { range: "'Raw_Daily_RPS'!A2:T", values: [] },
      { range: "'Cleaned_RPS'!A1:T1", values: [[...getStagingSheetContract("delivery_rps_clean").headers]] },
      { range: "'Cleaned_RPS'!A2:T", values: [] },
      {
        range: "'09 Jul 2026'!A3:N",
        values: [["Summary by Team"], [...getStagingSheetContract("delivery_rps_dated").headers]],
      },
    ])
    vi.mocked(readStagingSpreadsheet).mockReset()
    vi.mocked(readStagingSpreadsheet)
      .mockResolvedValueOnce({
        spreadsheetId: DELIVERY_CANONICAL_ID,
        properties: { locale: "en_US", timeZone: "Asia/Calcutta" },
      })
      .mockResolvedValueOnce({
        spreadsheetId: DELIVERY_CANONICAL_ID,
        sheets: [
          { properties: { sheetId: 1072762955, title: "Raw_Daily_RPS" } },
          { properties: { sheetId: 1598905318, title: "Cleaned_RPS" } },
          { properties: {
            sheetId: projectedDryRun!.target.templateSheetId,
            title: projectedDryRun!.target.templateSheetTitle,
          } },
        ],
      })

    const projected = await planProjectedDeliveryRpsValues({
      runId: "delivery_lifecycle_planner_composition_test",
      facts: {
        generatedAt: "2026-07-16T06:29:00.000Z",
        reportingWeekFriday: "2026-07-10",
        quarterStart: "2026-07-01",
        candidateEvents: [],
        offers: [],
        scorecards: [],
        reqWeeks: [],
        diagnostics: [],
      },
      roster: [],
      clients,
      deliveryRpsReportDate: "2026-07-16",
      target: projectedDryRun!.target,
      structure: projectedDryRun!.structure,
    })

    expect(projected.plan.planFingerprint).toMatch(/^hmac-sha256:[a-f0-9]{64}$/)
    expect(projected.plan).not.toHaveProperty("structureHash")
    expect(projected.publicSummary).toMatchObject({
      artifactKey: "delivery_roles_rps",
      rangeCount: 3,
      projectedChangedRangeCount: 1,
      projectedValueNoOp: false,
    })
    expect(readStagingDriveMetadata).toHaveBeenCalledTimes(2)
    delete process.env.RECOPS_PII_FINGERPRINT_SALT
  })

  test("keeps Thursday's Delivery report in its Pacific business week after UTC rolls to Friday", async () => {
    installDeliveryBeforeState()
    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "delivery_roles_rps",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      deliveryRpsReportDate: "2026-07-16",
      nowMs: Date.parse("2026-07-17T00:10:00.000Z"),
    })

    expect(result).toMatchObject({
      reportingWeekFriday: "2026-07-10",
      outcome: {
        status: "dry_run",
        plan: { normalizationId: "delivery_rps_dated_rollover_20260716" },
      },
    })
    expect(readStagingSpreadsheet).toHaveBeenCalled()
  })

  test("treats an already hydrated Delivery destination as a guarded retry/no-op", async () => {
    installDeliveryBeforeState({ targetTitle: "16 Jul 2026", rawFilterOpen: true })
    vi.mocked(projectStagingStructuralNormalizationState).mockImplementationOnce(
      (_snapshot, spec) => spec.expectedAfter
    )
    vi.mocked(normalizeStagingSheetStructure).mockResolvedValue({
      artifactKey: "delivery_roles_rps",
      runId: "delivery_roles_rps_lifecycle_20260716_20260714160000000",
      normalizationId: "delivery_rps_dated_rollover_20260716",
      status: "already_normalized",
      forwardRequestCount: 0,
      rollbackRequestCount: 0,
      mutationCallCount: 0,
      rollbackAttempted: false,
      beforeDriveVersion: "20",
      afterDriveVersion: "20",
      beforeStructureFingerprint: STRUCTURE_FINGERPRINT,
      afterStructureFingerprint: STRUCTURE_FINGERPRINT,
      beforeStateFingerprint: `sha256:${"c".repeat(64)}`,
      afterStateFingerprint: `sha256:${"d".repeat(64)}`,
      forwardRequestsFingerprint: `sha256:${"e".repeat(64)}`,
      rollbackRequestsFingerprint: `sha256:${"f".repeat(64)}`,
      nonApprovedStructureUnchanged: true,
    })

    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "delivery_roles_rps",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      deliveryRpsReportDate: "2026-07-16",
      nowMs: NOW,
      mode: "write",
      loadKillSwitchStates: async () => [CLEAR_SWITCH],
    })

    expect(result.outcome).toMatchObject({
      status: "already_normalized",
      plan: { status: "already_normalized" },
      write: { mutationCallCount: 0, beforeDriveVersion: "20", afterDriveVersion: "20" },
    })
    expect(vi.mocked(normalizeStagingSheetStructure).mock.calls[0][0]).toMatchObject({
      spec: { artifactKey: "delivery_roles_rps", spreadsheetId: DELIVERY_CANONICAL_ID },
      permit: { expectedStatus: "already_normalized", expectedDriveVersion: "20" },
    })
  })

  test("retains combined Delivery rollback certification after a failed post-readback", async () => {
    installDeliveryBeforeState()
    vi.mocked(normalizeStagingSheetStructure).mockImplementationOnce(async (call) => {
      throw new StagingStructuralNormalizationExecutionError({
        spec: call.spec,
        permit: call.permit,
        failureStage: "post_verification",
        mutationCallCount: 2,
        rollbackAttempted: true,
        rollbackVerified: true,
        safePreimageVerified: true,
        beforeStructureFingerprint: STRUCTURE_FINGERPRINT,
        beforeDriveVersion: "20",
        afterDriveVersion: "22",
      })
    })

    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "delivery_roles_rps",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      deliveryRpsReportDate: "2026-07-16",
      nowMs: NOW,
      mode: "write",
      sourceGeneratedAt: "2026-07-14T15:30:00.000Z",
      currentTimeMs: () => NOW,
      loadKillSwitchStates: async () => [CLEAR_SWITCH],
    })

    expect(result.outcome).toMatchObject({
      status: "blocked",
      reason: "Staging structural normalization failed.",
      failure: {
        artifactKey: "delivery_roles_rps",
        failureStage: "post_verification",
        mutationCallCount: 2,
        rollbackAttempted: true,
        rollbackVerified: true,
        safePreimageVerified: true,
        certificationStatus: "rollback_verified",
      },
    })
    const { spec } = vi.mocked(normalizeStagingSheetStructure).mock.calls[0][0]
    expect(spec.forwardRequests[0]).toHaveProperty("setBasicFilter")
    expect(spec.rollbackRequests).toEqual([
      { deleteSheet: { sheetId: 1980009693 } },
      expect.objectContaining({ setBasicFilter: expect.any(Object) }),
    ])
  })

  test("plans the Delivery year boundary and blocks ambiguous retained ownership", async () => {
    const yearNow = Date.parse("2027-01-04T16:00:00.000Z")
    installDeliveryBeforeState({ predecessorTitle: "31 Dec 2026" })
    const boundary = await runStagingRecurringSheetLifecycle({
      artifactKey: "delivery_roles_rps",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2027-01-01",
      deliveryRpsReportDate: "2027-01-07",
      nowMs: yearNow,
    })
    expect(boundary.outcome).toMatchObject({
      status: "dry_run",
      plan: { normalizationId: "delivery_rps_dated_rollover_20270107", status: "planned" },
    })

    installDeliveryBeforeState({ duplicatePredecessor: true })
    const ambiguous = await runStagingRecurringSheetLifecycle({
      artifactKey: "delivery_roles_rps",
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      deliveryRpsReportDate: "2026-07-16",
      nowMs: NOW,
    })
    expect(ambiguous.outcome).toMatchObject({
      status: "blocked",
      reason: "Recurring sheet lifecycle failed.",
    })
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("rejects an unavailable period before any Google call", async () => {
    await expect(
      runStagingRecurringSheetLifecycle({
        artifactKey: "weekly_progress",
        clients: {} as GoogleWorkspaceStagingClients,
        reportingWeekFriday: "2026-07-17",
        nowMs: NOW,
      })
    ).rejects.toThrow("expected 2026-07-10")
    expect(readStagingSpreadsheet).not.toHaveBeenCalled()
  })

  test("does not expose a private discovery error in its returned outcome", async () => {
    const privateMarker = "candidate_private_marker_Jane_Doe"
    vi.mocked(readStagingSpreadsheet).mockRejectedValueOnce(
      new Error(`Discovery failed for ${privateMarker}`)
    )

    const result = await runStagingRecurringSheetLifecycle({
      artifactKey: "pipeline_907",
      clients: {} as GoogleWorkspaceStagingClients,
      nowMs: NOW,
    })

    expect(result.outcome.reason).toBe("Recurring sheet lifecycle failed.")
    expect(JSON.stringify(result)).not.toContain(privateMarker)
  })
})

function installPipelineBeforeState(): void {
  const contract = getStagingSheetContract("pipeline_907_job_week")
  vi.mocked(readStagingSpreadsheet).mockResolvedValue({
    spreadsheetId: PIPELINE_CANONICAL_ID,
    sheets: [
      {
        properties: {
          sheetId: 156193952,
          title: "Candidate Level Data - 10 July",
          index: 1,
          gridProperties: { rowCount: 998, columnCount: 14 },
        },
        basicFilter: {
          range: {
            sheetId: 156193952,
            startRowIndex: 0,
            startColumnIndex: 0,
            endColumnIndex: 14,
          },
        },
      },
      {
        properties: {
          sheetId: contract.sheetId,
          title: contract.sheetTitle,
          index: 0,
          gridProperties: { rowCount: 998, columnCount: contract.headers.length },
        },
        basicFilter: {
          range: {
            sheetId: contract.sheetId,
            startRowIndex: 622,
            startColumnIndex: 0,
            endColumnIndex: contract.headers.length,
          },
        },
      },
    ],
  })
  vi.mocked(readStagingValueRanges).mockResolvedValue([{
    range: `'${contract.sheetTitle}'!A:AC`,
    values: pipelineJobMatrix("pipeline_907", "2026-07-03", true),
  }])
  vi.mocked(readStagingDriveMetadata).mockResolvedValue(editableMetadata(PIPELINE_CANONICAL_ID, "41"))
  vi.mocked(readStagingStructuralNormalizationSnapshot).mockImplementation(async (spec) => ({
    spreadsheet: spec.expectedBefore,
    structure: {
      spreadsheetId: spec.spreadsheetId,
      properties: { count: 0, fingerprint: STRUCTURE_FINGERPRINT },
      namedRanges: { count: 0, fingerprint: STRUCTURE_FINGERPRINT },
      sheets: [],
      structureHash: STRUCTURE_FINGERPRINT,
    },
    literalRanges: [],
    literalCellUpperBound: 0,
  }))
}

function pipelineJobMatrix(
  artifactKey: PipelineArtifactKey,
  reportingWeekFriday: string,
  trailingManualRow = false
): Array<Array<string | number | null>> {
  const contract = getStagingSheetContract(`${artifactKey}_job_week`)
  const requisitionIds = pipelineRenderContracts[artifactKey].requisitionIds
  const values: Array<Array<string | number | null>> = [
    [...contract.groupedHeader!.headers],
    [...contract.headers],
    ...requisitionIds.map((requisitionId) => [
      pipelineLegacyWeekOrder(artifactKey, reportingWeekFriday),
      fridayWeekLabels(reportingWeekFriday).weekShort,
      requisitionId,
      null,
      null,
      ...Array(contract.headers.length - 5).fill(0),
    ]),
  ]
  if (trailingManualRow) values.push([null, "manual note"])
  return values
}

function pipelineDesiredRows(
  artifactKey: PipelineArtifactKey,
  reportingWeekFriday: string
): Array<Array<string | number | null>> {
  const height = pipelineRenderContracts[artifactKey].requisitionIds.length
  return pipelineJobMatrix(artifactKey, reportingWeekFriday).slice(2, 2 + height)
}

function pipelineJobFilterStart(artifactKey: PipelineArtifactKey): number {
  return {
    pipeline_890: 714,
    pipeline_907: 622,
    pipeline_1026_1027: 1166,
    pipeline_1118_1119: 1034,
  }[artifactKey]
}

function finalOfferQ3Sheets(baseIndex = 5): FinalOfferLifecycleSheet[] {
  return [
    ...finalOfferMonthSheets("2026-09-01", baseIndex),
    ...finalOfferMonthSheets("2026-08-01", baseIndex + 3),
    ...finalOfferMonthSheets("2026-07-01", baseIndex + 6),
  ]
}

function finalOfferMonthSheets(monthKey: string, sheetIndex: number): FinalOfferLifecycleSheet[] {
  const ids = finalOfferMonthSheetIds(monthKey)
  const titles = finalOfferMonthTabTitles(monthKey)
  return [
    {
      sheetId: ids.offerData,
      sheetTitle: titles.offerData,
      sheetIndex,
      gridRowCount: 997,
      gridColumnCount: 31,
      basicFilter: { sheetId: ids.offerData, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 31 },
      pivotSource: null,
    },
    {
      sheetId: ids.recruiterPerformance,
      sheetTitle: titles.recruiterPerformance,
      sheetIndex: sheetIndex + 1,
      gridRowCount: 1000,
      gridColumnCount: 31,
      basicFilter: null,
      pivotSource: { sheetId: ids.offerData, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 31 },
    },
    {
      sheetId: ids.sourcerPerformance,
      sheetTitle: titles.sourcerPerformance,
      sheetIndex: sheetIndex + 2,
      gridRowCount: 1000,
      gridColumnCount: 31,
      basicFilter: null,
      pivotSource: { sheetId: ids.offerData, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 30 },
    },
  ]
}

function installFinalOfferDiscovery(sheets: readonly FinalOfferLifecycleSheet[]): void {
  const metadata = {
    spreadsheetId: FINAL_OFFER_CANONICAL_ID,
    sheets: sheets.map((sheet) => ({
      properties: {
        sheetId: sheet.sheetId,
        title: sheet.sheetTitle,
        index: sheet.sheetIndex,
        gridProperties: { rowCount: sheet.gridRowCount, columnCount: sheet.gridColumnCount },
      },
      ...(sheet.basicFilter ? { basicFilter: { range: sheet.basicFilter } } : {}),
    })),
  }
  const pivots = {
    spreadsheetId: FINAL_OFFER_CANONICAL_ID,
    sheets: sheets.filter((sheet) => sheet.pivotSource).map((sheet) => ({
      properties: { sheetId: sheet.sheetId, title: sheet.sheetTitle },
      data: [{
        startRow: 0,
        startColumn: 0,
        rowData: [{ values: [{ pivotTable: { source: sheet.pivotSource! } }] }],
      }],
    })),
  }
  vi.mocked(readStagingSpreadsheet).mockReset()
  vi.mocked(readStagingSpreadsheet)
    .mockResolvedValueOnce(metadata)
    .mockResolvedValueOnce(pivots)
  vi.mocked(readStagingDriveMetadata).mockResolvedValue(editableMetadata(FINAL_OFFER_CANONICAL_ID, "41"))
}

function installRpsDiscovery(dataRowCount: number): void {
  vi.mocked(readStagingSpreadsheet).mockResolvedValue({
    spreadsheetId: RPS_CANONICAL_ID,
    sheets: [
      {
        properties: {
          sheetId: 1092300150,
          title: "Data Dump",
          gridProperties: { rowCount: dataRowCount, columnCount: 18 },
        },
      },
      {
        properties: {
          sheetId: 855929445,
          title: "RPS Table",
          gridProperties: { rowCount: 998, columnCount: 26 },
        },
        data: [{
          startRow: 0,
          startColumn: 0,
          rowData: [{
            values: [{
              pivotTable: {
                source: {
                  sheetId: 1092300150,
                  startRowIndex: 0,
                  startColumnIndex: 0,
                  endColumnIndex: 18,
                },
              },
            }],
          }],
        }],
      },
    ],
  })
  vi.mocked(readStagingDriveMetadata).mockResolvedValue(editableMetadata(RPS_CANONICAL_ID, "24"))
  vi.mocked(readStagingStructuralNormalizationSnapshot).mockImplementation(async (spec) => ({
    spreadsheet: spec.expectedBefore,
    structure: {
      spreadsheetId: spec.spreadsheetId,
      properties: { count: 0, fingerprint: STRUCTURE_FINGERPRINT },
      namedRanges: { count: 0, fingerprint: STRUCTURE_FINGERPRINT },
      sheets: [],
      structureHash: STRUCTURE_FINGERPRINT,
    },
    literalRanges: [],
    literalCellUpperBound: 0,
  }))
}

function installDeliveryBeforeState(options: {
  predecessorTitle?: string
  targetTitle?: string
  duplicatePredecessor?: boolean
  rawFilterOpen?: boolean
} = {}): void {
  const predecessorTitle = options.predecessorTitle ?? "09 Jul 2026"
  const retainedIndexOffset = options.targetTitle ? 1 : 0
  const target = options.targetTitle
    ? [{
        properties: {
          sheetId: 1980009693,
          title: options.targetTitle,
          index: 0,
          gridProperties: { rowCount: 1000, columnCount: 26 },
        },
      }]
    : []
  vi.mocked(readStagingSpreadsheet).mockResolvedValue({
    spreadsheetId: DELIVERY_CANONICAL_ID,
    sheets: [
      {
        properties: {
          sheetId: 1072762955,
          title: "Raw_Daily_RPS",
          index: retainedIndexOffset,
          gridProperties: { rowCount: 1000, columnCount: 20 },
        },
        basicFilter: {
          range: {
            sheetId: 1072762955,
            startRowIndex: 0,
            ...(options.rawFilterOpen ? {} : { endRowIndex: 176 }),
            startColumnIndex: 0,
            endColumnIndex: 20,
          },
        },
      },
      {
        properties: {
          sheetId: 1598905318,
          title: "Cleaned_RPS",
          index: 1 + retainedIndexOffset,
          gridProperties: { rowCount: 1000, columnCount: 20 },
        },
      },
      {
        properties: {
          sheetId: 2061940581,
          title: "08 Jul 2026",
          index: 2 + retainedIndexOffset,
          gridProperties: { rowCount: 1000, columnCount: 26 },
        },
      },
      {
        properties: {
          sheetId: 2061940582,
          title: predecessorTitle,
          index: 3 + retainedIndexOffset,
          gridProperties: { rowCount: 1000, columnCount: 26 },
        },
      },
      ...(options.duplicatePredecessor
        ? [{
            properties: {
              sheetId: 2061940583,
              title: predecessorTitle,
              index: 4,
              gridProperties: { rowCount: 1000, columnCount: 26 },
            },
          }]
        : target),
    ],
  })
  vi.mocked(readStagingDriveMetadata).mockResolvedValue(editableMetadata(DELIVERY_CANONICAL_ID, "20"))
  vi.mocked(readStagingStructuralNormalizationSnapshot).mockImplementation(async (spec) => ({
    spreadsheet: spec.expectedBefore,
    structure: {
      spreadsheetId: spec.spreadsheetId,
      properties: { count: 0, fingerprint: STRUCTURE_FINGERPRINT },
      namedRanges: { count: 0, fingerprint: STRUCTURE_FINGERPRINT },
      sheets: [],
      structureHash: STRUCTURE_FINGERPRINT,
    },
    literalRanges: [],
    literalCellUpperBound: 0,
  }))
}

function weeklyProgressDiscovery(options: {
  weekHeaders?: readonly string[]
  qtdFormula?: (sheetId: number, row: number) => string
} = {}) {
  const configs = [
    [0, "FDL (Code + RL)", 7],
    [242118538, "FDE/PE", 6],
    [1450892249, "FDL (Brazil + Colombia)", 7],
  ] as const
  const weekHeaders = options.weekHeaders ?? ["03 Jul - 09 Jul", "10 Jul - 16 Jul"]
  return {
    spreadsheetId: WEEKLY_PROGRESS_CANONICAL_ID,
    sheets: configs.map(([sheetId, title, formulaCount]) => ({
      properties: { sheetId, title, gridProperties: { columnCount: weekHeaders.length + 2 } },
      data: [
        {
          startRow: 0,
          startColumn: 0,
          rowData: [
            {
              values: [
                enteredString("Stage"),
                ...weekHeaders.map(enteredString),
                enteredString("QTD"),
              ],
            },
            ...Array.from({ length: formulaCount }, (_, index) => ({
              values: [
                {},
                ...weekHeaders.map(() => ({})),
                {
                  userEnteredValue: {
                    formulaValue: options.qtdFormula?.(sheetId, index) ??
                      (`=SUM(B${index + 2}:C${index + 2})` +
                        (sheetId === 242118538 && index === 5 ? "+2" : "")),
                  },
                },
              ],
            })),
          ],
        },
      ],
    })),
  }
}

function weeklyProgressQ3ClosingHeaders() {
  return [
    "03 Jul - 09 Jul",
    "10 Jul - 16 Jul",
    "17 Jul - 23 Jul",
    "24 Jul - 30 Jul",
    "31 Jul - 06 Aug",
    "07 Aug - 13 Aug",
    "14 Aug - 20 Aug",
    "21 Aug - 27 Aug",
    "28 Aug - 03 Sep",
    "04 Sep - 10 Sep",
    "11 Sep - 17 Sep",
    "18 Sep - 24 Sep",
    "25 Sep - 01 Oct",
  ]
}

function weeklyProgressQuarterOpeningOffsets() {
  return [
    { sheetId: 0, rowOffsets: [0, 0, 0, 0, 0, 0, 0] },
    { sheetId: 242118538, rowOffsets: [0, 0, 0, 0, 0, 2] },
    { sheetId: 1450892249, rowOffsets: [0, 0, 0, 0, 0, 0, 0] },
  ]
}

function enteredString(value: string) {
  return { userEnteredValue: { stringValue: value } }
}

function editableMetadata(id: string, version: string) {
  return {
    id,
    mimeType: "application/vnd.google-apps.spreadsheet",
    trashed: false,
    version,
    capabilities: { canEdit: true, canModifyContent: true },
  }
}
