import type { RecruiterTeamHodEntry } from "../dimensions/config/recruiter-team-hod.v1"
import type { InterviewStageTaxonomyEntry } from "../dimensions/types"
import { readKillSwitchStates } from "../durable-safety-store"
import { createSupabaseSafetyStoreClient } from "../supabase-safety-store-client"
import type {
  StagingHydrationFacts,
  StagingHydrationSourceRequirements,
} from "../delivery-source/staging-hydration-source-loader"
import {
  createGoogleWorkspaceStagingClients,
  appendDateFormatOwnedRanges,
  deliveryRpsValueOwnedFormatRanges,
  readStagingSheetStructureSnapshot,
  StagingSheetValueWriteExecutionError,
  writeStagingSheetValues,
  type GoogleWorkspaceStagingClients,
  type StagingMutationCertificationStatus,
  type StagingSheetValueWriteFailureStage,
  type StagingSheetWriteSummary,
} from "./google-workspace-staging-client"
import { planStagingArtifactValues, type PlannedStagingArtifact, type StagingSheetArtifactKey } from "./staging-artifact-value-planner"
import { getStagingArtifact } from "./staging-artifact-registry"
import { evaluateStagingKillSwitchStates, type StagingKillSwitchEvidence } from "./staging-kill-switch"
import type { StagingWritePermit } from "./staging-write-permit"

export interface StagingHydrationArtifactOutcome {
  artifactKey: StagingSheetArtifactKey
  status: "dry_run" | "no_change" | "written" | "blocked"
  plan?: PlannedStagingArtifact["publicSummary"]
  write?: StagingSheetWriteSummary
  failure?: StagingHydrationArtifactFailureSummary
  reason?: string
}

export interface StagingHydrationArtifactFailureSummary {
  failureStage: "planning" | "authorization" | StagingSheetValueWriteFailureStage
  mutationCallCount: number | null
  beforeDriveVersion: string | null
  afterDriveVersion: string | null
  certificationStatus: StagingMutationCertificationStatus
}

export interface StagingHydrationRunOutcome {
  runId: string
  mode: "dry_run" | "write"
  sourceGeneratedAt: string
  reportingWeekFriday: string
  quarterStart: string
  sourceCounts: {
    candidateEvents: number
    offers: number
    scorecards: number
    reqWeeks: number
  }
  artifactOutcomes: readonly StagingHydrationArtifactOutcome[]
}

const ALL_SHEET_ARTIFACTS: readonly StagingSheetArtifactKey[] = [
  "weekly_recruitment",
  "weekly_progress",
  "all_hires",
  "pipeline_890",
  "pipeline_907",
  "pipeline_1026_1027",
  "pipeline_1118_1119",
  "final_offer",
  "rps_tracking",
  "delivery_roles_rps",
]

export async function runStagingHydration(input: {
  artifactKeys?: readonly StagingSheetArtifactKey[]
  mode?: "dry_run" | "write"
  log?: (message: string) => void
  nowMs?: number
  /** Live authorization clock; unlike nowMs, this is re-read at mutation boundaries. */
  currentTimeMs?: () => number
  env?: Readonly<Record<string, string | undefined>>
  clients?: GoogleWorkspaceStagingClients
  facts?: StagingHydrationFacts
  roster?: readonly RecruiterTeamHodEntry[]
  /** Retained only for source-injected compatibility; source derivation now lives in the orchestrator. */
  stageTaxonomy?: readonly InterviewStageTaxonomyEntry[]
  reportingWeekFriday?: string
  deliveryRpsReportDate?: string
  /** Durable orchestration identity; omitted only by legacy/manual callers. */
  runId?: string
} = {}): Promise<StagingHydrationRunOutcome> {
  const mode = input.mode ?? "dry_run"
  const nowMs = input.nowMs ?? Date.now()
  const artifactKeys = input.artifactKeys ?? ALL_SHEET_ARTIFACTS
  assertArtifactKeys(artifactKeys)
  const runId = input.runId ?? `staging_hydration_${new Date(nowMs).toISOString().replace(/[^0-9]/g, "")}`
  if (!runId.trim()) throw new Error("Staging hydration runId is required.")

  if (!input.facts || !input.roster) {
    throw new Error("Staging hydration requires the orchestrator's persisted source cut.")
  }
  const [clients] = await Promise.all([
    input.clients ? Promise.resolve(input.clients) : createGoogleWorkspaceStagingClients(),
  ])
  const facts = input.facts
  const roster = input.roster
  if (input.reportingWeekFriday && input.reportingWeekFriday !== facts.reportingWeekFriday) {
    throw new Error("Staging hydration reporting week does not match its persisted source cut.")
  }
  const truncated = facts.diagnostics.filter((diagnostic) => diagnostic.truncationSuspected)
  if (truncated.length > 0) {
    throw new Error(`Staging hydration source truncation suspected on ${truncated.length} pull(s).`)
  }

  const outcomes: StagingHydrationArtifactOutcome[] = []
  for (const artifactKey of artifactKeys) {
    let executionStage: "planning" | "authorization" | "write" = "planning"
    try {
      // Must match what the write path folds in, or the planned structure hash
      // and the pre-mutation one disagree and every write is refused.
      const valueOwnedFormatRanges = artifactKey === "delivery_roles_rps"
        ? deliveryRpsValueOwnedFormatRanges(requireDeliveryRpsReportDate(input.deliveryRpsReportDate))
        : appendDateFormatOwnedRanges(artifactKey)
      const structure = await readStagingSheetStructureSnapshot(
        artifactKey,
        clients,
        valueOwnedFormatRanges.length > 0 ? { valueOwnedFormatRanges } : {}
      )
      const planned = await planStagingArtifactValues({
        artifactKey,
        runId,
        facts,
        roster,
        clients,
        structure,
        ...(artifactKey === "delivery_roles_rps"
          ? { deliveryRpsReportDate: input.deliveryRpsReportDate }
          : {}),
      })
      if (mode === "dry_run") {
        outcomes.push({ artifactKey, status: "dry_run", plan: planned.publicSummary })
        continue
      }

      executionStage = "authorization"
      const states = await readKillSwitchStates(createSupabaseSafetyStoreClient())
      const currentTimeMs = input.currentTimeMs ?? Date.now
      const issuedAtMs = currentTimeMs()
      const killSwitch = evaluateStagingKillSwitchStates(artifactKey, states, issuedAtMs)
      if (!killSwitch.clear) {
        outcomes.push({
          artifactKey,
          status: "blocked",
          plan: planned.publicSummary,
          failure: noMutationFailure("authorization"),
          reason: "Durable staging hydration kill switch blocks this artifact.",
        })
        break
      }
      const permit = createStagingSheetWritePermit({
        artifactKey,
        plan: planned.plan,
        runId,
        issuedAtMs,
        killSwitch,
      })
      executionStage = "write"
      const write = await writeStagingSheetValues({
        plan: planned.plan,
        permit,
        clients,
        env: input.env,
        nowMs: issuedAtMs,
        currentTimeMs,
        revalidateKillSwitchClear: async ({ artifactKey, nowMs }) => {
          const freshStates = await readKillSwitchStates(createSupabaseSafetyStoreClient())
          const freshKillSwitch = evaluateStagingKillSwitchStates(artifactKey, freshStates, nowMs)
          if (!freshKillSwitch.clear) {
            throw new Error("Durable staging hydration kill switch blocks the mutation boundary.")
          }
        },
      })
      outcomes.push({
        artifactKey,
        status: write.status === "no_change" ? "no_change" : "written",
        plan: planned.publicSummary,
        write,
      })
    } catch (error) {
      const failure = stagingHydrationFailureSummary(error, executionStage)
      // The public summary carries only the stage, so without this the reason a
      // value phase refused is unrecoverable -- not in the ledger, not in logs.
      console.error(
        `[recruiting-ops-staging-hydration] ${artifactKey} failed at ${failure.failureStage}:`,
        safeDiagnostic(error)
      )
      outcomes.push({
        artifactKey,
        status: "blocked",
        failure,
        reason: `Staging hydration failed at ${failure.failureStage}.`,
      })
      if (mode === "write") break
    }
  }

  return {
    runId,
    mode,
    sourceGeneratedAt: facts.generatedAt,
    reportingWeekFriday: facts.reportingWeekFriday,
    quarterStart: facts.quarterStart,
    sourceCounts: {
      candidateEvents: facts.candidateEvents.length,
      offers: facts.offers.length,
      scorecards: facts.scorecards.length,
      reqWeeks: facts.reqWeeks.length,
    },
    artifactOutcomes: outcomes,
  }
}

function requireDeliveryRpsReportDate(value: string | undefined): string {
  if (!value) throw new Error("Delivery RPS hydration requires the current business date.")
  return value
}

/** Error text only. Source payloads and identifiers never reach a log. */
function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/g, " ").slice(0, 300)
}

function stagingHydrationFailureSummary(
  error: unknown,
  executionStage: "planning" | "authorization" | "write"
): StagingHydrationArtifactFailureSummary {
  if (error instanceof StagingSheetValueWriteExecutionError) {
    return {
      failureStage: error.failureStage,
      mutationCallCount: error.mutationCallCount,
      beforeDriveVersion: error.beforeDriveVersion,
      afterDriveVersion: error.afterDriveVersion,
      certificationStatus: error.certificationStatus,
    }
  }
  return executionStage === "write"
    ? {
        failureStage: "writer_unknown",
        mutationCallCount: null,
        beforeDriveVersion: null,
        afterDriveVersion: null,
        certificationStatus: "ambiguous",
      }
    : noMutationFailure(executionStage)
}

function noMutationFailure(
  failureStage: "planning" | "authorization"
): StagingHydrationArtifactFailureSummary {
  return {
    failureStage,
    mutationCallCount: 0,
    beforeDriveVersion: null,
    afterDriveVersion: null,
    certificationStatus: "not_attempted",
  }
}

/**
 * Mints the same short-lived, exact-copy permit for normal hydration and the
 * copy acceptance runner. Keeping this construction in one place prevents a
 * verification lane from weakening the production writer's permit contract.
 */
export function createStagingSheetWritePermit(input: {
  artifactKey: StagingSheetArtifactKey
  plan: PlannedStagingArtifact["plan"]
  runId: string
  issuedAtMs: number
  killSwitch: StagingKillSwitchEvidence
}): StagingWritePermit {
  if (input.plan.artifactKey !== input.artifactKey || input.plan.runId !== input.runId) {
    throw new Error("Staging sheet permit input does not match its private plan identity.")
  }
  if (!input.killSwitch.clear) {
    throw new Error("Staging sheet permit requires an affirmative clear kill-switch state.")
  }
  const target = getStagingArtifact(input.artifactKey)
  return {
    artifactKey: input.artifactKey,
    artifactId: target.artifactId,
    kind: "google_sheet",
    runId: input.runId,
    issuedAt: new Date(input.issuedAtMs).toISOString(),
    expiresAt: new Date(input.issuedAtMs + 10 * 60_000).toISOString(),
    sourceGeneratedAt: input.plan.sourceGeneratedAt,
    payloadFingerprint: input.plan.payloadFingerprint,
    structureHash: input.plan.structureHash,
    approvedRangeIds: input.plan.approvedRangeIds,
    killSwitchStoreReachable: input.killSwitch.storeReachable,
    killSwitchClear: true,
    canonicalOnly: true,
  }
}

export function stagingHydrationSourceRequirementsForArtifacts(
  artifactKeys: readonly StagingSheetArtifactKey[]
): StagingHydrationSourceRequirements {
  return {
    includeLegacyRpsHistory: artifactKeys.includes("rps_tracking"),
    includeDeliveryRpsCurrentWeek: artifactKeys.includes("delivery_roles_rps"),
  }
}

function assertArtifactKeys(keys: readonly StagingSheetArtifactKey[]): void {
  if (keys.length === 0) throw new Error("Staging hydration requires at least one artifact.")
  const allowed = new Set(ALL_SHEET_ARTIFACTS)
  const seen = new Set<string>()
  for (const key of keys) {
    if (!allowed.has(key)) throw new Error(`Unsupported staging sheet artifact: ${key}`)
    if (seen.has(key)) throw new Error(`Duplicate staging sheet artifact: ${key}`)
    seen.add(key)
  }
}
