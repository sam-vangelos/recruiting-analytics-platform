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
  }
})

vi.mock("../lib/recruiting-ops/delivery/staging-structural-normalization-observer", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../lib/recruiting-ops/delivery/staging-structural-normalization-observer")
  >()
  return {
    ...actual,
    projectStagingStructuralNormalizationState: vi.fn(),
  }
})

import type { KillSwitchState } from "../lib/recruiting-ops/autonomy"
import {
  normalizeStagingSheetStructure,
  readStagingDriveMetadata,
  readStagingSpreadsheet,
  readStagingStructuralNormalizationSnapshot,
  StagingStructuralNormalizationExecutionError,
  type GoogleWorkspaceStagingClients,
} from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import { STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID } from "../lib/recruiting-ops/delivery/staging-kill-switch"
import { projectStagingStructuralNormalizationState } from "../lib/recruiting-ops/delivery/staging-structural-normalization-observer"
import {
  createWeeklyRecruitmentRolloverWritePermit,
  runWeeklyRecruitmentStagingRollover,
} from "../lib/recruiting-ops/delivery/weekly-recruitment-rollover-runner"
import {
  planStagingStructuralNormalization,
  weeklyRecruitmentRolloverNormalizationSpec,
} from "../lib/recruiting-ops/delivery/staging-structural-normalization"
import {
  weeklyRecruitmentTargetSheetId,
  weeklyRecruitmentTargetSheetTitle,
} from "../lib/recruiting-ops/delivery/weekly-recruitment-rollover"

const CANONICAL_ID = "1ExampleDriveId00000000000000000000000000016"
const PREDECESSOR_ID = 1994864183
const PREDECESSOR_TITLE = "Weekly Working Report Sheet 02 Jul to 09 Jul 2026"
const NOW = Date.parse("2026-07-14T16:00:00.000Z")
const RUN_ID = "weekly_recruitment_rollover_20260710_20260714160000000"
const STRUCTURE_FINGERPRINT = `sha256:${"a".repeat(64)}`
const CLEAR_SWITCH: KillSwitchState = {
  scope: "global",
  scopeId: STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID,
  enabled: false,
  reason: "copy rollover test authorized",
  updatedAt: "2026-07-14T15:59:00.000Z",
  updatedBy: "test",
}

describe("Weekly Recruitment copy rollover runner", () => {
  beforeEach(() => {
    vi.mocked(normalizeStagingSheetStructure).mockReset()
    vi.mocked(readStagingDriveMetadata).mockReset()
    vi.mocked(readStagingSpreadsheet).mockReset()
    vi.mocked(readStagingStructuralNormalizationSnapshot).mockReset()
    vi.mocked(projectStagingStructuralNormalizationState).mockReset()
    installPreparedBeforeState()
  })

  test("derives the current reporting week when the recurring caller supplies no pinned date", async () => {
    const loadKillSwitchStates = vi.fn<() => Promise<readonly KillSwitchState[]>>()

    const result = await runWeeklyRecruitmentStagingRollover({
      clients: {} as GoogleWorkspaceStagingClients,
      mode: "dry_run",
      nowMs: NOW,
      loadKillSwitchStates,
    })

    expect(result).toMatchObject({
      runId: RUN_ID,
      mode: "dry_run",
      reportingWeekFriday: "2026-07-10",
      copyOnly: false,
      canonicalWriteAuthorized: true,
      outcomes: [
        {
          artifactKey: "weekly_recruitment",
          status: "dry_run",
          plan: {
            status: "planned",
            targetSheetTitle: "Weekly Working Report Sheet 10 Jul to 16 Jul 2026",
            predecessorSheetId: PREDECESSOR_ID,
            driveVersion: "123",
            forwardRequestCount: 1,
            rollbackRequestCount: 1,
            literalRangeCount: 0,
            copyOnly: false,
            canonicalWriteAuthorized: true,
          },
        },
      ],
    })
    expect(loadKillSwitchStates).not.toHaveBeenCalled()
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("writes only after a fresh clear switch and passes a short-lived exact permit", async () => {
    vi.mocked(normalizeStagingSheetStructure).mockResolvedValue({
      artifactKey: "weekly_recruitment",
      runId: RUN_ID,
      normalizationId: "weekly_recruitment_rollover_20260710",
      status: "normalized",
      forwardRequestCount: 1,
      rollbackRequestCount: 1,
      mutationCallCount: 1,
      rollbackAttempted: false,
      beforeDriveVersion: "123",
      afterDriveVersion: "124",
      beforeStructureFingerprint: STRUCTURE_FINGERPRINT,
      afterStructureFingerprint: `sha256:${"b".repeat(64)}`,
      beforeStateFingerprint: `sha256:${"c".repeat(64)}`,
      afterStateFingerprint: `sha256:${"d".repeat(64)}`,
      forwardRequestsFingerprint: `sha256:${"e".repeat(64)}`,
      rollbackRequestsFingerprint: `sha256:${"f".repeat(64)}`,
      nonApprovedStructureUnchanged: true,
    })

    const result = await runWeeklyRecruitmentStagingRollover({
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      mode: "write",
      nowMs: NOW,
      loadKillSwitchStates: async () => [CLEAR_SWITCH],
    })

    expect(result.outcomes[0]).toMatchObject({
      status: "normalized",
      write: { status: "normalized", mutationCallCount: 1 },
    })
    expect(normalizeStagingSheetStructure).toHaveBeenCalledTimes(1)
    const call = vi.mocked(normalizeStagingSheetStructure).mock.calls[0][0]
    expect(call.spec).toMatchObject({
      artifactKey: "weekly_recruitment",
      spreadsheetId: CANONICAL_ID,
      id: "weekly_recruitment_rollover_20260710",
    })
    expect(call.permit).toMatchObject({
      artifactKey: "weekly_recruitment",
      artifactId: CANONICAL_ID,
      normalizationId: "weekly_recruitment_rollover_20260710",
      expectedStatus: "planned",
      observedStructureFingerprint: STRUCTURE_FINGERPRINT,
      expectedDriveVersion: "123",
      runId: RUN_ID,
      killSwitchStoreReachable: true,
      killSwitchClear: true,
      canonicalOnly: true,
    })
    expect(Date.parse(call.permit.expiresAt) - Date.parse(call.permit.issuedAt)).toBe(
      10 * 60_000
    )
  })

  test("recognizes an exact existing hydrated target as a zero-mutation no-op", async () => {
    installExistingTargetDiscovery()

    const result = await runWeeklyRecruitmentStagingRollover({
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      mode: "write",
      nowMs: NOW,
      loadKillSwitchStates: async () => [CLEAR_SWITCH],
    })

    expect(result.outcomes[0]).toMatchObject({
      status: "already_normalized",
      plan: { status: "already_normalized" },
    })
    expect(projectStagingStructuralNormalizationState).not.toHaveBeenCalled()
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("fails closed when the target disappears between discovery and structural observation", async () => {
    installExistingTargetDiscovery()
    installObservedSheets([
      {
        properties: {
          sheetId: PREDECESSOR_ID,
          title: PREDECESSOR_TITLE,
          index: 0,
        },
      },
    ])

    const result = await runWeeklyRecruitmentStagingRollover({
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      mode: "write",
      nowMs: NOW,
      loadKillSwitchStates: async () => [CLEAR_SWITCH],
    })

    expect(result.outcomes[0]).toEqual({
      artifactKey: "weekly_recruitment",
      status: "blocked",
      reason: "Weekly Recruitment rollover failed.",
    })
    expect(projectStagingStructuralNormalizationState).not.toHaveBeenCalled()
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("fails closed on an existing target identity collision", async () => {
    vi.mocked(readStagingSpreadsheet).mockResolvedValue({
      spreadsheetId: CANONICAL_ID,
      sheets: [
        {
          properties: {
            sheetId: weeklyRecruitmentTargetSheetId("2026-07-10"),
            title: "unrelated collision",
            index: 0,
          },
        },
        {
          properties: {
            sheetId: PREDECESSOR_ID,
            title: PREDECESSOR_TITLE,
            index: 1,
          },
        },
      ],
    })

    const result = await runWeeklyRecruitmentStagingRollover({
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      mode: "write",
      nowMs: NOW,
      loadKillSwitchStates: async () => [CLEAR_SWITCH],
    })

    expect(result.outcomes[0]).toEqual({
      artifactKey: "weekly_recruitment",
      status: "blocked",
      reason: "Weekly Recruitment rollover failed.",
    })
    expect(readStagingDriveMetadata).not.toHaveBeenCalled()
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("blocks without mutation when the durable switch is not explicitly clear", async () => {
    const result = await runWeeklyRecruitmentStagingRollover({
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      mode: "write",
      nowMs: NOW,
      loadKillSwitchStates: async () => [],
    })

    expect(result.outcomes[0]).toMatchObject({
      status: "blocked",
      reason: "No explicit durable DISENGAGED staging-hydration switch state is present.",
      plan: { status: "planned" },
    })
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("retains rollback evidence from the sole structural mutation boundary", async () => {
    const spec = specForCurrentWeek()
    const plan = planStagingStructuralNormalization(spec, spec.expectedBefore)
    const permit = createWeeklyRecruitmentRolloverWritePermit({
      spec,
      plan,
      structureFingerprint: STRUCTURE_FINGERPRINT,
      driveVersion: "123",
      runId: RUN_ID,
      issuedAtMs: NOW,
    })
    vi.mocked(normalizeStagingSheetStructure).mockRejectedValue(
      new StagingStructuralNormalizationExecutionError({
        spec,
        permit,
        failureStage: "rollback",
        mutationCallCount: 2,
        rollbackAttempted: true,
        rollbackVerified: false,
        safePreimageVerified: false,
        beforeStructureFingerprint: STRUCTURE_FINGERPRINT,
      })
    )

    const result = await runWeeklyRecruitmentStagingRollover({
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      mode: "write",
      nowMs: NOW,
      loadKillSwitchStates: async () => [CLEAR_SWITCH],
    })

    expect(result.outcomes[0]).toEqual({
      artifactKey: "weekly_recruitment",
      status: "blocked",
      failure: {
        artifactKey: "weekly_recruitment",
        normalizationId: "weekly_recruitment_rollover_20260710",
        runId: RUN_ID,
        failureStage: "rollback",
        mutationCallCount: 2,
        rollbackAttempted: true,
        rollbackVerified: false,
        safePreimageVerified: false,
        beforeStructureFingerprint: STRUCTURE_FINGERPRINT,
        beforeDriveVersion: null,
        afterDriveVersion: null,
        certificationStatus: "rollback_unverified",
      },
      reason: "Staging structural normalization failed.",
    })
  })

  test("rejects an unavailable week before any Google preflight", async () => {
    await expect(
      runWeeklyRecruitmentStagingRollover({
        clients: {} as GoogleWorkspaceStagingClients,
        reportingWeekFriday: "2026-07-17",
        nowMs: NOW,
      })
    ).rejects.toThrow("expected 2026-07-10")

    expect(readStagingSpreadsheet).not.toHaveBeenCalled()
    expect(readStagingDriveMetadata).not.toHaveBeenCalled()
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("fails closed when discovery returns a different spreadsheet id", async () => {
    vi.mocked(readStagingSpreadsheet).mockResolvedValue({
      spreadsheetId: "canonical-id",
      sheets: [],
    })

    const result = await runWeeklyRecruitmentStagingRollover({
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      nowMs: NOW,
    })

    expect(result.outcomes[0]).toEqual({
      artifactKey: "weekly_recruitment",
      status: "blocked",
      reason: "Weekly Recruitment rollover failed.",
    })
    expect(readStagingDriveMetadata).not.toHaveBeenCalled()
    expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
  })

  test("does not expose a private discovery error in its returned outcome", async () => {
    const privateMarker = "candidate_private_marker_Jane_Doe"
    vi.mocked(readStagingSpreadsheet).mockRejectedValueOnce(
      new Error(`Discovery failed for ${privateMarker}`)
    )

    const result = await runWeeklyRecruitmentStagingRollover({
      clients: {} as GoogleWorkspaceStagingClients,
      reportingWeekFriday: "2026-07-10",
      nowMs: NOW,
    })

    expect(result.outcomes[0].reason).toBe("Weekly Recruitment rollover failed.")
    expect(JSON.stringify(result)).not.toContain(privateMarker)
  })
})

function installPreparedBeforeState(): void {
  vi.mocked(readStagingSpreadsheet).mockResolvedValue({
    spreadsheetId: CANONICAL_ID,
    sheets: [
      {
        properties: {
          sheetId: PREDECESSOR_ID,
          title: PREDECESSOR_TITLE,
          index: 0,
        },
      },
    ],
  })
  vi.mocked(readStagingDriveMetadata).mockResolvedValue({
    id: CANONICAL_ID,
    mimeType: "application/vnd.google-apps.spreadsheet",
    trashed: false,
    version: "123",
    capabilities: { canEdit: true, canModifyContent: true },
  })
  vi.mocked(readStagingStructuralNormalizationSnapshot).mockImplementation(async (spec) => ({
    spreadsheet: spec.expectedBefore,
    structure: {
      spreadsheetId: CANONICAL_ID,
      properties: { count: 0, fingerprint: STRUCTURE_FINGERPRINT },
      namedRanges: { count: 0, fingerprint: STRUCTURE_FINGERPRINT },
      sheets: [],
      structureHash: STRUCTURE_FINGERPRINT,
    },
    literalRanges: [],
    literalCellUpperBound: 0,
  }))
  vi.mocked(projectStagingStructuralNormalizationState).mockImplementation(
    (_snapshot, spec) => spec.expectedBefore
  )
}

function installExistingTargetDiscovery(): void {
  const sheets = [
    {
      properties: {
        sheetId: weeklyRecruitmentTargetSheetId("2026-07-10"),
        title: weeklyRecruitmentTargetSheetTitle("2026-07-10"),
        index: 0,
      },
    },
    {
      properties: {
        sheetId: PREDECESSOR_ID,
        title: PREDECESSOR_TITLE,
        index: 1,
      },
    },
  ]
  vi.mocked(readStagingSpreadsheet).mockResolvedValue({ spreadsheetId: CANONICAL_ID, sheets })
  installObservedSheets(sheets)
}

function installObservedSheets(
  sheets: readonly { properties: { sheetId: number; title: string; index: number } }[]
): void {
  vi.mocked(readStagingStructuralNormalizationSnapshot).mockResolvedValue({
    spreadsheet: { spreadsheetId: CANONICAL_ID, sheets },
    structure: {
      spreadsheetId: CANONICAL_ID,
      properties: { count: 0, fingerprint: STRUCTURE_FINGERPRINT },
      namedRanges: { count: 0, fingerprint: STRUCTURE_FINGERPRINT },
      sheets: [],
      structureHash: STRUCTURE_FINGERPRINT,
    },
    literalRanges: [],
    literalCellUpperBound: 0,
  })
}

function specForCurrentWeek() {
  return weeklyRecruitmentRolloverNormalizationSpec({
    reportingWeekFriday: "2026-07-10",
    predecessorSheetId: PREDECESSOR_ID,
    predecessorSheetTitle: PREDECESSOR_TITLE,
  })
}
