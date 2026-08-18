import type { KillSwitchState } from "../autonomy"
import { readKillSwitchStates } from "../durable-safety-store"
import { createSupabaseSafetyStoreClient } from "../supabase-safety-store-client"
import {
  normalizeStagingSheetStructure,
  readStagingDriveMetadata,
  readStagingStructuralNormalizationSnapshot,
  StagingStructuralNormalizationExecutionError,
  type GoogleWorkspaceStagingClients,
  type StagingSheetStructuralWriteSummary,
  type StagingStructuralFailureStage,
} from "./google-workspace-staging-client"
import { evaluateStagingKillSwitchStates } from "./staging-kill-switch"
import {
  CURRENT_CYCLE_MANUAL_ONLY_STRUCTURAL_ARTIFACT_KEYS,
  currentCycleStagingStructuralNormalizationSpecs,
} from "./staging-current-cycle-normalizations"
import {
  planStagingStructuralNormalization,
  type StagingStructuralNormalizationPlan,
  type StagingStructuralNormalizationSpec,
} from "./staging-structural-normalization"
import {
  bindStagingStructuralFilterPreimages,
  projectStagingStructuralNormalizationState,
} from "./staging-structural-normalization-observer"
import {
  stagingStructuralNormalizationFingerprint,
  type StagingStructuralWritePermit,
} from "./staging-structural-write-permit"

export type CurrentCycleStructuralArtifactKey =
  StagingStructuralNormalizationSpec["artifactKey"]

export interface CurrentCycleStructuralPlanSummary {
  artifactKey: CurrentCycleStructuralArtifactKey
  normalizationId: string
  status: StagingStructuralNormalizationPlan["status"]
  forwardRequestCount: number
  rollbackRequestCount: number
  structureFingerprint: string
  preimageFingerprint: string
  afterStateFingerprint: string
  forwardRequestsFingerprint: string
  rollbackRequestsFingerprint: string
  driveVersion: string
  literalRangeCount: number
  literalCellUpperBound: number
  copyOnly: false
  canonicalWriteAuthorized: true
}

export interface CurrentCycleStructuralNormalizationOutcome {
  artifactKey: CurrentCycleStructuralArtifactKey
  status: "dry_run" | "already_normalized" | "normalized" | "blocked"
  plan?: CurrentCycleStructuralPlanSummary
  write?: StagingSheetStructuralWriteSummary
  failure?: CurrentCycleStructuralExecutionFailureSummary
  reason?: string
}

/** PII-free execution evidence retained when the structural writer fails. */
export interface CurrentCycleStructuralExecutionFailureSummary {
  artifactKey: CurrentCycleStructuralArtifactKey
  normalizationId: string
  runId: string
  failureStage: StagingStructuralFailureStage
  mutationCallCount: number
  rollbackAttempted: boolean
  rollbackVerified: boolean
  safePreimageVerified: boolean
  beforeStructureFingerprint: string
}

export interface CurrentCycleStructuralNormalizationRun {
  runId: string
  mode: "dry_run" | "write"
  copyOnly: false
  canonicalWriteAuthorized: true
  outcomes: readonly CurrentCycleStructuralNormalizationOutcome[]
}

/**
 * One-time 2026-07-03..09 copied-workbook form normalization. This runner is
 * intentionally separate from recurring hydration: these static specs must
 * never be scheduled as future-week lifecycle automation.
 */
export async function runCurrentCycleStagingStructuralNormalizations(input: {
  clients: GoogleWorkspaceStagingClients
  artifactKeys?: readonly CurrentCycleStructuralArtifactKey[]
  mode?: "dry_run" | "write"
  env?: Readonly<Record<string, string | undefined>>
  nowMs?: number
  currentTimeMs?: () => number
  loadKillSwitchStates?: () => Promise<readonly KillSwitchState[]>
}): Promise<CurrentCycleStructuralNormalizationRun> {
  const mode = input.mode ?? "dry_run"
  const currentTimeMs = input.currentTimeMs ?? Date.now
  const specs = currentCycleStructuralSpecsForArtifacts(input.artifactKeys)
  const runId = `staging_structure_${new Date(input.nowMs ?? currentTimeMs()).toISOString().replace(/[^0-9]/g, "")}`
  const outcomes: CurrentCycleStructuralNormalizationOutcome[] = []

  for (const spec of specs) {
    try {
      const prepared = await prepareCurrentCycleStructuralNormalization(spec, input.clients)
      if (mode === "dry_run") {
        outcomes.push({ artifactKey: spec.artifactKey, status: "dry_run", plan: prepared.summary })
        continue
      }

      const states = await (input.loadKillSwitchStates
        ? input.loadKillSwitchStates()
        : readKillSwitchStates(createSupabaseSafetyStoreClient()))
      const issuedAtMs = currentTimeMs()
      const killSwitch = evaluateStagingKillSwitchStates(prepared.spec.artifactKey, states, issuedAtMs)
      if (!killSwitch.clear) {
        outcomes.push({
          artifactKey: spec.artifactKey,
          status: "blocked",
          plan: prepared.summary,
          reason: killSwitch.reason,
        })
        break
      }

      const permit = createCurrentCycleStructuralWritePermit({
        spec: prepared.spec,
        plan: prepared.plan,
        structureFingerprint: prepared.summary.structureFingerprint,
        driveVersion: prepared.summary.driveVersion,
        runId,
        issuedAtMs,
      })
      const write = await normalizeStagingSheetStructure({
        spec: prepared.spec,
        permit,
        clients: input.clients,
        env: input.env,
        nowMs: issuedAtMs,
        currentTimeMs,
        revalidateKillSwitchClear: async ({ artifactKey, nowMs }) => {
          const freshStates = await (input.loadKillSwitchStates
            ? input.loadKillSwitchStates()
            : readKillSwitchStates(createSupabaseSafetyStoreClient()))
          const fresh = evaluateStagingKillSwitchStates(artifactKey, freshStates, nowMs)
          if (!fresh.clear) throw new Error("Durable staging hydration kill switch blocks the mutation boundary.")
        },
      })
      outcomes.push({
        artifactKey: spec.artifactKey,
        status: write.status,
        plan: prepared.summary,
        write,
      })
    } catch (error) {
      const failure = structuralExecutionFailureSummary(error)
      outcomes.push({
        artifactKey: spec.artifactKey,
        status: "blocked",
        ...(failure ? { failure } : {}),
        reason: safeReason(error),
      })
      if (mode === "write") break
    }
  }

  return {
    runId,
    mode,
    copyOnly: false,
    canonicalWriteAuthorized: true,
    outcomes,
  }
}

function structuralExecutionFailureSummary(
  error: unknown
): CurrentCycleStructuralExecutionFailureSummary | undefined {
  if (!(error instanceof StagingStructuralNormalizationExecutionError)) return undefined
  return {
    artifactKey: error.artifactKey,
    normalizationId: error.normalizationId,
    runId: error.runId,
    failureStage: error.failureStage,
    mutationCallCount: error.mutationCallCount,
    rollbackAttempted: error.rollbackAttempted,
    rollbackVerified: error.rollbackVerified,
    safePreimageVerified: error.safePreimageVerified,
    beforeStructureFingerprint: error.beforeStructureFingerprint,
  }
}

export function currentCycleStructuralSpecsForArtifacts(
  artifactKeys?: readonly CurrentCycleStructuralArtifactKey[]
): readonly StagingStructuralNormalizationSpec[] {
  const specs = currentCycleStagingStructuralNormalizationSpecs()
  if (!artifactKeys) return specs
  if (artifactKeys.length === 0) throw new Error("Structural normalization requires at least one artifact.")
  const byKey = new Map(specs.map((spec) => [spec.artifactKey, spec]))
  const seen = new Set<string>()
  return artifactKeys.map((key) => {
    assertCurrentCycleStructuralArtifactIsAutomated(key)
    if (seen.has(key)) throw new Error(`Duplicate structural normalization artifact: ${key}`)
    seen.add(key)
    const spec = byKey.get(key)
    if (!spec) throw new Error(`Artifact has no current-cycle structural normalization: ${key}`)
    return spec
  })
}

export function createCurrentCycleStructuralWritePermit(input: {
  spec: StagingStructuralNormalizationSpec
  plan: StagingStructuralNormalizationPlan
  structureFingerprint: string
  driveVersion: string
  runId: string
  issuedAtMs: number
}): StagingStructuralWritePermit {
  assertCurrentCycleStructuralArtifactIsAutomated(input.spec.artifactKey)
  return {
    artifactKey: input.spec.artifactKey,
    artifactId: input.spec.spreadsheetId,
    kind: "google_sheet",
    normalizationId: input.spec.id,
    normalizationFingerprint: stagingStructuralNormalizationFingerprint(input.spec),
    expectedStatus: input.plan.status,
    observedStructureFingerprint: input.structureFingerprint,
    expectedDriveVersion: input.driveVersion,
    runId: input.runId,
    issuedAt: new Date(input.issuedAtMs).toISOString(),
    expiresAt: new Date(input.issuedAtMs + 10 * 60_000).toISOString(),
    killSwitchStoreReachable: true,
    killSwitchClear: true,
    canonicalOnly: true,
  }
}

function assertCurrentCycleStructuralArtifactIsAutomated(artifactKey: string): void {
  if (
    CURRENT_CYCLE_MANUAL_ONLY_STRUCTURAL_ARTIFACT_KEYS.some(
      (manualArtifactKey) => manualArtifactKey === artifactKey
    )
  ) {
    throw new Error(
      `${artifactKey} current-cycle structural normalization is quarantined; its structural change is manual-only for this cycle.`
    )
  }
}

async function prepareCurrentCycleStructuralNormalization(
  spec: StagingStructuralNormalizationSpec,
  clients: GoogleWorkspaceStagingClients
): Promise<{
  spec: StagingStructuralNormalizationSpec
  plan: StagingStructuralNormalizationPlan
  summary: CurrentCycleStructuralPlanSummary
}> {
  const [metadata, observed] = await Promise.all([
    readStagingDriveMetadata(spec.artifactKey, clients),
    readStagingStructuralNormalizationSnapshot(spec, clients),
  ])
  assertEditableCanonicalMetadata(metadata, spec.spreadsheetId)
  const driveVersion = String(metadata.version ?? "").trim()
  if (!driveVersion) throw new Error("Copied spreadsheet Drive version is missing.")
  const boundSpec = bindStagingStructuralFilterPreimages(spec, observed.spreadsheet)
  const state = projectStagingStructuralNormalizationState(observed.spreadsheet, boundSpec)
  const plan = planStagingStructuralNormalization(boundSpec, state)
  return {
    spec: boundSpec,
    plan,
    summary: {
      artifactKey: spec.artifactKey,
      normalizationId: spec.id,
      status: plan.status,
      forwardRequestCount: plan.requestMetadata.forwardRequestCount,
      rollbackRequestCount: plan.requestMetadata.rollbackRequestCount,
      structureFingerprint: observed.structure.structureHash,
      preimageFingerprint: plan.requestMetadata.preimageFingerprint,
      afterStateFingerprint: plan.requestMetadata.afterStateFingerprint,
      forwardRequestsFingerprint: plan.requestMetadata.forwardRequestsFingerprint,
      rollbackRequestsFingerprint: plan.requestMetadata.rollbackRequestsFingerprint,
      driveVersion,
      literalRangeCount: observed.literalRanges.length,
      literalCellUpperBound: observed.literalCellUpperBound,
      copyOnly: false,
      canonicalWriteAuthorized: true,
    },
  }
}

function assertEditableCanonicalMetadata(
  metadata: {
    id?: string | null
    mimeType?: string | null
    trashed?: boolean | null
    capabilities?: { canEdit?: boolean | null; canModifyContent?: boolean | null } | null
  },
  expectedId: string
): void {
  if (metadata.id !== expectedId || metadata.mimeType !== "application/vnd.google-apps.spreadsheet") {
    throw new Error("Structural preflight metadata is not the exact registered canonical spreadsheet.")
  }
  if (metadata.trashed) throw new Error("Registered canonical spreadsheet is trashed.")
  if (metadata.capabilities?.canEdit !== true || metadata.capabilities?.canModifyContent !== true) {
    throw new Error("Approved writer cannot edit the registered canonical spreadsheet.")
  }
}

function safeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/g, " ").slice(0, 500)
}
