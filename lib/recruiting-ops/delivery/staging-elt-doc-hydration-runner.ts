import type { KillSwitchState } from "../autonomy"
import { createPayloadFingerprint } from "../checksums"
import { readKillSwitchStates as readDurableKillSwitchStates } from "../durable-safety-store"
import {
  loadLatestExecSnapshot,
  type ExecSnapshotRow,
  type LatestExecSnapshot,
} from "../exec-snapshot-store"
import { assertPublicSafe, redactPublicText } from "../safe-public-output"
import { createSupabaseSafetyStoreClient } from "../supabase-safety-store-client"
import {
  runEltDocDryRun,
  type EltDocDryRunPublicSummary,
  type GoogleDocsDocumentSnapshot,
} from "./elt-doc-dry-run"
import {
  createGoogleWorkspaceStagingClients,
  readStagingDocument,
  StagingEltDocWriteExecutionError,
  stagingEltDocWriteFailureStage,
  writeStagingEltDocument,
  type GoogleWorkspaceStagingClients,
  type StagingEltDocWriteFailureStage,
  type StagingEltDocWriteSummary,
  type StagingMutationCertificationStatus,
} from "./google-workspace-staging-client"
import { P1_ELT_DOC_TARGET } from "./p1-artifacts"
import { getStagingArtifact } from "./staging-artifact-registry"
import { evaluateStagingKillSwitchStates } from "./staging-kill-switch"
import type { StagingWritePermit } from "./staging-write-permit"

export type StagingEltDocHydrationMode = "dry_run" | "write"

export type StagingEltDocHydrationBlockCode =
  | "target_not_registered_copy"
  | "snapshot_unavailable"
  | "document_unavailable"
  | "plan_blocked"
  | "kill_switch_unavailable"
  | "kill_switch_blocked"
  | "write_failed"

export interface StagingEltDocPublicWriteSummary {
  status: StagingEltDocWriteSummary["status"]
  action: StagingEltDocWriteSummary["action"]
  requestCount: number
  mutationCallCount: number
  beforeRevisionFingerprint: string
  afterRevisionFingerprint: string
  beforeDriveVersion: string
  afterDriveVersion: string
  preimageFingerprint: string
  beforePermissionFingerprint: string
  afterPermissionFingerprint: string
  beforeOutsideContentFingerprint: string
  afterOutsideContentFingerprint: string
  rollbackRequestCount: number
  rollbackAttempted: false
}

export interface StagingEltDocHydrationFailureSummary {
  failureStage: StagingEltDocWriteFailureStage
  mutationCallCount: number | null
  providerHttpStatus?: number
  providerRequestIndex?: number
  beforeRevisionFingerprint: string | null
  afterRevisionFingerprint: string | null
  beforeDriveVersion: string | null
  afterDriveVersion: string | null
  rollbackDriveVersion: string | null
  beforePermissionFingerprint: string | null
  afterPermissionFingerprint: string | null
  rollbackPermissionFingerprint: string | null
  certificationStatus: StagingMutationCertificationStatus
  rollbackAttempted: boolean
  rollbackVerified: boolean
}

/** Public route result. The private render text and Google preimages never escape. */
export interface StagingEltDocHydrationOutcome {
  artifactKey: "elt_doc"
  mode: StagingEltDocHydrationMode
  status: "dry_run" | "no_change" | "written" | "blocked"
  runId: string | null
  sourceGeneratedAt: string | null
  planRevisionFingerprint?: string
  blockCode?: StagingEltDocHydrationBlockCode
  failureStage?: StagingEltDocWriteFailureStage
  failure?: StagingEltDocHydrationFailureSummary
  plan?: EltDocDryRunPublicSummary
  write?: StagingEltDocPublicWriteSummary
}

export interface StagingEltDocHydrationPorts {
  loadLatestSnapshot(): Promise<LatestExecSnapshot>
  createClients(): Promise<GoogleWorkspaceStagingClients>
  readKillSwitchStates(): Promise<readonly KillSwitchState[]>
  writeDocument(input: Parameters<typeof writeStagingEltDocument>[0]): Promise<StagingEltDocWriteSummary>
}

export interface RunStagingEltDocHydrationInput {
  mode?: StagingEltDocHydrationMode
  nowMs?: number
  /** Live authorization clock; unlike nowMs, this is re-read at mutation boundaries. */
  currentTimeMs?: () => number
  maxSnapshotAgeMinutes?: number
  env?: Readonly<Record<string, string | undefined>>
  clients?: GoogleWorkspaceStagingClients
  /** The immutable reporting cut; when present, no independent latest-snapshot read occurs. */
  snapshot?: ExecSnapshotRow
  ports?: Partial<StagingEltDocHydrationPorts>
  /** Test/audit hook only. Every value except the registered copy fails before I/O. */
  targetDocumentId?: string
  /**
   * Declares the snapshot carries a past week's facts for a backfill; threaded
   * to the planner, which validates the labels against it and may insert the
   * absent week at its date-ordered archive position. See EltDocDryRunBaseInput.
   */
  eltBackfillWeekFriday?: string
}

/**
 * Copy-only ELT hydration orchestration. It reads the latest durable E01
 * snapshot and the registered copied Doc, then keeps the private person-level
 * plan in memory. A write additionally requires an affirmative durable switch
 * read and a short-lived permit bound to the exact plan and copy.
 */
export async function runStagingEltDocHydration(
  input: RunStagingEltDocHydrationInput = {}
): Promise<StagingEltDocHydrationOutcome> {
  const mode = input.mode ?? "dry_run"
  if (mode !== "dry_run" && mode !== "write") {
    throw new Error("Unsupported staging ELT hydration mode.")
  }
  const currentTimeMs = input.currentTimeMs ?? Date.now
  const planningNowMs = input.nowMs ?? currentTimeMs()
  const target = getStagingArtifact("elt_doc")
  const targetDocumentId = input.targetDocumentId?.trim() || target.artifactId
  if (
    target.kind !== "google_doc" ||
    target.artifactId !== P1_ELT_DOC_TARGET.stagingDocumentId ||
    targetDocumentId !== target.artifactId
  ) {
    return publicOutcome({
      artifactKey: "elt_doc",
      mode,
      status: "blocked",
      runId: null,
      sourceGeneratedAt: null,
      blockCode: "target_not_registered_copy",
    })
  }

  let loaded: LatestExecSnapshot
  if (input.snapshot) {
    loaded = { status: "available", snapshot: input.snapshot }
  } else {
    try {
      loaded = await (input.ports?.loadLatestSnapshot ?? loadLatestExecSnapshot)()
    } catch {
      return blockedWithoutPlan(mode, "snapshot_unavailable")
    }
  }
  if (loaded.status !== "available") {
    return blockedWithoutPlan(mode, "snapshot_unavailable")
  }
  const snapshot = loaded.snapshot

  let clientsPromise: Promise<GoogleWorkspaceStagingClients> | null = input.clients
    ? Promise.resolve(input.clients)
    : null
  const getClients = () => {
    clientsPromise ??= (input.ports?.createClients ?? createGoogleWorkspaceStagingClients)()
    return clientsPromise
  }

  let planned: Awaited<ReturnType<typeof runEltDocDryRun>>
  try {
    planned = await runEltDocDryRun(
      {
        snapshot,
        evaluatedAt: new Date(planningNowMs).toISOString(),
        maxSnapshotAgeMinutes: input.maxSnapshotAgeMinutes ?? 120,
        allowedSnapshotModes: ["shadow"],
        dataProvenance: "live",
        liveFlagValue: (input.env ?? process.env)[target.hydrationFlag],
        stagingAdapterPermitBoundary: true,
        targetDocumentId,
        ...(input.eltBackfillWeekFriday !== undefined
          ? { eltBackfillWeekFriday: input.eltBackfillWeekFriday }
          : {}),
      },
      {
        async getDocument(request) {
          if (
            request.documentId !== target.artifactId ||
            request.tabId !== P1_ELT_DOC_TARGET.tabId
          ) {
            throw new Error("ELT read target is not the registered staging copy.")
          }
          return (await readStagingDocument(
            "elt_doc",
            await getClients()
          )) as unknown as GoogleDocsDocumentSnapshot
        },
      }
    )
  } catch {
    return publicOutcome({
      artifactKey: "elt_doc",
      mode,
      status: "blocked",
      runId: snapshot.run_id || null,
      sourceGeneratedAt: validIsoOrNull(snapshot.generated_at),
      blockCode: "document_unavailable",
    })
  }

  if (planned.publicSummary.status === "blocked" || !planned.privatePlan) {
    return publicOutcome({
      artifactKey: "elt_doc",
      mode,
      status: "blocked",
      runId: snapshot.run_id || null,
      sourceGeneratedAt: validIsoOrNull(snapshot.generated_at),
      blockCode: "plan_blocked",
      plan: planned.publicSummary,
    })
  }
  if (mode === "dry_run") {
    return publicOutcome({
      artifactKey: "elt_doc",
      mode,
      status: "dry_run",
      runId: planned.privatePlan.runId,
      sourceGeneratedAt: planned.privatePlan.sourceGeneratedAt,
      planRevisionFingerprint: revisionFingerprint(planned.privatePlan.requiredRevisionId),
      plan: planned.publicSummary,
    })
  }

  let states: readonly KillSwitchState[]
  try {
    states = await (
      input.ports?.readKillSwitchStates ??
      (() => readDurableKillSwitchStates(createSupabaseSafetyStoreClient()))
    )()
  } catch {
    return blockedWithPlan(mode, planned.publicSummary, planned.privatePlan, "kill_switch_unavailable")
  }
  const writeNowMs = currentTimeMs()
  const killSwitch = evaluateStagingKillSwitchStates("elt_doc", states, writeNowMs)
  if (!killSwitch.clear) {
    return blockedWithPlan(mode, planned.publicSummary, planned.privatePlan, "kill_switch_blocked")
  }

  const permit: StagingWritePermit = {
    artifactKey: "elt_doc",
    artifactId: target.artifactId,
    kind: "google_doc",
    runId: planned.privatePlan.runId,
    issuedAt: new Date(writeNowMs).toISOString(),
    expiresAt: new Date(writeNowMs + 10 * 60_000).toISOString(),
    sourceGeneratedAt: planned.privatePlan.sourceGeneratedAt,
    payloadFingerprint: planned.privatePlan.payloadFingerprint,
    structureHash: planned.privatePlan.outsideContentFingerprint,
    approvedRangeIds: planned.privatePlan.approvedRangeIds,
    killSwitchStoreReachable: true,
    killSwitchClear: true,
    canonicalOnly: true,
  }

  let write: StagingEltDocWriteSummary
  try {
    write = await (input.ports?.writeDocument ?? writeStagingEltDocument)({
      plan: planned.privatePlan,
      permit,
      clients: await getClients(),
      env: input.env,
      currentTimeMs,
      revalidateKillSwitchClear: async ({ nowMs }) => {
        const freshStates = await (
          input.ports?.readKillSwitchStates ??
          (() => readDurableKillSwitchStates(createSupabaseSafetyStoreClient()))
        )()
        const freshKillSwitch = evaluateStagingKillSwitchStates("elt_doc", freshStates, nowMs)
        if (!freshKillSwitch.clear) {
          throw new Error("Durable staging hydration kill switch blocks the mutation boundary.")
        }
      },
    })
  } catch (error) {
    const failure = eltDocHydrationFailureSummary(error)
    // The summary is stage-and-counters only, and the certification assertions
    // that reject a written block name the specific mismatch nowhere else. A
    // rolled-back write is only actionable if we know what the post-state
    // failed, so log it -- redacted, since these assertions quote document text.
    console.error(
      `[recruiting-ops-elt-doc] write failed at ${failure.failureStage}:`,
      redactPublicText(error instanceof Error ? error.message : String(error))
        .replace(/[\r\n]+/g, " ")
        .slice(0, 400)
    )
    return blockedWithPlan(
      mode,
      planned.publicSummary,
      planned.privatePlan,
      "write_failed",
      failure
    )
  }

  return publicOutcome({
    artifactKey: "elt_doc",
    mode,
    status: write.status === "no_change" ? "no_change" : "written",
    runId: planned.privatePlan.runId,
    sourceGeneratedAt: planned.privatePlan.sourceGeneratedAt,
    planRevisionFingerprint: revisionFingerprint(planned.privatePlan.requiredRevisionId),
    plan: planned.publicSummary,
    write: {
      status: write.status,
      action: write.action,
      requestCount: write.requestCount,
      mutationCallCount: write.mutationCallCount,
      beforeRevisionFingerprint: revisionFingerprint(write.beforeRevisionId),
      afterRevisionFingerprint: revisionFingerprint(write.afterRevisionId),
      beforeDriveVersion: write.beforeDriveVersion,
      afterDriveVersion: write.afterDriveVersion,
      preimageFingerprint: write.preimageFingerprint,
      beforePermissionFingerprint: write.beforePermissionFingerprint,
      afterPermissionFingerprint: write.afterPermissionFingerprint,
      beforeOutsideContentFingerprint: write.beforeOutsideContentFingerprint,
      afterOutsideContentFingerprint: write.afterOutsideContentFingerprint,
      rollbackRequestCount: write.rollbackRequestCount,
      rollbackAttempted: write.rollbackAttempted,
    },
  })
}

function blockedWithoutPlan(
  mode: StagingEltDocHydrationMode,
  blockCode: StagingEltDocHydrationBlockCode
): StagingEltDocHydrationOutcome {
  return publicOutcome({
    artifactKey: "elt_doc",
    mode,
    status: "blocked",
    runId: null,
    sourceGeneratedAt: null,
    blockCode,
  })
}

function blockedWithPlan(
  mode: StagingEltDocHydrationMode,
  plan: EltDocDryRunPublicSummary,
  privatePlan: NonNullable<Awaited<ReturnType<typeof runEltDocDryRun>>["privatePlan"]>,
  blockCode: StagingEltDocHydrationBlockCode,
  failure?: StagingEltDocHydrationFailureSummary
): StagingEltDocHydrationOutcome {
  return publicOutcome({
    artifactKey: "elt_doc",
    mode,
    status: "blocked",
    runId: privatePlan.runId,
    sourceGeneratedAt: privatePlan.sourceGeneratedAt,
    planRevisionFingerprint: revisionFingerprint(privatePlan.requiredRevisionId),
    blockCode,
    ...(failure ? { failureStage: failure.failureStage, failure } : {}),
    plan,
  })
}

function eltDocHydrationFailureSummary(
  error: unknown
): StagingEltDocHydrationFailureSummary {
  if (error instanceof StagingEltDocWriteExecutionError) {
    return {
      failureStage: error.stage,
      mutationCallCount: error.mutationCallCount,
      ...(error.providerHttpStatus === null
        ? {}
        : { providerHttpStatus: error.providerHttpStatus }),
      ...(error.providerRequestIndex === null
        ? {}
        : { providerRequestIndex: error.providerRequestIndex }),
      beforeRevisionFingerprint: optionalRevisionFingerprint(error.beforeRevisionId),
      afterRevisionFingerprint: optionalRevisionFingerprint(error.afterRevisionId),
      beforeDriveVersion: error.beforeDriveVersion,
      afterDriveVersion: error.afterDriveVersion,
      rollbackDriveVersion: error.rollbackDriveVersion,
      beforePermissionFingerprint: error.beforePermissionFingerprint,
      afterPermissionFingerprint: error.afterPermissionFingerprint,
      rollbackPermissionFingerprint: error.rollbackPermissionFingerprint,
      certificationStatus: error.certificationStatus,
      rollbackAttempted: error.rollbackAttempted,
      rollbackVerified: error.rollbackVerified,
    }
  }
  return {
    failureStage: stagingEltDocWriteFailureStage(error),
    mutationCallCount: null,
    beforeRevisionFingerprint: null,
    afterRevisionFingerprint: null,
    beforeDriveVersion: null,
    afterDriveVersion: null,
    rollbackDriveVersion: null,
    beforePermissionFingerprint: null,
    afterPermissionFingerprint: null,
    rollbackPermissionFingerprint: null,
    certificationStatus: "ambiguous",
    rollbackAttempted: false,
    rollbackVerified: false,
  }
}

function publicOutcome(outcome: StagingEltDocHydrationOutcome): StagingEltDocHydrationOutcome {
  assertPublicSafe(outcome, "stagingEltDocHydration.publicOutcome")
  return outcome
}

function revisionFingerprint(revisionId: string): string {
  return createPayloadFingerprint(revisionId)
}

function optionalRevisionFingerprint(revisionId: string | null): string | null {
  return revisionId ? revisionFingerprint(revisionId) : null
}

function validIsoOrNull(value: string): string | null {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}
