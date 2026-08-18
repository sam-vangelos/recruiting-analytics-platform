import { randomUUID } from "node:crypto"

import { eltReportingFriday, fridayWeekLabels } from "../exec-definitions"
import type { StagingSheetArtifactKey } from "./staging-artifact-value-planner"
import {
  deliveryRpsDatedTabTitle,
  deliveryRpsTargetSheetId,
} from "./staging-structural-normalization"

export type HydrationArtifactKey = "elt_doc" | StagingSheetArtifactKey
export type HydrationRunMode = "dry_run" | "write"
export type HydrationRunOutcome = "succeeded" | "no_change" | "partial" | "failed" | "timed_out"
export type HydrationAttemptOutcome =
  | "written"
  | "no_change"
  | "failed"
  | "timed_out"
  | "certification_failed"

export interface HydrationRunClaim {
  runId: string
  claimAcquired: boolean
  status: "queued" | "loading_source" | "running" | "terminal"
  outcome: HydrationRunOutcome | null
  sourceExecutionId: string | null
  sourceFingerprint: string | null
  sourceGeneratedAt: string | null
  ownerToken: string
}

export interface HydrationArtifactAttempt {
  attemptId: string
  runId: string
  artifactKey: HydrationArtifactKey
  attemptNo: number
  sourceExecutionId: string
  sourceFingerprint: string
  status: "running" | "terminal"
  outcome: HydrationAttemptOutcome | null
  planFingerprint: string | null
  mutationCallCount: number | null
  versionBefore: string | null
  versionAfter: string | null
  certificationEvidence: Readonly<Record<string, unknown>> | null
  failureCode: string | null
  failureStage: string | null
  startedAt: string
  completedAt: string | null
}

export interface HydrationOrchestrationDatabaseClient {
  claimRun(input: {
    dedupeKey: string
    businessDate: string
    mode: HydrationRunMode
    requestedArtifacts: readonly HydrationArtifactKey[]
    ownerToken: string
    leaseSeconds: number
  }): Promise<Omit<HydrationRunClaim, "ownerToken">>
  bindRunSource(input: {
    runId: string
    ownerToken: string
    sourceExecutionId: string
    sourceFingerprint: string
    sourceGeneratedAt: string
  }): Promise<boolean>
  heartbeatRun(input: {
    runId: string
    ownerToken: string
    leaseSeconds: number
  }): Promise<boolean>
  listAttempts(runId: string): Promise<readonly HydrationArtifactAttempt[]>
  timeoutRunningAttempts(input: { runId: string; ownerToken: string; completedAt: string }): Promise<void>
  insertAttempt(input: Omit<HydrationArtifactAttempt, "status" | "outcome" | "completedAt"> & {
    ownerToken: string
  }): Promise<void>
  finishAttempt(input: {
    attemptId: string
    runId: string
    ownerToken: string
    outcome: HydrationAttemptOutcome
    completedAt: string
    planFingerprint?: string | null
    mutationCallCount?: number | null
    versionBefore?: string | null
    versionAfter?: string | null
    certificationEvidence?: Readonly<Record<string, unknown>> | null
    failureCode?: string | null
    failureStage?: string | null
  }): Promise<boolean>
  finishRun(input: {
    runId: string
    ownerToken: string
    outcome: HydrationRunOutcome
    completedAt: string
    publicSummary: Readonly<Record<string, unknown>>
  }): Promise<boolean>
}

export async function claimHydrationRun(
  input: {
    businessDate: string
    mode: HydrationRunMode
    requestedArtifacts: readonly HydrationArtifactKey[]
    scheduledAt?: string
    runNonce?: string
    leaseSeconds?: number
    ownerToken?: string
  },
  client: HydrationOrchestrationDatabaseClient
): Promise<HydrationRunClaim> {
  assertBusinessDate(input.businessDate)
  const requestedArtifacts = uniqueArtifacts(input.requestedArtifacts)
  const ownerToken = input.ownerToken ?? randomUUID()
  // One original Scheduler cycle may claim only one immutable artifact set.
  // Keeping the set out of the key makes rollout drift conflict with that
  // durable input instead of minting a second run over already-touched copies.
  //
  // The nonce is the deliberate re-run. A terminal succeeded/no_change run
  // replays its stored outcome, and a resumed run replays the source cut bound
  // to it, so re-running a bad cycle for real means a new key. Carrying the
  // nonce on the scheduled key too keeps that one command pinned to the same
  // calendar slot rather than forcing an invented artifact list.
  const runNonce = input.runNonce ? `:${normalizeRunNonce(input.runNonce)}` : ""
  const dedupeKey = input.scheduledAt === undefined
    ? `staging-hydration:v1:${input.businessDate}:${input.mode}:${requestedArtifacts.join(",")}${runNonce}`
    : `${scheduledHydrationDedupeKey(input.scheduledAt, input.mode)}${runNonce}`
  const claimed = await client.claimRun({
    dedupeKey,
    businessDate: input.businessDate,
    mode: input.mode,
    requestedArtifacts,
    ownerToken,
    leaseSeconds: input.leaseSeconds ?? 3600,
  })
  return { ...claimed, ownerToken }
}

/**
 * The durable identity of one scheduled cycle, without a re-run nonce. Exported
 * so a reader asking "did this slot ever produce a run?" derives the key from
 * the same code the claim uses instead of restating the format.
 */
export function scheduledHydrationDedupeKey(scheduledAt: string, mode: HydrationRunMode): string {
  return `staging-hydration:v2:${normalizeScheduledAt(scheduledAt)}:${mode}`
}

function normalizeRunNonce(value: string): string {
  const nonce = value.trim()
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(nonce)) {
    throw new Error("Hydration runNonce must contain 8-80 letters, digits, underscores, or hyphens.")
  }
  return nonce
}

export async function bindHydrationRunSource(
  input: {
    claim: HydrationRunClaim
    sourceExecutionId: string
    sourceFingerprint: string
    sourceGeneratedAt: string
  },
  client: HydrationOrchestrationDatabaseClient
): Promise<void> {
  if (!input.claim.claimAcquired || input.claim.status === "terminal") {
    throw new Error("Hydration source binding requires the active run lease.")
  }
  if (!/^hmac-sha256:[a-f0-9]{64}$/.test(input.sourceFingerprint)) {
    throw new Error("Hydration source binding requires a live HMAC fingerprint.")
  }
  if (Number.isNaN(Date.parse(input.sourceGeneratedAt))) {
    throw new Error("Hydration source binding requires a valid generated timestamp.")
  }
  const bound = await client.bindRunSource({
    runId: input.claim.runId,
    ownerToken: input.claim.ownerToken,
    sourceExecutionId: input.sourceExecutionId,
    sourceFingerprint: input.sourceFingerprint,
    sourceGeneratedAt: input.sourceGeneratedAt,
  })
  if (!bound) throw new Error("Hydration run source binding lost its lease.")
}

export async function prepareHydrationResume(
  runId: string,
  ownerToken: string,
  client: HydrationOrchestrationDatabaseClient,
  nowIso = new Date().toISOString()
): Promise<{
  attempts: readonly HydrationArtifactAttempt[]
  completedArtifacts: ReadonlySet<HydrationArtifactKey>
  nonRetryableArtifacts: ReadonlySet<HydrationArtifactKey>
}> {
  await client.timeoutRunningAttempts({ runId, ownerToken, completedAt: nowIso })
  const attempts = await client.listAttempts(runId)
  const completedArtifacts = new Set<HydrationArtifactKey>()
  const nonRetryableArtifacts = new Set<HydrationArtifactKey>()
  // A process can die after Docs accepts batchUpdate but before the terminal
  // mutation count is persisted. A timed-out ELT attempt is therefore an
  // unknowable mutation boundary and must fail closed instead of retrying.
  const eltMutationWasEverAttempted = attempts.some(
    (attempt) =>
      attempt.artifactKey === "elt_doc"
      && (attempt.mutationCallCount ?? 0) > 0
  )
  for (const attempt of latestAttempts(attempts).values()) {
    if (isCertifiedHydrationAttempt(attempt)) {
      completedArtifacts.add(attempt.artifactKey)
    } else if (
      attempt.artifactKey === "elt_doc"
      && (
        eltMutationWasEverAttempted
        || attempt.status === "running"
        || attempt.outcome === "timed_out"
      )
    ) {
      nonRetryableArtifacts.add(attempt.artifactKey)
    }
  }
  return { attempts, completedArtifacts, nonRetryableArtifacts }
}

export async function startHydrationArtifactAttempt(
  input: {
    runId: string
    artifactKey: HydrationArtifactKey
    sourceExecutionId: string
    sourceFingerprint: string
    ownerToken: string
    previousAttempts: readonly HydrationArtifactAttempt[]
    startedAt?: string
  },
  client: HydrationOrchestrationDatabaseClient
): Promise<HydrationArtifactAttempt> {
  const attemptNo = input.previousAttempts
    .filter((attempt) => attempt.artifactKey === input.artifactKey)
    .reduce((maximum, attempt) => Math.max(maximum, attempt.attemptNo), 0) + 1
  const attempt: HydrationArtifactAttempt = {
    attemptId: randomUUID(),
    runId: input.runId,
    artifactKey: input.artifactKey,
    attemptNo,
    sourceExecutionId: input.sourceExecutionId,
    sourceFingerprint: input.sourceFingerprint,
    status: "running",
    outcome: null,
    planFingerprint: null,
    mutationCallCount: null,
    versionBefore: null,
    versionAfter: null,
    certificationEvidence: null,
    failureCode: null,
    failureStage: null,
    startedAt: input.startedAt ?? new Date().toISOString(),
    completedAt: null,
  }
  await client.insertAttempt({
    attemptId: attempt.attemptId,
    runId: attempt.runId,
    artifactKey: attempt.artifactKey,
    attemptNo: attempt.attemptNo,
    sourceExecutionId: attempt.sourceExecutionId,
    sourceFingerprint: attempt.sourceFingerprint,
    planFingerprint: attempt.planFingerprint,
    mutationCallCount: attempt.mutationCallCount,
    versionBefore: attempt.versionBefore,
    versionAfter: attempt.versionAfter,
    certificationEvidence: attempt.certificationEvidence,
    failureCode: attempt.failureCode,
    failureStage: attempt.failureStage,
    startedAt: attempt.startedAt,
    ownerToken: input.ownerToken,
  })
  return attempt
}

export function aggregateHydrationOutcome(
  attempts: readonly HydrationArtifactAttempt[],
  requestedArtifacts: readonly HydrationArtifactKey[]
): HydrationRunOutcome {
  const latest = latestAttempts(attempts)
  const requestedAttempts = requestedArtifacts.map((artifact) => latest.get(artifact) ?? null)
  const completed = requestedAttempts.filter(
    (attempt): attempt is HydrationArtifactAttempt => attempt !== null && isCertifiedHydrationAttempt(attempt)
  )
  if (completed.length === requestedArtifacts.length) {
    return completed.some((attempt) => attempt.outcome === "written") ? "succeeded" : "no_change"
  }
  if (completed.length > 0) return "partial"
  if (requestedAttempts.some((attempt) => attempt?.outcome === "timed_out")) return "timed_out"
  return "failed"
}

export function isCertifiedHydrationAttempt(attempt: HydrationArtifactAttempt): boolean {
  const evidence = attempt.certificationEvidence
  const baseCertified = attempt.status === "terminal"
    && (attempt.outcome === "written" || attempt.outcome === "no_change")
    && /^hmac-sha256:[0-9a-f]{64}$/.test(attempt.planFingerprint ?? "")
    && evidence !== null
    && !Array.isArray(evidence)
    && Object.keys(evidence).length > 0
    && typeof evidence.artifact_status === "string"
  if (!baseCertified || evidence === null) return false
  if (attempt.artifactKey === "elt_doc") {
    return isCertifiedEltHydrationAttempt(attempt, evidence)
  }
  if (evidence.artifact_status !== "projected_dry_run") return true
  if (Object.keys(evidence).length !== 23) return false

  const hmacFingerprint = /^hmac-sha256:[0-9a-f]{64}$/
  const publicFingerprint = /^sha256:[0-9a-f]{64}$/
  return attempt.artifactKey === "delivery_roles_rps"
    && attempt.outcome === "no_change"
    && attempt.mutationCallCount === 0
    && /^\d+$/.test(attempt.versionBefore ?? "")
    && attempt.versionAfter === null
    && attempt.failureCode === null
    && attempt.failureStage === null
    && evidence.lifecycle === "recurring"
    && evidence.lifecycle_plan_status === "planned"
    && evidence.projection_certification === "exact_preimage_plus_deterministic_requests"
    && evidence.postimage_observed === false
    && evidence.target_absent_observed === true
    && evidence.observed_drive_version === attempt.versionBefore
    && evidence.drive_version_stable === true
    && evidence.value_plan_status === "projected"
    && !("after_structure_hash" in evidence)
    && projectedDeliveryRpsTargetMatches(evidence)
    && evidence.range_count === 3
    && Number.isInteger(evidence.projected_changed_range_count)
    && Number(evidence.projected_changed_range_count) >= 1
    && Number(evidence.projected_changed_range_count) <= 3
    && evidence.projected_value_no_op === false
    && typeof evidence.projected_preimage_fingerprint === "string"
    && hmacFingerprint.test(evidence.projected_preimage_fingerprint)
    && typeof evidence.desired_payload_fingerprint === "string"
    && hmacFingerprint.test(evidence.desired_payload_fingerprint)
    && typeof evidence.normalization_fingerprint === "string"
    && publicFingerprint.test(evidence.normalization_fingerprint)
    && typeof evidence.observed_structure_fingerprint === "string"
    && publicFingerprint.test(evidence.observed_structure_fingerprint)
    && typeof evidence.expected_after_state_fingerprint === "string"
    && publicFingerprint.test(evidence.expected_after_state_fingerprint)
    && typeof evidence.forward_requests_fingerprint === "string"
    && publicFingerprint.test(evidence.forward_requests_fingerprint)
    && typeof evidence.rollback_requests_fingerprint === "string"
    && publicFingerprint.test(evidence.rollback_requests_fingerprint)
    && typeof evidence.format_fingerprint === "string"
    && publicFingerprint.test(evidence.format_fingerprint)
}

const ELT_EVIDENCE_KEYS = [
  "artifact_status",
  "evidence_contract",
  "pii_policy",
  "acl_policy",
  "hydration_mode",
  "block_code",
  "mutation_scope",
  "plan_status",
  "plan_action",
  "dry_run_verified",
  "preimage_fingerprint",
  "drive_version_before",
  "drive_version_after",
  "rollback_drive_version",
  "permission_fingerprint",
  "permission_fingerprint_after",
  "rollback_permission_fingerprint",
  "outside_content_fingerprint",
  "revision_before_fingerprint",
  "revision_after_fingerprint",
  "revision_guard_present",
  "reporting_week",
  "snapshot_run_id",
  "snapshot_mode",
  "source_generated_at",
  "template_hash",
  "rollback_request_count",
  "rollback_attempted",
  "rollback_verified",
  "certification_status",
] as const

function isCertifiedEltHydrationAttempt(
  attempt: HydrationArtifactAttempt,
  evidence: Readonly<Record<string, unknown>>
): boolean {
  if (
    Object.keys(evidence).length !== ELT_EVIDENCE_KEYS.length
    || !ELT_EVIDENCE_KEYS.every((key) => Object.hasOwn(evidence, key))
    || attempt.failureCode !== null
    || attempt.failureStage !== null
    || evidence.evidence_contract !== "elt_fact_table_v1"
    || evidence.pii_policy !== "internal_review_identifiers"
    || evidence.acl_policy !== "exact_owner_and_service_writer"
    || evidence.block_code !== null
    || evidence.mutation_scope !== "weekly_fact_table"
    || evidence.revision_guard_present !== true
    || typeof evidence.preimage_fingerprint !== "string"
    || !/^hmac-sha256:[0-9a-f]{64}$/.test(evidence.preimage_fingerprint)
    || typeof evidence.outside_content_fingerprint !== "string"
    || !/^hmac-sha256:[0-9a-f]{64}$/.test(evidence.outside_content_fingerprint)
    || typeof evidence.template_hash !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(evidence.template_hash)
    || !eltEvidenceSourceIdentityMatches(evidence)
    || evidence.rollback_attempted !== false
    || evidence.rollback_verified !== false
  ) {
    return false
  }

  if (evidence.artifact_status === "dry_run") {
    return attempt.outcome === "no_change"
      && evidence.hydration_mode === "dry_run"
      && (evidence.plan_status === "planned_for_internal_review"
        || evidence.plan_status === "no_change")
      && eltPlanActionMatchesStatus(evidence.plan_status, evidence.plan_action)
      && evidence.dry_run_verified === true
      && attempt.mutationCallCount === 0
      && isPublicFingerprint(attempt.versionBefore)
      && attempt.versionAfter === null
      && evidence.drive_version_before === null
      && evidence.drive_version_after === null
      && evidence.rollback_drive_version === null
      && evidence.permission_fingerprint === null
      && evidence.permission_fingerprint_after === null
      && evidence.rollback_permission_fingerprint === null
      && evidence.revision_before_fingerprint === attempt.versionBefore
      && evidence.revision_after_fingerprint === null
      && evidence.rollback_request_count === 0
      && evidence.certification_status === "dry_run_verified"
  }

  if (evidence.artifact_status === "no_change") {
    return attempt.outcome === "no_change"
      && evidence.hydration_mode === "write"
      && evidence.plan_status === "no_change"
      && evidence.plan_action === "no_op"
      && evidence.dry_run_verified === false
      && attempt.mutationCallCount === 0
      && isPublicFingerprint(attempt.versionBefore)
      && attempt.versionAfter === attempt.versionBefore
      && evidence.revision_before_fingerprint === attempt.versionBefore
      && evidence.revision_after_fingerprint === attempt.versionAfter
      && isHmacFingerprint(evidence.permission_fingerprint)
      && evidence.permission_fingerprint_after === evidence.permission_fingerprint
      && evidence.rollback_permission_fingerprint === null
      && typeof evidence.drive_version_before === "string"
      && /^[1-9]\d*$/.test(evidence.drive_version_before)
      && evidence.drive_version_after === evidence.drive_version_before
      && evidence.rollback_drive_version === null
      && evidence.rollback_request_count === 0
      && evidence.certification_status === "preimage_verified"
  }

  if (evidence.artifact_status === "written") {
    return attempt.outcome === "written"
      && evidence.hydration_mode === "write"
      && evidence.plan_status === "planned_for_internal_review"
      && (evidence.plan_action === "insert_top_week"
        || evidence.plan_action === "replace_top_week")
      && evidence.dry_run_verified === false
      && attempt.mutationCallCount === 1
      && isPublicFingerprint(attempt.versionBefore)
      && isPublicFingerprint(attempt.versionAfter)
      && attempt.versionAfter !== attempt.versionBefore
      && evidence.revision_before_fingerprint === attempt.versionBefore
      && evidence.revision_after_fingerprint === attempt.versionAfter
      && isHmacFingerprint(evidence.permission_fingerprint)
      && evidence.permission_fingerprint_after === evidence.permission_fingerprint
      && evidence.rollback_permission_fingerprint === null
      && typeof evidence.drive_version_before === "string"
      && typeof evidence.drive_version_after === "string"
      && driveVersionAdvancedBeyond(
        evidence.drive_version_after,
        evidence.drive_version_before
      )
      && evidence.rollback_drive_version === null
      && Number.isInteger(evidence.rollback_request_count)
      && Number(evidence.rollback_request_count) >= 1
      && evidence.certification_status === "postimage_verified"
  }

  return false
}

function eltEvidenceSourceIdentityMatches(
  evidence: Readonly<Record<string, unknown>>
): boolean {
  if (
    typeof evidence.source_generated_at !== "string"
    || typeof evidence.reporting_week !== "string"
    || typeof evidence.snapshot_run_id !== "string"
    || evidence.snapshot_mode !== "shadow"
  ) {
    return false
  }
  const sourceGeneratedAt = evidence.source_generated_at
  const parsed = Date.parse(sourceGeneratedAt)
  if (
    !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== sourceGeneratedAt
    || evidence.snapshot_run_id !== `e01_${sourceGeneratedAt.replace(/[^0-9]/g, "")}`
  ) {
    return false
  }
  return evidence.reporting_week === fridayWeekLabels(
    eltReportingFriday(new Date(parsed))
  ).weekLabel
}

function eltPlanActionMatchesStatus(planStatus: unknown, planAction: unknown): boolean {
  return planStatus === "no_change"
    ? planAction === "no_op"
    : planAction === "insert_top_week" || planAction === "replace_top_week"
}

function isHmacFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^hmac-sha256:[0-9a-f]{64}$/.test(value)
}

function isPublicFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
}

function driveVersionAdvancedBeyond(candidate: unknown, baseline: unknown): boolean {
  if (
    typeof candidate !== "string"
    || typeof baseline !== "string"
    || !/^[1-9]\d*$/.test(candidate)
    || !/^[1-9]\d*$/.test(baseline)
  ) {
    return false
  }
  return candidate.length === baseline.length
    ? candidate > baseline
    : candidate.length > baseline.length
}

function projectedDeliveryRpsTargetMatches(evidence: Readonly<Record<string, unknown>>): boolean {
  if (typeof evidence.normalization_id !== "string") return false
  const match = /^delivery_rps_dated_rollover_(\d{4})(\d{2})(\d{2})$/.exec(
    evidence.normalization_id
  )
  if (!match) return false
  const reportDate = `${match[1]}-${match[2]}-${match[3]}`
  try {
    return evidence.target_sheet_title === deliveryRpsDatedTabTitle(reportDate)
      && evidence.target_sheet_id === deliveryRpsTargetSheetId(reportDate)
  } catch {
    return false
  }
}

function latestAttempts(attempts: readonly HydrationArtifactAttempt[]): Map<HydrationArtifactKey, HydrationArtifactAttempt> {
  const latest = new Map<HydrationArtifactKey, HydrationArtifactAttempt>()
  for (const attempt of attempts) {
    const current = latest.get(attempt.artifactKey)
    if (!current || attempt.attemptNo > current.attemptNo) latest.set(attempt.artifactKey, attempt)
  }
  return latest
}

function uniqueArtifacts(values: readonly HydrationArtifactKey[]): HydrationArtifactKey[] {
  if (values.length === 0) throw new Error("Hydration run requires at least one artifact.")
  const unique = [...new Set(values)]
  if (unique.length !== values.length) throw new Error("Hydration run artifacts must be unique.")
  return unique
}

function assertBusinessDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error("Hydration business date must be one ISO date.")
  }
}

function normalizeScheduledAt(value: string): string {
  const match = value.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/
  )
  if (!match) throw new Error("Hydration scheduledAt must be one RFC 3339 timestamp.")

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const offset = zone === "Z" ? null : zone.slice(1).split(":").map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (
    !daysInMonth || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59
    || (offset !== null && (offset[0] > 23 || offset[1] > 59))
  ) {
    throw new Error("Hydration scheduledAt must be one valid RFC 3339 timestamp.")
  }

  const parsed = Date.parse(value.trim())
  if (!Number.isFinite(parsed)) throw new Error("Hydration scheduledAt must be one valid RFC 3339 timestamp.")
  return new Date(parsed).toISOString()
}
