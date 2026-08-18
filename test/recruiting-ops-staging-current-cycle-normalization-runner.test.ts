import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("../lib/recruiting-ops/delivery/google-workspace-staging-client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../lib/recruiting-ops/delivery/google-workspace-staging-client")
  >()
  return {
    ...actual,
    normalizeStagingSheetStructure: vi.fn(),
    readStagingDriveMetadata: vi.fn(),
    readStagingStructuralNormalizationSnapshot: vi.fn(),
  }
})

vi.mock("../lib/recruiting-ops/delivery/staging-structural-normalization-observer", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../lib/recruiting-ops/delivery/staging-structural-normalization-observer")
  >()
  return {
    ...actual,
    bindStagingStructuralFilterPreimages: vi.fn((spec) => spec),
    projectStagingStructuralNormalizationState: vi.fn(),
  }
})

import {
  createCurrentCycleStructuralWritePermit,
  currentCycleStructuralSpecsForArtifacts,
  runCurrentCycleStagingStructuralNormalizations,
  type CurrentCycleStructuralArtifactKey,
} from "../lib/recruiting-ops/delivery/staging-current-cycle-normalization-runner"
import {
  CURRENT_CYCLE_PIPELINE_CANDIDATE_SHEET_IDS,
  CURRENT_CYCLE_PIPELINE_CANDIDATE_TITLE,
} from "../lib/recruiting-ops/delivery/staging-current-cycle-normalizations"
import {
  normalizeStagingSheetStructure,
  readStagingDriveMetadata,
  readStagingStructuralNormalizationSnapshot,
  StagingStructuralNormalizationExecutionError,
  type GoogleWorkspaceStagingClients,
} from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import {
  STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID,
} from "../lib/recruiting-ops/delivery/staging-kill-switch"
import {
  allHiresNormalizationSpec,
  pipelineNormalizationSpec,
  planStagingStructuralNormalization,
} from "../lib/recruiting-ops/delivery/staging-structural-normalization"
import { projectStagingStructuralNormalizationState } from "../lib/recruiting-ops/delivery/staging-structural-normalization-observer"
import type { KillSwitchState } from "../lib/recruiting-ops/autonomy"

const NOW = Date.parse("2026-07-11T22:30:00.000Z")
const RUN_ID = "staging_structure_20260711223000000"
const STRUCTURE_FINGERPRINT = `sha256:${"a".repeat(64)}`
const CLEAR_SWITCH: KillSwitchState = {
  scope: "global",
  scopeId: STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID,
  enabled: false,
  reason: "copy-only structural test authorized",
  updatedAt: "2026-07-11T22:29:00.000Z",
  updatedBy: "test",
}

describe("current-cycle copied-sheet structural runner", () => {
  beforeEach(() => {
    vi.mocked(normalizeStagingSheetStructure).mockReset()
    vi.mocked(readStagingDriveMetadata).mockReset()
    vi.mocked(readStagingStructuralNormalizationSnapshot).mockReset()
    vi.mocked(projectStagingStructuralNormalizationState).mockReset()
  })

  test("selects only registered current-cycle specs and rejects ambiguity", () => {
    expect(currentCycleStructuralSpecsForArtifacts(["pipeline_907", "final_offer"]).map((spec) => spec.artifactKey)).toEqual([
      "pipeline_907",
      "final_offer",
    ])
    expect(() => currentCycleStructuralSpecsForArtifacts([])).toThrow("at least one artifact")
    expect(() => currentCycleStructuralSpecsForArtifacts(["rps_tracking", "rps_tracking"])).toThrow("Duplicate")
    expect(() => currentCycleStructuralSpecsForArtifacts(["weekly_recruitment"])).toThrow("no current-cycle")
    expect(() =>
      currentCycleStructuralSpecsForArtifacts(
        ["all_hires"] as unknown as CurrentCycleStructuralArtifactKey[]
      )
    ).toThrow("all_hires current-cycle structural normalization is quarantined")
    expect(() =>
      currentCycleStructuralSpecsForArtifacts(
        ["pipeline_890"] as unknown as CurrentCycleStructuralArtifactKey[]
      )
    ).toThrow("pipeline_890 current-cycle structural normalization is quarantined")
  })

  test.each(["all_hires", "pipeline_890"] as const)(
    "rejects quarantined %s before any current-cycle runner preflight or mutation",
    async (artifactKey) => {
      await expect(
        runCurrentCycleStagingStructuralNormalizations({
          clients: {} as GoogleWorkspaceStagingClients,
          artifactKeys: [artifactKey] as unknown as CurrentCycleStructuralArtifactKey[],
          mode: "write",
          nowMs: NOW,
          loadKillSwitchStates: async () => [CLEAR_SWITCH],
        })
      ).rejects.toThrow(`${artifactKey} current-cycle structural normalization is quarantined`)

      expect(readStagingDriveMetadata).not.toHaveBeenCalled()
      expect(readStagingStructuralNormalizationSnapshot).not.toHaveBeenCalled()
      expect(normalizeStagingSheetStructure).not.toHaveBeenCalled()
    }
  )

  test("mints a short-lived permit from the exact immutable copy plan", () => {
    const [spec] = currentCycleStructuralSpecsForArtifacts(["rps_tracking"])
    const plan = planStagingStructuralNormalization(spec, spec.expectedBefore)
    const issuedAtMs = Date.parse("2026-07-11T22:30:00.000Z")
    const permit = createCurrentCycleStructuralWritePermit({
      spec,
      plan,
      structureFingerprint: `sha256:${"a".repeat(64)}`,
      driveVersion: "123",
      runId: "copy_structure_test",
      issuedAtMs,
    })

    expect(permit).toMatchObject({
      artifactKey: "rps_tracking",
      artifactId: spec.spreadsheetId,
      normalizationId: spec.id,
      expectedStatus: "planned",
      observedStructureFingerprint: `sha256:${"a".repeat(64)}`,
      expectedDriveVersion: "123",
      killSwitchStoreReachable: true,
      killSwitchClear: true,
      canonicalOnly: true,
    })
    expect(Date.parse(permit.expiresAt) - Date.parse(permit.issuedAt)).toBe(10 * 60_000)
  })

  test("cannot mint a current-cycle permit for the quarantined All Hires reference spec", () => {
    const spec = allHiresNormalizationSpec()
    const plan = planStagingStructuralNormalization(spec, spec.expectedBefore)

    expect(() =>
      createCurrentCycleStructuralWritePermit({
        spec,
        plan,
        structureFingerprint: STRUCTURE_FINGERPRINT,
        driveVersion: "123",
        runId: RUN_ID,
        issuedAtMs: NOW,
      })
    ).toThrow("all_hires current-cycle structural normalization is quarantined")
  })

  test("cannot mint a current-cycle permit for the quarantined Pipeline 890 reference spec", () => {
    const spec = pipelineNormalizationSpec({
      artifactKey: "pipeline_890",
      currentCandidateTitle: CURRENT_CYCLE_PIPELINE_CANDIDATE_TITLE,
      reservedCandidateSheetId: CURRENT_CYCLE_PIPELINE_CANDIDATE_SHEET_IDS.pipeline_890,
    })
    const plan = planStagingStructuralNormalization(spec, spec.expectedBefore)

    expect(() =>
      createCurrentCycleStructuralWritePermit({
        spec,
        plan,
        structureFingerprint: STRUCTURE_FINGERPRINT,
        driveVersion: "123",
        runId: RUN_ID,
        issuedAtMs: NOW,
      })
    ).toThrow("pipeline_890 current-cycle structural normalization is quarantined")
  })

  test("retains the structural writer's safe rollback evidence in a blocked outcome", async () => {
    const [spec] = currentCycleStructuralSpecsForArtifacts(["rps_tracking"])
    const plan = planStagingStructuralNormalization(spec, spec.expectedBefore)
    const permit = createCurrentCycleStructuralWritePermit({
      spec,
      plan,
      structureFingerprint: STRUCTURE_FINGERPRINT,
      driveVersion: "123",
      runId: RUN_ID,
      issuedAtMs: NOW,
    })
    vi.mocked(readStagingDriveMetadata).mockResolvedValue({
      id: spec.spreadsheetId,
      mimeType: "application/vnd.google-apps.spreadsheet",
      trashed: false,
      version: "123",
      capabilities: { canEdit: true, canModifyContent: true },
    })
    vi.mocked(readStagingStructuralNormalizationSnapshot).mockResolvedValue({
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
    })
    vi.mocked(projectStagingStructuralNormalizationState).mockReturnValue(spec.expectedBefore)
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

    const result = await runCurrentCycleStagingStructuralNormalizations({
      clients: {} as GoogleWorkspaceStagingClients,
      artifactKeys: ["rps_tracking"],
      mode: "write",
      nowMs: NOW,
      loadKillSwitchStates: async () => [CLEAR_SWITCH],
    })

    expect(result.outcomes).toEqual([{
      artifactKey: "rps_tracking",
      status: "blocked",
      failure: {
        artifactKey: "rps_tracking",
        normalizationId: spec.id,
        runId: RUN_ID,
        failureStage: "rollback",
        mutationCallCount: 2,
        rollbackAttempted: true,
        rollbackVerified: false,
        safePreimageVerified: false,
        beforeStructureFingerprint: STRUCTURE_FINGERPRINT,
      },
      reason: "Staging structural normalization failed at rollback; the exact structural preimage could not be verified.",
    }])
  })

  test("does not manufacture structured execution evidence for an ordinary preflight error", async () => {
    vi.mocked(readStagingDriveMetadata).mockRejectedValue(new Error("safe preflight failure"))

    const result = await runCurrentCycleStagingStructuralNormalizations({
      clients: {} as GoogleWorkspaceStagingClients,
      artifactKeys: ["rps_tracking"],
      mode: "dry_run",
      nowMs: NOW,
    })

    expect(result.outcomes).toEqual([{
      artifactKey: "rps_tracking",
      status: "blocked",
      reason: "safe preflight failure",
    }])
  })
})
