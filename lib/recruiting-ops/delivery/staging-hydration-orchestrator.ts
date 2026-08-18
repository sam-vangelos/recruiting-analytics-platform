import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import {
  createPseudonymousFingerprint,
  PII_FINGERPRINT_SALT_ENV,
} from "../checksums"
import {
  buildReportingSourceCut,
  replayReportingSourceCut,
  type ReportingSourceCut,
} from "../delivery-source/reporting-source-cut"
import { createLiveGreenhouseHarvestReadClient } from "../extractors/greenhouse-live-read-client"
import { loadGovernedRoster, loadInterviewStageTaxonomy } from "../governed-dimensions-client"
import {
  claimSourceExecution,
  COMPRESSED_SOURCE_PAYLOAD_SCHEMA_VERSION,
  completeSourceExecution,
  readCompletedSourceExecution,
  type SourceExecutionDatabaseClient,
} from "../source-execution-store"
import { createSupabaseSourceExecutionStoreClient } from "../supabase-source-execution-store-client"
import {
  aggregateHydrationOutcome,
  bindHydrationRunSource,
  claimHydrationRun,
  isCertifiedHydrationAttempt,
  prepareHydrationResume,
  startHydrationArtifactAttempt,
  type HydrationArtifactAttempt,
  type HydrationArtifactKey,
  type HydrationAttemptOutcome,
  type HydrationOrchestrationDatabaseClient,
  type HydrationRunMode,
  type HydrationRunOutcome,
} from "./hydration-orchestration-store"
import {
  createGoogleWorkspaceStagingClients,
  waitForStagingDriveVersionAdvance,
  type GoogleWorkspaceStagingClients,
  type StagingMutationCertificationStatus,
} from "./google-workspace-staging-client"
import { createLeaseHeartbeat, type LeaseHeartbeat } from "./lease-heartbeat"
import { runStagingEltDocHydration } from "./staging-elt-doc-hydration-runner"
import {
  runStagingHydration,
  stagingHydrationSourceRequirementsForArtifacts,
  type StagingHydrationArtifactOutcome,
} from "./staging-hydration-runner"
import {
  resolveScheduledHydrationCycle,
  type ScheduledHydrationCycle,
} from "./staging-maintenance-cadence"
import {
  runStagingRecurringSheetLifecycle,
  type RecurringSheetLifecycleArtifactKey,
} from "./staging-recurring-sheet-lifecycle-runner"
import { createSupabaseHydrationOrchestrationClient } from "./supabase-hydration-orchestration-client"
import {
  planProjectedDeliveryRpsValues,
  rpsTrackingRequiredDataRows,
} from "./staging-artifact-value-planner"
import { P1_ELT_DOC_TARGET } from "./p1-artifacts"
import { assertStagingSourceFreshness } from "./staging-write-permit"
import {
  renderPipelineJobWeekRows,
  type PipelineArtifactKey,
} from "./pipeline-sheet-renderer"
import {
  renderWeeklyProgressQuarterClosingOffsets,
  renderWeeklyProgressQuarterOpeningOffsets,
} from "./weekly-progress-renderer"
import { runWeeklyRecruitmentRowLifecycle } from "./weekly-recruitment-row-lifecycle-runner"
import { runWeeklyRecruitmentStagingRollover } from "./weekly-recruitment-rollover-runner"

// A lease is liveness evidence, not a run-duration budget. Claims
// use a short lease renewed every minute by a live process; a crashed process
// stops renewing and the claim recovery in migration 026 reclaims the run
// within minutes instead of wedging every later run behind a dead one-hour
// timer. The lease tolerates nine consecutive missed beats before expiring.
const RUN_LEASE_SECONDS = 600
const SOURCE_LEASE_SECONDS = 600
const LEASE_HEARTBEAT_INTERVAL_MS = 60_000
const RUN_LEASE_NAME = "hydration_run"
const SOURCE_LEASE_NAME = "source_execution"
/** The fixed window used before liveness renewal existed; still correct when the
 *  heartbeat RPCs are absent, because it is exactly the old behavior. */
const PRE_HEARTBEAT_LEASE_SECONDS = 3600

export const ALL_HYDRATION_ARTIFACTS: readonly HydrationArtifactKey[] = [
  "elt_doc",
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

/**
 * One requested artifact's terminal state, carried out of the run so a reader
 * never has to query the ledger to learn which report did not update and why.
 * `outcome: null` means the run ended before this artifact was ever attempted.
 */
export interface HydrationArtifactReport {
  artifactKey: HydrationArtifactKey
  outcome: HydrationAttemptOutcome | null
  certified: boolean
  failureCode: string | null
  failureStage: string | null
}

export interface StagingHydrationOrchestrationResult {
  status: HydrationRunOutcome
  runId: string
  businessDate: string
  sourceExecutionId: string | null
  sourceFingerprint: string | null
  completedArtifacts: readonly HydrationArtifactKey[]
  failedArtifacts: readonly HydrationArtifactKey[]
  artifactOutcomes: readonly HydrationArtifactReport[]
  replayed: boolean
  reason?: "overlap_in_progress" | "execution_failed"
}

interface OrchestrationDependencies {
  orchestrationClient(): HydrationOrchestrationDatabaseClient
  sourceExecutionClient(): SourceExecutionDatabaseClient
  buildSourceCut(input: {
    nowMs: number
    fingerprintKey: string
    artifactKeys: readonly HydrationArtifactKey[]
    reportingWeekFriday?: string
    quarterStart?: string
    calendarValidationNowMs?: number
  }): Promise<ReportingSourceCut>
  createGoogleClients(): Promise<GoogleWorkspaceStagingClients>
  runSheet: typeof runStagingHydration
  runElt: typeof runStagingEltDocHydration
  runRecurringSheetLifecycle: typeof runStagingRecurringSheetLifecycle
  waitForDriveVersionAdvance: typeof waitForStagingDriveVersionAdvance
  planProjectedDeliveryRps: typeof planProjectedDeliveryRpsValues
  runWeeklyRollover: typeof runWeeklyRecruitmentStagingRollover
  runWeeklyRowLifecycle: typeof runWeeklyRecruitmentRowLifecycle
  createHeartbeat(): LeaseHeartbeat
  clock(): number
}

const DEFAULT_DEPENDENCIES: OrchestrationDependencies = {
  orchestrationClient: createSupabaseHydrationOrchestrationClient,
  sourceExecutionClient: createSupabaseSourceExecutionStoreClient,
  buildSourceCut: ({
    nowMs,
    fingerprintKey,
    artifactKeys,
    reportingWeekFriday,
    quarterStart,
    calendarValidationNowMs,
  }) => buildReportingSourceCut({
    createGreenhouseClient: () => createLiveGreenhouseHarvestReadClient({ maxRecordsPerEndpoint: 200_000 }),
    loadRoster: loadGovernedRoster,
    loadStageTaxonomy: loadInterviewStageTaxonomy,
    fingerprintKey,
  }, {
    nowMs,
    recordCap: 200_000,
    reportingWeekFriday,
    quarterStart,
    calendarValidationNowMs,
    requirements: stagingHydrationSourceRequirementsForArtifacts(
      artifactKeys.filter((artifact) => artifact !== "elt_doc")
    ),
  }),
  createGoogleClients: createGoogleWorkspaceStagingClients,
  runSheet: runStagingHydration,
  runElt: runStagingEltDocHydration,
  runRecurringSheetLifecycle: runStagingRecurringSheetLifecycle,
  waitForDriveVersionAdvance: waitForStagingDriveVersionAdvance,
  planProjectedDeliveryRps: planProjectedDeliveryRpsValues,
  runWeeklyRollover: runWeeklyRecruitmentStagingRollover,
  runWeeklyRowLifecycle: runWeeklyRecruitmentRowLifecycle,
  createHeartbeat: () => createLeaseHeartbeat(LEASE_HEARTBEAT_INTERVAL_MS),
  clock: Date.now,
}

export async function runStagingHydrationOrchestration(
  input: {
    mode?: HydrationRunMode
    artifactKeys?: readonly HydrationArtifactKey[]
    nowMs?: number
    env?: Readonly<Record<string, string | undefined>>
    scheduledCycle?: ScheduledHydrationCycle
  } = {},
  dependencies: OrchestrationDependencies = DEFAULT_DEPENDENCIES
): Promise<StagingHydrationOrchestrationResult> {
  const nowMs = input.nowMs ?? Date.now()
  const mode = input.mode ?? "dry_run"
  const requestedArtifactKeys = input.artifactKeys ?? input.scheduledCycle?.dueArtifacts ?? ALL_HYDRATION_ARTIFACTS
  const scheduledCycle = input.scheduledCycle
    ? resolveScheduledHydrationCycle({
        scheduledAt: input.scheduledCycle.scheduledAt,
        eligibleArtifacts: requestedArtifactKeys,
      })
    : undefined
  if (
    input.scheduledCycle && (
      !isDeepStrictEqual(input.scheduledCycle, scheduledCycle) ||
      !isDeepStrictEqual(requestedArtifactKeys, scheduledCycle?.dueArtifacts)
    )
  ) {
    throw new Error("Scheduled hydration input does not match the resolved cycle.")
  }
  const artifactKeys = scheduledCycle?.dueArtifacts ?? requestedArtifactKeys
  const businessDate = scheduledCycle?.businessDate ?? losAngelesBusinessDate(nowMs)
  // Weekly availability helpers intentionally operate on a UTC calendar date.
  // Give them the resolved Pacific business date rather than the raw instant,
  // which is already the next UTC day at the 23:30 Pacific slot.
  const sourceCalendarValidationNowMs = scheduledCycle
    ? Date.parse(`${businessDate}T12:00:00.000Z`)
    : undefined
  const env = input.env ?? process.env
  const executionIdentity = env.CLOUD_RUN_EXECUTION?.trim()
  const ownerToken = executionIdentity
    ? stableExecutionOwnerToken(`${executionIdentity}:${env.CLOUD_RUN_TASK_INDEX?.trim() || "0"}`)
    : randomUUID()
  const orchestrationClient = dependencies.orchestrationClient()
  const claimInput = {
    businessDate,
    mode,
    requestedArtifacts: artifactKeys,
    ownerToken,
    scheduledAt: scheduledCycle?.scheduledAt,
    runNonce: env.RECOPS_HYDRATION_RUN_NONCE,
  }
  const claim = await claimHydrationRun({
    ...claimInput,
    leaseSeconds: RUN_LEASE_SECONDS,
  }, orchestrationClient)

  if (!claim.claimAcquired) {
    if (claim.status === "terminal" && claim.outcome) {
      return {
        status: claim.outcome,
        runId: claim.runId,
        businessDate,
        sourceExecutionId: claim.sourceExecutionId,
        sourceFingerprint: claim.sourceFingerprint,
        completedArtifacts: [],
        failedArtifacts: [],
        artifactOutcomes: [],
        replayed: true,
      }
    }
    return {
      status: "failed",
      runId: claim.runId,
      businessDate,
      sourceExecutionId: claim.sourceExecutionId,
      sourceFingerprint: claim.sourceFingerprint,
      completedArtifacts: [],
      failedArtifacts: [],
      artifactOutcomes: [],
      replayed: true,
      reason: "overlap_in_progress",
    }
  }

  const fingerprintKey = env[PII_FINGERPRINT_SALT_ENV]?.trim()
  if (!fingerprintKey) {
    return failRun({
      runId: claim.runId,
      ownerToken: claim.ownerToken,
      businessDate,
      sourceExecutionId: claim.sourceExecutionId,
      sourceFingerprint: claim.sourceFingerprint,
      artifactKeys,
      replayed: Boolean(claim.sourceExecutionId),
      completedAt: new Date().toISOString(),
      pendingTerminalAttempt: null,
    }, orchestrationClient)
  }

  const heartbeat = dependencies.createHeartbeat()
  const renewRunLease = () => orchestrationClient.heartbeatRun({
    runId: claim.runId,
    ownerToken: claim.ownerToken,
    leaseSeconds: RUN_LEASE_SECONDS,
  })
  // Renew once before any work. Answering "can this lease be renewed at all?"
  // here is what makes the short lease safe to claim: an image that reaches
  // production before migration 030 would otherwise lose an unrenewable lease
  // ten minutes in and fail every artifact.
  let sourceLeaseSeconds = SOURCE_LEASE_SECONDS
  try {
    if (!(await renewRunLease())) {
      return failRun({
        runId: claim.runId,
        ownerToken: claim.ownerToken,
        businessDate,
        sourceExecutionId: claim.sourceExecutionId,
        sourceFingerprint: claim.sourceFingerprint,
        artifactKeys,
        replayed: Boolean(claim.sourceExecutionId),
        completedAt: new Date().toISOString(),
        pendingTerminalAttempt: null,
        failureCode: "hydration_lease_lost",
      }, orchestrationClient)
    }
  } catch (heartbeatUnavailable) {
    console.warn(
      "[recruiting-ops-staging-orchestration] liveness heartbeat unavailable; falling back to the pre-heartbeat lease:",
      safeDiagnostic(heartbeatUnavailable)
    )
    sourceLeaseSeconds = PRE_HEARTBEAT_LEASE_SECONDS
    await claimHydrationRun({
      ...claimInput,
      leaseSeconds: PRE_HEARTBEAT_LEASE_SECONDS,
    }, orchestrationClient)
  }
  heartbeat.register(RUN_LEASE_NAME, renewRunLease)
  let runSourceExecutionId = claim.sourceExecutionId
  let runSourceFingerprint = claim.sourceFingerprint
  let pendingTerminalAttempt: HydrationArtifactAttempt | null = null
  try {
    const sourceClient = dependencies.sourceExecutionClient()
    const source = claim.sourceExecutionId
      ? await replayBoundSource(claim.sourceExecutionId, claim.sourceFingerprint, fingerprintKey, sourceClient)
      : await createAndBindSource({
          runId: claim.runId,
          ownerToken: claim.ownerToken,
          nowMs,
          fingerprintKey,
          artifactKeys,
          reportingWeekFriday: scheduledCycle?.reportingWeekFriday,
          quarterStart: scheduledCycle?.quarterStart,
          calendarValidationNowMs: sourceCalendarValidationNowMs,
          scheduledCycle,
          heartbeat,
          sourceLeaseSeconds,
          sourceClient,
          orchestrationClient,
          buildSourceCut: dependencies.buildSourceCut,
        })
    validateSourceCutCalendar(source.cut, scheduledCycle)
    // Scheduled work must retain its exact cadence clock. Unscheduled
    // acceptance work instead follows the persisted source cut's last complete
    // Fri-Thu week, even when it runs after the next Friday has begun.
    const calendarNowMs = scheduledCycle
      ? Date.parse(scheduledCycle.scheduledAt)
      : Date.parse(`${source.cut.payload.facts.reportingWeekFriday}T12:00:00.000Z`)
    runSourceExecutionId = source.sourceExecutionId
    runSourceFingerprint = source.cut.payloadFingerprint
    const resumed = await prepareHydrationResume(
      claim.runId,
      claim.ownerToken,
      orchestrationClient,
      new Date(dependencies.clock()).toISOString()
    )
    const remainingArtifacts = artifactKeys.filter(
      (artifact) =>
        !resumed.completedArtifacts.has(artifact) &&
        !resumed.nonRetryableArtifacts.has(artifact)
    )
    const clients = remainingArtifacts.length > 0
      ? await dependencies.createGoogleClients()
      : null
    const attempts = [...resumed.attempts]

    for (const artifactKey of remainingArtifacts) {
      // Only the run's own lease governs the right to keep writing. A lost
      // source lease is already fatal where it matters — the completion RPC
      // rejects it — and after the cut is persisted it is simply stale.
      if (heartbeat.lostLeases().has(RUN_LEASE_NAME)) {
        throw new Error("Hydration run lease was lost; halting before the next artifact attempt.")
      }
      const running = await startHydrationArtifactAttempt({
        runId: claim.runId,
        artifactKey,
        sourceExecutionId: source.sourceExecutionId,
        sourceFingerprint: source.cut.payloadFingerprint,
        ownerToken: claim.ownerToken,
        previousAttempts: attempts,
        startedAt: new Date().toISOString(),
      }, orchestrationClient)
      const terminal = await executeArtifact({
        running,
        mode,
        businessDate,
        calendarNowMs,
        cut: source.cut,
        clients: clients!,
        env: input.env,
        clock: dependencies.clock,
        runSheet: dependencies.runSheet,
        runElt: dependencies.runElt,
        runRecurringSheetLifecycle: dependencies.runRecurringSheetLifecycle,
        waitForDriveVersionAdvance: dependencies.waitForDriveVersionAdvance,
        planProjectedDeliveryRps: dependencies.planProjectedDeliveryRps,
        runWeeklyRollover: dependencies.runWeeklyRollover,
        runWeeklyRowLifecycle: dependencies.runWeeklyRowLifecycle,
      })
      pendingTerminalAttempt = terminal
      await persistOrReconcileTerminalAttempt(
        terminal,
        claim.ownerToken,
        orchestrationClient
      )
      pendingTerminalAttempt = null
      attempts.push(terminal)
    }

    const outcome = aggregateHydrationOutcome(attempts, artifactKeys)
    const latest = latestAttemptByArtifact(attempts)
    const completedArtifacts = artifactKeys.filter((artifact) => {
      const value = latest.get(artifact)
      return value ? isCertifiedHydrationAttempt(value) : false
    })
    const failedArtifacts = artifactKeys.filter((artifact) => !completedArtifacts.includes(artifact))
    // Renewal is over once the run is being sealed. A tick landing after
    // finish_run nulls the lease would renew false and log a lost lease on a
    // run that in fact succeeded — misleading in exactly the log someone reads
    // during an incident. stop() is idempotent; the finally below still covers
    // every other exit.
    heartbeat.stop()
    const finished = await orchestrationClient.finishRun({
      runId: claim.runId,
      ownerToken: claim.ownerToken,
      outcome,
      completedAt: new Date().toISOString(),
      publicSummary: {
        sourceExecutionId: source.sourceExecutionId,
        sourceFingerprint: source.cut.payloadFingerprint,
        completedArtifactCount: completedArtifacts.length,
        failedArtifactCount: failedArtifacts.length,
      },
    })
    if (!finished) throw new Error("Hydration run completion lost its lease.")
    return {
      status: outcome,
      runId: claim.runId,
      businessDate,
      sourceExecutionId: source.sourceExecutionId,
      sourceFingerprint: source.cut.payloadFingerprint,
      completedArtifacts,
      failedArtifacts,
      artifactOutcomes: artifactReports(artifactKeys, attempts),
      replayed: Boolean(claim.sourceExecutionId),
    }
  } catch (runError) {
    heartbeat.stop()
    console.error(
      "[recruiting-ops-staging-orchestration] run failed:",
      safeDiagnostic(runError)
    )
    return failRun({
      runId: claim.runId,
      ownerToken: claim.ownerToken,
      businessDate,
      sourceExecutionId: runSourceExecutionId,
      sourceFingerprint: runSourceFingerprint,
      artifactKeys,
      replayed: Boolean(claim.sourceExecutionId),
      completedAt: new Date().toISOString(),
      pendingTerminalAttempt,
      failureCode: runFailureCode(runError),
    }, orchestrationClient)
  } finally {
    heartbeat.stop()
  }
}

export async function runReportingSourceCutProof(
  input: { nowMs?: number; env?: Readonly<Record<string, string | undefined>> } = {},
  dependencies: Pick<OrchestrationDependencies, "sourceExecutionClient" | "buildSourceCut"> = DEFAULT_DEPENDENCIES
): Promise<{
  status: "completed" | "overlap_rejected" | "failed"
  sourceExecutionId: string
  sourceFingerprint: string | null
  sourceCounts: Readonly<Record<string, number>>
}> {
  const nowMs = input.nowMs ?? Date.now()
  const sourceExecutionId = randomUUID()
  const ownerToken = randomUUID()
  const client = dependencies.sourceExecutionClient()
  const claim = await claimSourceExecution({ sourceExecutionId, ownerToken }, client)
  if (claim.outcome === "overlap_rejected") {
    return { status: "overlap_rejected", sourceExecutionId, sourceFingerprint: null, sourceCounts: {} }
  }
  const fingerprintKey = (input.env ?? process.env)[PII_FINGERPRINT_SALT_ENV]?.trim()
  if (!fingerprintKey) {
    await client.fail({ sourceExecutionId, ownerToken, publicDiagnostics: { failure_code: "fingerprint_key_missing" } })
    return { status: "failed", sourceExecutionId, sourceFingerprint: null, sourceCounts: {} }
  }
  try {
    const built = await dependencies.buildSourceCut({
      nowMs,
      fingerprintKey,
      artifactKeys: ALL_HYDRATION_ARTIFACTS,
    })
    const counts = sourceCounts(built)
    const completed = await completeSourceExecution({
      sourceExecutionId,
      ownerToken,
      sourceGeneratedAt: built.payload.facts.generatedAt,
      sourceFingerprint: built.payloadFingerprint,
      sourceCounts: counts,
      publicDiagnostics: { truncation_detected: false },
      sourcePayload: serializedPayload(built),
      sourcePayloadSchemaVersion: COMPRESSED_SOURCE_PAYLOAD_SCHEMA_VERSION,
    }, client)
    replayReportingSourceCut({
      payload: completed.sourcePayload,
      payloadFingerprint: completed.sourceFingerprint!,
      fingerprintKey,
    })
    return { status: "completed", sourceExecutionId, sourceFingerprint: built.payloadFingerprint, sourceCounts: counts }
  } catch (sourceError) {
    const diagnostic = safeDiagnostic(sourceError)
    console.error("[recruiting-ops-staging-orchestration] source cut failed:", diagnostic)
    await client.fail({
      sourceExecutionId,
      ownerToken,
      publicDiagnostics: { failure_code: "source_cut_failed", diagnostic },
    })
    return { status: "failed", sourceExecutionId, sourceFingerprint: null, sourceCounts: {} }
  }
}

async function createAndBindSource(input: {
  runId: string
  ownerToken: string
  nowMs: number
  fingerprintKey: string
  artifactKeys: readonly HydrationArtifactKey[]
  reportingWeekFriday?: string
  quarterStart?: string
  calendarValidationNowMs?: number
  scheduledCycle?: ScheduledHydrationCycle
  heartbeat: LeaseHeartbeat
  sourceLeaseSeconds: number
  sourceClient: SourceExecutionDatabaseClient
  orchestrationClient: HydrationOrchestrationDatabaseClient
  buildSourceCut: OrchestrationDependencies["buildSourceCut"]
}): Promise<{ sourceExecutionId: string; cut: ReportingSourceCut }> {
  // A hydration run owns exactly one source row. Reusing the run UUID lets a
  // task retry adopt a cut that completed just before the process crashed.
  const sourceExecutionId = input.runId
  const claimed = await claimSourceExecution({
    sourceExecutionId,
    ownerToken: input.ownerToken,
    leaseSeconds: input.sourceLeaseSeconds,
  }, input.sourceClient)
  if (claimed.outcome === "overlap_rejected") {
    const completed = await readCompletedSourceExecution(sourceExecutionId, input.sourceClient)
    if (!completed?.sourceFingerprint) {
      throw new Error("Reporting source load overlaps another execution.")
    }
    const cut = replayReportingSourceCut({
      payload: completed.sourcePayload,
      payloadFingerprint: completed.sourceFingerprint,
      fingerprintKey: input.fingerprintKey,
    })
    validateSourceCutCalendar(cut, input.scheduledCycle)
    await bindHydrationRunSource({
      claim: {
        runId: input.runId,
        ownerToken: input.ownerToken,
        claimAcquired: true,
        status: "loading_source",
        outcome: null,
        sourceExecutionId: null,
        sourceFingerprint: null,
        sourceGeneratedAt: null,
      },
      sourceExecutionId,
      sourceFingerprint: cut.payloadFingerprint,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
    }, input.orchestrationClient)
    return { sourceExecutionId, cut }
  }
  const releaseSourceLease = input.heartbeat.register(SOURCE_LEASE_NAME, () =>
    input.sourceClient.heartbeat({
      sourceExecutionId,
      ownerToken: input.ownerToken,
      leaseSeconds: input.sourceLeaseSeconds,
    })
  )
  try {
    const built = await input.buildSourceCut({
      nowMs: input.nowMs,
      fingerprintKey: input.fingerprintKey,
      artifactKeys: input.artifactKeys,
      reportingWeekFriday: input.reportingWeekFriday,
      quarterStart: input.quarterStart,
      calendarValidationNowMs: input.calendarValidationNowMs,
    })
    validateSourceCutCalendar(built, input.scheduledCycle)
    const completed = await completeSourceExecution({
      sourceExecutionId,
      ownerToken: input.ownerToken,
      sourceGeneratedAt: built.payload.facts.generatedAt,
      sourceFingerprint: built.payloadFingerprint,
      sourceCounts: sourceCounts(built),
      publicDiagnostics: { truncation_detected: false },
      sourcePayload: serializedPayload(built),
      sourcePayloadSchemaVersion: COMPRESSED_SOURCE_PAYLOAD_SCHEMA_VERSION,
    }, input.sourceClient)
    const cut = replayReportingSourceCut({
      payload: completed.sourcePayload,
      payloadFingerprint: completed.sourceFingerprint!,
      fingerprintKey: input.fingerprintKey,
    })
    validateSourceCutCalendar(cut, input.scheduledCycle)
    await bindHydrationRunSource({
      claim: {
        runId: input.runId,
        ownerToken: input.ownerToken,
        claimAcquired: true,
        status: "loading_source",
        outcome: null,
        sourceExecutionId: null,
        sourceFingerprint: null,
        sourceGeneratedAt: null,
      },
      sourceExecutionId,
      sourceFingerprint: cut.payloadFingerprint,
      sourceGeneratedAt: cut.payload.facts.generatedAt,
    }, input.orchestrationClient)
    return { sourceExecutionId, cut }
  } catch (error) {
    try {
      await input.sourceClient.fail({
        sourceExecutionId,
        ownerToken: input.ownerToken,
        publicDiagnostics: { failure_code: "source_cut_failed" },
      })
    } catch {
      // A completed source is immutable; a later binding failure must not rewrite it.
    }
    throw error
  } finally {
    releaseSourceLease()
  }
}

async function replayBoundSource(
  sourceExecutionId: string,
  expectedFingerprint: string | null,
  fingerprintKey: string,
  client: SourceExecutionDatabaseClient
): Promise<{ sourceExecutionId: string; cut: ReportingSourceCut }> {
  const completed = await readCompletedSourceExecution(sourceExecutionId, client)
  if (!completed || !completed.sourceFingerprint || completed.sourceFingerprint !== expectedFingerprint) {
    throw new Error("Hydration run source identity is unavailable or changed.")
  }
  return {
    sourceExecutionId,
    cut: replayReportingSourceCut({
      payload: completed.sourcePayload,
      payloadFingerprint: completed.sourceFingerprint,
      fingerprintKey,
    }),
  }
}

/**
 * The durable, machine-readable name for why a run ended. Two failures need
 * different operator moves and must not both read execution_failed: a rejected
 * replay means the bound source cut can never be replayed by this image, so
 * only a fresh run under a new nonce recovers it, while a lost lease means a
 * successor already owns the work and this process must simply stand down.
 */
function runFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith("Reporting source cut replay rejected")) return "source_replay_rejected"
  if (message.startsWith("Hydration run lease was lost")) return "hydration_lease_lost"
  return "execution_failed"
}

/** Error text only. Source payloads and identifiers never reach a log. */
function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/g, " ").slice(0, 300)
}

function validateSourceCutCalendar(
  cut: ReportingSourceCut,
  cycle: ScheduledHydrationCycle | undefined
): void {
  if (!cycle) return
  if (
    cut.payload.facts.reportingWeekFriday !== cycle.reportingWeekFriday ||
    cut.payload.facts.quarterStart !== cycle.quarterStart
  ) {
    throw new Error("Scheduled hydration source cut calendar does not match the claimed cycle.")
  }
}

async function executeArtifact(input: {
  running: HydrationArtifactAttempt
  mode: HydrationRunMode
  businessDate: string
  calendarNowMs: number
  cut: ReportingSourceCut
  clients: GoogleWorkspaceStagingClients
  env?: Readonly<Record<string, string | undefined>>
  clock: () => number
  runSheet: typeof runStagingHydration
  runElt: typeof runStagingEltDocHydration
  runRecurringSheetLifecycle: typeof runStagingRecurringSheetLifecycle
  waitForDriveVersionAdvance: typeof waitForStagingDriveVersionAdvance
  planProjectedDeliveryRps: typeof planProjectedDeliveryRpsValues
  runWeeklyRollover: typeof runWeeklyRecruitmentStagingRollover
  runWeeklyRowLifecycle: typeof runWeeklyRecruitmentRowLifecycle
}): Promise<HydrationArtifactAttempt> {
  try {
    if (input.running.artifactKey === "elt_doc") {
      const outcome = await input.runElt({
        mode: input.mode,
        env: input.env,
        clients: input.clients,
        snapshot: input.cut.payload.eltSnapshot,
        nowMs: input.clock(),
        currentTimeMs: input.clock,
      })
      const attemptOutcome = outcome.status === "blocked"
        ? failedAttemptOutcome(outcome.failure)
        : artifactOutcome(outcome.status)
      return terminalAttempt(input.running, {
        outcome: attemptOutcome,
        planFingerprint: outcome.plan?.payloadFingerprint ?? null,
        mutationCallCount: outcome.write
          ? outcome.write.mutationCallCount
          : outcome.failure
            ? outcome.failure.mutationCallCount
            : 0,
        versionBefore: outcome.write?.beforeRevisionFingerprint
          ?? outcome.failure?.beforeRevisionFingerprint
          ?? outcome.planRevisionFingerprint
          ?? null,
        versionAfter: outcome.write?.afterRevisionFingerprint
          ?? outcome.failure?.afterRevisionFingerprint
          ?? null,
        certificationEvidence: {
          artifact_status: outcome.status,
          evidence_contract: "elt_fact_table_v1",
          pii_policy: P1_ELT_DOC_TARGET.piiPolicy,
          acl_policy: P1_ELT_DOC_TARGET.aclRule,
          hydration_mode: outcome.mode,
          block_code: outcome.blockCode ?? null,
          mutation_scope: outcome.plan?.mutationScope ?? "weekly_fact_table",
          plan_status: outcome.plan?.status ?? null,
          plan_action: outcome.plan?.action ?? null,
          dry_run_verified: outcome.status === "dry_run",
          preimage_fingerprint: outcome.write?.preimageFingerprint
            ?? outcome.plan?.currentBlockFingerprint
            ?? null,
          drive_version_before: outcome.write?.beforeDriveVersion
            ?? outcome.failure?.beforeDriveVersion
            ?? null,
          drive_version_after: outcome.write?.afterDriveVersion
            ?? outcome.failure?.afterDriveVersion
            ?? null,
          rollback_drive_version: outcome.failure?.rollbackDriveVersion ?? null,
          permission_fingerprint: outcome.write?.beforePermissionFingerprint
            ?? outcome.failure?.beforePermissionFingerprint
            ?? null,
          permission_fingerprint_after: outcome.write?.afterPermissionFingerprint
            ?? outcome.failure?.afterPermissionFingerprint
            ?? null,
          rollback_permission_fingerprint:
            outcome.failure?.rollbackPermissionFingerprint ?? null,
          outside_content_fingerprint: outcome.write?.afterOutsideContentFingerprint
            ?? outcome.plan?.outsideContentFingerprint
            ?? null,
          revision_before_fingerprint: outcome.write?.beforeRevisionFingerprint
            ?? outcome.failure?.beforeRevisionFingerprint
            ?? outcome.planRevisionFingerprint
            ?? null,
          revision_after_fingerprint: outcome.write?.afterRevisionFingerprint
            ?? outcome.failure?.afterRevisionFingerprint
            ?? null,
          revision_guard_present: outcome.plan?.revisionGuardPresent ?? false,
          reporting_week: outcome.plan?.reportingWeek ?? null,
          snapshot_run_id: outcome.plan?.snapshotRunId ?? null,
          snapshot_mode: outcome.plan?.snapshotMode ?? null,
          source_generated_at: outcome.sourceGeneratedAt,
          template_hash: outcome.plan?.templateHash ?? null,
          rollback_request_count: outcome.write?.rollbackRequestCount ?? 0,
          rollback_attempted: outcome.failure?.rollbackAttempted
            ?? outcome.write?.rollbackAttempted
            ?? false,
          rollback_verified: outcome.failure?.rollbackVerified ?? false,
          ...(outcome.failure?.providerHttpStatus === undefined
            ? {}
            : { provider_http_status: outcome.failure.providerHttpStatus }),
          ...(outcome.failure?.providerRequestIndex === undefined
            ? {}
            : { provider_request_index: outcome.failure.providerRequestIndex }),
          certification_status: outcome.failure?.certificationStatus
            ?? (outcome.write?.status === "written"
              ? "postimage_verified"
              : outcome.write?.status === "no_change"
                ? "preimage_verified"
                : outcome.status === "dry_run"
                  ? "dry_run_verified"
                  : "not_attempted"),
        },
        failureCode: outcome.status === "blocked" ? outcome.blockCode ?? "blocked" : null,
        failureStage: outcome.failure?.failureStage ?? outcome.failureStage ?? null,
      })
    }

    let rollover: Awaited<ReturnType<typeof runWeeklyRecruitmentStagingRollover>> | null = null
    let recurring: Awaited<ReturnType<typeof runStagingRecurringSheetLifecycle>> | null = null
    if (isRecurringSheetLifecycleArtifact(input.running.artifactKey)) {
      const weeklyProgressOffsets = input.running.artifactKey === "weekly_progress"
        ? renderWeeklyProgressQuarterOpeningOffsets({
            reportingWeekFriday: input.cut.payload.facts.reportingWeekFriday,
            candidateEvents: input.cut.payload.facts.candidateEvents,
            offers: input.cut.payload.facts.offers,
            scorecards: input.cut.payload.facts.scorecards,
          })
        : null
      const weeklyProgressClosingOffsets = input.running.artifactKey === "weekly_progress"
        ? renderWeeklyProgressQuarterClosingOffsets({
            reportingWeekFriday: input.cut.payload.facts.reportingWeekFriday,
            candidateEvents: input.cut.payload.facts.candidateEvents,
            offers: input.cut.payload.facts.offers,
            scorecards: input.cut.payload.facts.scorecards,
          })
        : null
      recurring = await input.runRecurringSheetLifecycle({
        artifactKey: input.running.artifactKey,
        clients: input.clients,
        reportingWeekFriday: input.cut.payload.facts.reportingWeekFriday,
        mode: input.mode,
        env: input.env,
        nowMs: input.calendarNowMs,
        sourceGeneratedAt: input.cut.payload.facts.generatedAt,
        currentTimeMs: input.clock,
        ...(input.running.artifactKey === "delivery_roles_rps"
          ? { deliveryRpsReportDate: input.businessDate }
          : {}),
        ...(isPipelineArtifact(input.running.artifactKey)
          ? {
              pipelineJobWeekRows: renderPipelineJobWeekRows({
                artifactKey: input.running.artifactKey,
                reportingWeekFriday: input.cut.payload.facts.reportingWeekFriday,
                rows: input.cut.payload.facts.candidateEvents,
                jobOpenDateByReq: new Map(
                  input.cut.payload.facts.reqWeeks.map((row) => [
                    row.requisitionId,
                    row.earliestOpeningDate,
                  ])
                ),
              }).map((row) => row.cells),
            }
          : {}),
        ...(input.running.artifactKey === "rps_tracking"
          ? {
              requiredDataRows: rpsTrackingRequiredDataRows({
                facts: input.cut.payload.facts,
                roster: input.cut.payload.roster,
              }),
            }
          : {}),
        ...(input.running.artifactKey === "final_offer"
          ? { quarterStart: input.cut.payload.facts.quarterStart }
          : {}),
        ...(weeklyProgressOffsets
          ? {
              weeklyProgressQuarterOpeningOffsets: [
                { sheetId: 0, rowOffsets: weeklyProgressOffsets.code_rl },
                { sheetId: 242118538, rowOffsets: weeklyProgressOffsets.fde_pe },
                { sheetId: 1450892249, rowOffsets: weeklyProgressOffsets.brazil_colombia },
              ],
            }
          : {}),
        ...(weeklyProgressClosingOffsets
          ? {
              weeklyProgressQuarterClosingOffsets: [
                { sheetId: 0, rowOffsets: weeklyProgressClosingOffsets.code_rl },
                { sheetId: 242118538, rowOffsets: weeklyProgressClosingOffsets.fde_pe },
                { sheetId: 1450892249, rowOffsets: weeklyProgressClosingOffsets.brazil_colombia },
              ],
            }
          : {}),
      })
      if (recurring.outcome.status === "blocked") {
        const failure = recurring.outcome.failure
        return terminalAttempt(input.running, {
          outcome: failedAttemptOutcome(failure),
          planFingerprint: null,
          mutationCallCount: recurring.outcome.write
            ? recurring.outcome.write.mutationCallCount
            : failure
              ? failure.mutationCallCount
              : 0,
          versionBefore: recurring.outcome.write?.beforeDriveVersion
            ?? failure?.beforeDriveVersion
            ?? null,
          versionAfter: recurring.outcome.write?.afterDriveVersion
            ?? failure?.afterDriveVersion
            ?? null,
          certificationEvidence: {
            recurring_lifecycle_status: "blocked",
            certification_status: failure?.certificationStatus ?? "not_attempted",
          },
          failureCode: "recurring_sheet_lifecycle_blocked",
          failureStage: failure?.failureStage ?? null,
        })
      }
      if (
        input.mode === "dry_run" &&
        recurring.outcome.status === "dry_run" &&
        recurring.outcome.plan?.status === "planned"
      ) {
        const projectedDryRun = recurring.outcome.plan.projectedDryRun
        if (input.running.artifactKey === "delivery_roles_rps" && projectedDryRun) {
          assertStagingSourceFreshness(input.cut.payload.facts.generatedAt, input.clock())
          const projected = await input.planProjectedDeliveryRps({
            runId: input.running.runId,
            facts: input.cut.payload.facts,
            roster: input.cut.payload.roster,
            clients: input.clients,
            deliveryRpsReportDate: input.businessDate,
            target: projectedDryRun.target,
            structure: projectedDryRun.structure,
          })
          return terminalAttempt(input.running, {
            outcome: "no_change",
            planFingerprint: projected.plan.planFingerprint,
            mutationCallCount: 0,
            versionBefore: projectedDryRun.structure.observedDriveVersion,
            versionAfter: null,
            certificationEvidence: {
              artifact_status: "projected_dry_run",
              lifecycle: "recurring",
              lifecycle_plan_status: "planned",
              projection_certification: "exact_preimage_plus_deterministic_requests",
              postimage_observed: false,
              target_absent_observed: true,
              observed_drive_version: projectedDryRun.structure.observedDriveVersion,
              drive_version_stable: true,
              normalization_id: projectedDryRun.structure.normalizationId,
              normalization_fingerprint: projectedDryRun.structure.normalizationFingerprint,
              observed_structure_fingerprint: projectedDryRun.structure.observedStructureFingerprint,
              expected_after_state_fingerprint: projectedDryRun.structure.expectedAfterStateFingerprint,
              forward_requests_fingerprint: projectedDryRun.structure.forwardRequestsFingerprint,
              rollback_requests_fingerprint: projectedDryRun.structure.rollbackRequestsFingerprint,
              target_sheet_id: projectedDryRun.target.targetSheetId,
              target_sheet_title: projectedDryRun.target.targetSheetTitle,
              projected_preimage_fingerprint: projected.publicSummary.projectedPreimageFingerprint,
              desired_payload_fingerprint: projected.publicSummary.desiredPayloadFingerprint,
              format_fingerprint: projected.publicSummary.formatFingerprint,
              range_count: projected.publicSummary.rangeCount,
              projected_changed_range_count: projected.publicSummary.projectedChangedRangeCount,
              projected_value_no_op: projected.publicSummary.projectedValueNoOp,
              value_plan_status: "projected",
            },
            failureCode: null,
            failureStage: null,
          })
        }
        return deferredStructureDryRunAttempt(
          input.running,
          "recurring",
          recurring.outcome.plan,
          input.env
        )
      }
    }
    if (input.running.artifactKey === "weekly_recruitment") {
      rollover = await input.runWeeklyRollover({
        clients: input.clients,
        reportingWeekFriday: input.cut.payload.facts.reportingWeekFriday,
        mode: input.mode,
        env: input.env,
        nowMs: input.calendarNowMs,
        currentTimeMs: input.clock,
      })
      if (rollover.outcomes[0].status === "blocked") {
        const failure = rollover.outcomes[0].failure
        return terminalAttempt(input.running, {
          outcome: failedAttemptOutcome(failure),
          planFingerprint: null,
          mutationCallCount: rollover.outcomes[0].write
            ? rollover.outcomes[0].write.mutationCallCount
            : failure
              ? failure.mutationCallCount
              : 0,
          versionBefore: rollover.outcomes[0].write?.beforeDriveVersion
            ?? failure?.beforeDriveVersion
            ?? null,
          versionAfter: rollover.outcomes[0].write?.afterDriveVersion
            ?? failure?.afterDriveVersion
            ?? null,
          certificationEvidence: {
            rollover_status: "blocked",
            certification_status: failure?.certificationStatus ?? "not_attempted",
          },
          failureCode: "weekly_rollover_blocked",
          failureStage: failure?.failureStage ?? null,
        })
      }
      if (
        input.mode === "dry_run" &&
        rollover.outcomes[0].status === "dry_run" &&
        rollover.outcomes[0].plan?.status === "planned"
      ) {
        return deferredStructureDryRunAttempt(
          input.running,
          "weekly_rollover",
          rollover.outcomes[0].plan,
          input.env
        )
      }
    }

    const sheetArtifactKey = input.running.artifactKey
    const runSheetArtifact = async (): Promise<StagingHydrationArtifactOutcome> => {
      const outcome = await input.runSheet({
        artifactKeys: [sheetArtifactKey],
        mode: input.mode,
        env: input.env,
        clients: input.clients,
        facts: input.cut.payload.facts,
        roster: input.cut.payload.roster,
        runId: input.running.runId,
        ...(sheetArtifactKey === "delivery_roles_rps"
          ? { deliveryRpsReportDate: input.businessDate }
          : {}),
        nowMs: input.clock(),
        currentTimeMs: input.clock,
      })
      const artifact = outcome.artifactOutcomes[0]
      if (!artifact || artifact.artifactKey !== sheetArtifactKey) {
        throw new Error("Hydration sheet runner returned no matching artifact outcome.")
      }
      return artifact
    }

    let artifact = await runSheetArtifact()
    let valuePreimageReplanCount = 0
    const lifecycleVersion = recurring?.outcome.write?.afterDriveVersion
      ?? rollover?.outcomes[0].write?.afterDriveVersion
    const lifecycleNormalized = recurring?.outcome.status === "normalized"
      || rollover?.outcomes[0].status === "normalized"
    if (
      shouldReplanAfterRecurringPublication(artifact, {
        normalized: lifecycleNormalized,
        afterDriveVersion: lifecycleVersion,
      }) &&
      typeof lifecycleVersion === "string"
    ) {
      const settledVersion = await input.waitForDriveVersionAdvance({
        artifactKey: sheetArtifactKey,
        clients: input.clients,
        minimumDriveVersionExclusive: lifecycleVersion,
      }).catch(() => null)
      if (settledVersion) {
        artifact = await runSheetArtifact()
        valuePreimageReplanCount = 1
      }
    }
    let rowLifecycle: Awaited<ReturnType<typeof runWeeklyRecruitmentRowLifecycle>> | null = null
    if (input.running.artifactKey === "weekly_recruitment" && artifact.status !== "blocked") {
      rowLifecycle = await input.runWeeklyRowLifecycle({
        clients: input.clients,
        reportingWeekFriday: input.cut.payload.facts.reportingWeekFriday,
        mode: input.mode,
        env: input.env,
        nowMs: input.calendarNowMs,
        currentTimeMs: input.clock,
      })
    }
    const rolloverOutcome = rollover?.outcomes[0]
    const rowOutcome = rowLifecycle?.outcomes[0]
    const weeklyBlocked = rowOutcome?.status === "blocked"
    const activeFailure = weeklyBlocked
      ? rowOutcome?.failure
      : artifact.status === "blocked"
        ? artifact.failure
        : undefined
    const attemptOutcome = artifactOutcome(artifact.status)
    return terminalAttempt(input.running, {
      outcome: weeklyBlocked || artifact.status === "blocked"
        ? failedAttemptOutcome(activeFailure)
        : combinedLifecycleOutcome(attemptOutcome, rolloverOutcome, rowOutcome, recurring?.outcome),
      planFingerprint: artifact.plan?.payloadFingerprint ?? null,
      mutationCallCount: sumMutationCallCounts([
        mutationCallCountFor(rolloverOutcome),
        mutationCallCountFor(recurring?.outcome),
        mutationCallCountFor(artifact),
        mutationCallCountFor(rowOutcome),
      ]),
      versionBefore: rolloverOutcome?.write?.beforeDriveVersion
        ?? rolloverOutcome?.failure?.beforeDriveVersion
        ?? recurring?.outcome.write?.beforeDriveVersion
        ?? recurring?.outcome.failure?.beforeDriveVersion
        ?? artifact.write?.beforeDriveVersion
        ?? artifact.failure?.beforeDriveVersion
        ?? rowOutcome?.write?.beforeDriveVersion
        ?? rowOutcome?.failure?.beforeDriveVersion
        ?? null,
      versionAfter: rowOutcome?.write?.afterDriveVersion
        ?? rowOutcome?.failure?.afterDriveVersion
        ?? artifact.write?.afterDriveVersion
        ?? artifact.failure?.afterDriveVersion
        ?? recurring?.outcome.write?.afterDriveVersion
        ?? recurring?.outcome.failure?.afterDriveVersion
        ?? rolloverOutcome?.write?.afterDriveVersion
        ?? rolloverOutcome?.failure?.afterDriveVersion
        ?? null,
      certificationEvidence: {
        artifact_status: artifact.status,
        structure_certification: artifact.write?.structureCertification ?? null,
        after_structure_hash: artifact.write?.afterStructureHash ?? artifact.plan?.structureHash ?? null,
        rollover_status: rolloverOutcome?.status ?? null,
        row_lifecycle_status: rowOutcome?.status ?? null,
        recurring_lifecycle_status: recurring?.outcome.status ?? null,
        value_preimage_replan_count: valuePreimageReplanCount,
        certification_status: activeFailure?.certificationStatus ?? null,
      },
      failureCode: weeklyBlocked
        ? "weekly_row_lifecycle_blocked"
        : artifact.status === "blocked" ? "blocked" : null,
      failureStage: activeFailure?.failureStage ?? null,
    })
  } catch (artifactError) {
    console.error(
      `[recruiting-ops-staging-orchestration] ${input.running.artifactKey} execution failed:`,
      safeDiagnostic(artifactError)
    )
    return terminalAttempt(input.running, {
      outcome: "failed",
      planFingerprint: null,
      mutationCallCount: null,
      versionBefore: null,
      versionAfter: null,
      certificationEvidence: null,
      failureCode: "artifact_execution_failed",
      failureStage: null,
    })
  }
}

function shouldReplanAfterRecurringPublication(
  artifact: StagingHydrationArtifactOutcome,
  lifecycle: { normalized: boolean; afterDriveVersion: string | undefined }
): boolean {
  const failure = artifact.failure
  const lifecycleVersion = lifecycle.afterDriveVersion
  return lifecycle.normalized
    && artifact.status === "blocked"
    && failure?.failureStage === "preimage_validation"
    && failure.mutationCallCount === 0
    && failure.certificationStatus === "not_attempted"
    && failure.afterDriveVersion === null
    && typeof lifecycleVersion === "string"
    && lifecycleVersion.length > 0
    && failure.beforeDriveVersion === lifecycleVersion
}

function deferredStructureDryRunAttempt(
  running: HydrationArtifactAttempt,
  lifecycle: "recurring" | "weekly_rollover",
  plan: {
    normalizationId: string
    forwardRequestCount: number
    rollbackRequestCount: number
    structureFingerprint: string
    driveVersion: string
  },
  env: Readonly<Record<string, string | undefined>> | undefined
): HydrationArtifactAttempt {
  const key = (env?.[PII_FINGERPRINT_SALT_ENV] ?? process.env[PII_FINGERPRINT_SALT_ENV])?.trim()
  if (!key) throw new Error("Deferred structure plan fingerprint key is unavailable.")
  const planFingerprint = createPseudonymousFingerprint(
    {
      artifactKey: running.artifactKey,
      sourceFingerprint: running.sourceFingerprint,
      lifecycle,
      plan,
    },
    { key, context: "recops:staging-hydration:deferred-structure-plan" }
  )
  return terminalAttempt(running, {
    outcome: "failed",
    planFingerprint,
    mutationCallCount: 0,
    versionBefore: plan.driveVersion,
    versionAfter: null,
    certificationEvidence: {
      artifact_status: "deferred_pending_structure",
      lifecycle,
      lifecycle_plan_status: "planned",
      normalization_id: plan.normalizationId,
      forward_request_count: plan.forwardRequestCount,
      rollback_request_count: plan.rollbackRequestCount,
      observed_structure_fingerprint: plan.structureFingerprint,
      value_plan_status: "deferred_pending_structure",
    },
    failureCode: "value_plan_deferred_pending_structure",
    failureStage: "planning",
  })
}

function terminalAttempt(
  running: HydrationArtifactAttempt,
  result: {
    outcome: HydrationAttemptOutcome
    planFingerprint: string | null
    mutationCallCount: number | null
    versionBefore: string | null
    versionAfter: string | null
    certificationEvidence: Readonly<Record<string, unknown>> | null
    failureCode: string | null
    failureStage: string | null
  }
): HydrationArtifactAttempt {
  return {
    ...running,
    ...result,
    status: "terminal",
    completedAt: new Date().toISOString(),
  }
}

function artifactOutcome(status: "dry_run" | "no_change" | "written" | "blocked"): HydrationAttemptOutcome {
  if (status === "written") return "written"
  if (status === "dry_run" || status === "no_change") return "no_change"
  return "failed"
}

interface MutationFailureEvidence {
  failureStage: string
  mutationCallCount: number | null
  certificationStatus: StagingMutationCertificationStatus
}

function failedAttemptOutcome(
  failure: MutationFailureEvidence | undefined
): HydrationAttemptOutcome {
  if (!failure) return "failed"
  return failure.certificationStatus === "not_attempted"
    || failure.certificationStatus === "preimage_verified"
    ? "failed"
    : "certification_failed"
}

function mutationCallCountFor(
  outcome: {
    write?: { mutationCallCount: number }
    failure?: { mutationCallCount: number | null }
  } | null | undefined
): number | null {
  if (outcome?.write) return outcome.write.mutationCallCount
  if (outcome?.failure) return outcome.failure.mutationCallCount
  return 0
}

function sumMutationCallCounts(counts: readonly (number | null)[]): number | null {
  if (counts.some((count) => count === null)) return null
  return counts.reduce<number>((total, count) => total + (count as number), 0)
}

function combinedLifecycleOutcome(
  valueOutcome: HydrationAttemptOutcome,
  rollover: Awaited<ReturnType<typeof runWeeklyRecruitmentStagingRollover>>["outcomes"][0] | undefined,
  rowLifecycle: Awaited<ReturnType<typeof runWeeklyRecruitmentRowLifecycle>>["outcomes"][0] | undefined,
  recurring: Awaited<ReturnType<typeof runStagingRecurringSheetLifecycle>>["outcome"] | undefined
): HydrationAttemptOutcome {
  if (valueOutcome === "failed") return "failed"
  if (
    valueOutcome === "written"
    || rollover?.status === "normalized"
    || rowLifecycle?.status === "normalized"
    || recurring?.status === "normalized"
  ) return "written"
  return "no_change"
}

function isRecurringSheetLifecycleArtifact(
  artifactKey: HydrationArtifactKey
): artifactKey is RecurringSheetLifecycleArtifactKey {
  return [
    "weekly_progress",
    "delivery_roles_rps",
    "rps_tracking",
    "final_offer",
    "pipeline_890",
    "pipeline_907",
    "pipeline_1026_1027",
    "pipeline_1118_1119",
  ].includes(artifactKey)
}

function isPipelineArtifact(
  artifactKey: HydrationArtifactKey
): artifactKey is PipelineArtifactKey {
  return [
    "pipeline_890",
    "pipeline_907",
    "pipeline_1026_1027",
    "pipeline_1118_1119",
  ].includes(artifactKey)
}

function serializedPayload(cut: ReportingSourceCut): Record<string, unknown> {
  return JSON.parse(JSON.stringify(cut.payload)) as Record<string, unknown>
}

function sourceCounts(cut: ReportingSourceCut): Record<string, number> {
  return {
    candidateEvents: cut.payload.facts.candidateEvents.length,
    offers: cut.payload.facts.offers.length,
    scorecards: cut.payload.facts.scorecards.length,
    reqWeeks: cut.payload.facts.reqWeeks.length,
    eltReqRows: cut.payload.eltSnapshot.req_rows.length,
    eltHires: cut.payload.eltSnapshot.hires.length,
  }
}

function artifactReports(
  artifactKeys: readonly HydrationArtifactKey[],
  attempts: readonly HydrationArtifactAttempt[]
): readonly HydrationArtifactReport[] {
  const latest = latestAttemptByArtifact(attempts)
  return artifactKeys.map((artifactKey) => {
    const attempt = latest.get(artifactKey)
    return {
      artifactKey,
      outcome: attempt?.outcome ?? null,
      certified: attempt ? isCertifiedHydrationAttempt(attempt) : false,
      failureCode: attempt?.failureCode ?? null,
      failureStage: attempt?.failureStage ?? null,
    }
  })
}

function latestAttemptByArtifact(
  attempts: readonly HydrationArtifactAttempt[]
): Map<HydrationArtifactKey, HydrationArtifactAttempt> {
  const latest = new Map<HydrationArtifactKey, HydrationArtifactAttempt>()
  for (const attempt of attempts) {
    const current = latest.get(attempt.artifactKey)
    if (!current || attempt.attemptNo > current.attemptNo) latest.set(attempt.artifactKey, attempt)
  }
  return latest
}

async function persistOrReconcileTerminalAttempt(
  terminal: HydrationArtifactAttempt,
  ownerToken: string,
  client: HydrationOrchestrationDatabaseClient
): Promise<void> {
  if (terminal.status !== "terminal" || !terminal.outcome || !terminal.completedAt) {
    throw new Error("Hydration attempt completion requires one terminal local outcome.")
  }
  if (
    terminal.artifactKey === "elt_doc"
    && (terminal.outcome === "written" || terminal.outcome === "no_change")
    && !isCertifiedHydrationAttempt(terminal)
  ) {
    throw new Error("ELT hydration attempt lacks complete durable certification evidence.")
  }
  const completion = {
    attemptId: terminal.attemptId,
    runId: terminal.runId,
    ownerToken,
    outcome: terminal.outcome,
    completedAt: terminal.completedAt,
    planFingerprint: terminal.planFingerprint,
    mutationCallCount: terminal.mutationCallCount,
    versionBefore: terminal.versionBefore,
    versionAfter: terminal.versionAfter,
    certificationEvidence: terminal.certificationEvidence,
    failureCode: terminal.failureCode,
    failureStage: terminal.failureStage,
  }

  try {
    if (await client.finishAttempt(completion)) return
  } catch {
    // The RPC may have committed before its response was lost. Reconcile the
    // exact durable row before deciding whether one retry is safe.
  }

  const firstRead = await client.listAttempts(terminal.runId)
  const stored = firstRead.find((attempt) => attempt.attemptId === terminal.attemptId)
  if (stored && terminalAttemptEvidenceMatches(stored, terminal)) return
  if (!stored || stored.status !== "running") {
    throw new Error("Hydration artifact attempt has conflicting durable evidence.")
  }

  if (await client.finishAttempt(completion)) return
  const secondRead = await client.listAttempts(terminal.runId)
  const retried = secondRead.find((attempt) => attempt.attemptId === terminal.attemptId)
  if (retried && terminalAttemptEvidenceMatches(retried, terminal)) return
  throw new Error("Hydration artifact attempt completion could not be persisted.")
}

function terminalAttemptEvidenceMatches(
  stored: HydrationArtifactAttempt,
  expected: HydrationArtifactAttempt
): boolean {
  return stored.status === "terminal"
    && stored.outcome === expected.outcome
    && stored.planFingerprint === expected.planFingerprint
    && stored.mutationCallCount === expected.mutationCallCount
    && stored.versionBefore === expected.versionBefore
    && stored.versionAfter === expected.versionAfter
    && isDeepStrictEqual(stored.certificationEvidence, expected.certificationEvidence)
    && stored.failureCode === expected.failureCode
    && stored.failureStage === expected.failureStage
}

async function failRun(
  input: {
    runId: string
    ownerToken: string
    businessDate: string
    sourceExecutionId: string | null
    sourceFingerprint: string | null
    artifactKeys: readonly HydrationArtifactKey[]
    replayed: boolean
    completedAt: string
    pendingTerminalAttempt: HydrationArtifactAttempt | null
    failureCode?: string
  },
  client: HydrationOrchestrationDatabaseClient
): Promise<StagingHydrationOrchestrationResult> {
  let outcome: HydrationRunOutcome = "failed"
  let completedArtifacts: readonly HydrationArtifactKey[] = []
  let failedArtifacts: readonly HydrationArtifactKey[] = [...input.artifactKeys]
  // A failing run still owes the reader a per-artifact account. If even the
  // ledger read below fails, every requested artifact is reported unattempted
  // rather than silently omitted.
  let artifactOutcomes = artifactReports(input.artifactKeys, [])
  let persisted = false
  try {
    if (input.pendingTerminalAttempt) {
      await persistOrReconcileTerminalAttempt(
        input.pendingTerminalAttempt,
        input.ownerToken,
        client
      )
    }
    await client.timeoutRunningAttempts({
      runId: input.runId,
      ownerToken: input.ownerToken,
      completedAt: input.completedAt,
    })
    const attempts = await client.listAttempts(input.runId)
    outcome = aggregateHydrationOutcome(attempts, input.artifactKeys)
    const latest = latestAttemptByArtifact(attempts)
    completedArtifacts = input.artifactKeys.filter((artifact) => {
      const value = latest.get(artifact)
      return value ? isCertifiedHydrationAttempt(value) : false
    })
    failedArtifacts = input.artifactKeys.filter((artifact) => !completedArtifacts.includes(artifact))
    artifactOutcomes = artifactReports(input.artifactKeys, attempts)
    const finished = await client.finishRun({
      runId: input.runId,
      ownerToken: input.ownerToken,
      outcome,
      completedAt: input.completedAt,
      publicSummary: {
        failure_code: input.failureCode ?? "execution_failed",
        sourceExecutionId: input.sourceExecutionId,
        sourceFingerprint: input.sourceFingerprint,
        completedArtifactCount: completedArtifacts.length,
        failedArtifactCount: failedArtifacts.length,
      },
    })
    if (!finished) throw new Error("Hydration failure completion lost its lease.")
    persisted = true
  } catch (persistError) {
    // The caller still returns failure; a hard persistence error makes the Job retry.
    console.error("[recruiting-ops-staging-orchestration] failure persistence error:", safeDiagnostic(persistError))
  }
  const status = persisted ? outcome : "failed"
  return {
    status,
    runId: input.runId,
    businessDate: input.businessDate,
    sourceExecutionId: input.sourceExecutionId,
    sourceFingerprint: input.sourceFingerprint,
    completedArtifacts,
    failedArtifacts,
    artifactOutcomes,
    replayed: input.replayed,
    ...(status === "succeeded" || status === "no_change"
      ? {}
      : { reason: "execution_failed" as const }),
  }
}

export function losAngelesBusinessDate(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs))
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

function stableExecutionOwnerToken(executionIdentity: string): string {
  const bytes = createHash("sha256")
    .update("recruiting-ops-cloud-run-execution-owner:v1\0")
    .update(executionIdentity)
    .digest()
    .subarray(0, 16)
  // RFC 4122 variant plus a deterministic version-5 marker.
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
