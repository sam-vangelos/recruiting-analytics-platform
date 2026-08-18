import { randomUUID } from "node:crypto"

import { readEnv } from "../env"
import {
  EmailTransportError,
  retrieveEmailStatus,
  sendEmail,
  type SendEmailOptions,
} from "../email-notify"
import {
  createPayloadFingerprint,
  createPiiFingerprint,
  createStableChecksum,
} from "./checksums"
import {
  buildEmployeeReferralReport,
  createEmployeeReferralReportPeriod,
  createPreviousEmployeeReferralMonth,
  employeeReferralLocalDate,
  employeeReferralLocalDateTimeToUtc,
  loadEmployeeReferralSnapshot,
  type EmployeeReferralReport,
  type EmployeeReferralReportPeriod,
  type EmployeeReferralSnapshot,
} from "./employee-referral-report"
import {
  readEmployeeReferralMasterSpreadsheetId,
  writeEmployeeReferralMasterSheet,
  type EmployeeReferralMasterSheetWriteResult,
} from "./employee-referral-master-sheet"
import {
  EmployeeReferralReportStore,
  EmployeeReferralReportStoreError,
  type EmployeeReferralAuthoritativeHead,
  type EmployeeReferralDeliveryClaim,
  type EmployeeReferralDeliveryStatus,
  type EmployeeReferralParentStatus,
  type EmployeeReferralPeriodState,
  type EmployeeReferralPrepareInput,
  type EmployeeReferralRecipientSlot,
  type EmployeeReferralWatchdogTarget,
} from "./employee-referral-report-store"

const INITIAL_PERIOD_START = "2026-04-01"
const INITIAL_PERIOD_END = "2026-07-01"
const INITIAL_BACKFILL_DEADLINE = "2026-07-29T00:00:00.000Z"
// The corporate domain gates report recipients: referral reports carry
// pre-payroll compensation data and may only be delivered to corporate
// addresses. Configurable per deployment; the default matches the fixtures.
const CORPORATE_EMAIL_DOMAIN = (
  process.env.EMPLOYEE_REFERRAL_CORPORATE_EMAIL_DOMAIN || "example.com"
)
  .trim()
  .replace(/^@/, "")
const CORPORATE_EMAIL = new RegExp(
  `^[A-Z0-9.!#$%&'*+/=?^_\`{|}~-]+@${CORPORATE_EMAIL_DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  "i"
)
const SYNTHETIC_STATUS_ATTEMPTS = 27
const SYNTHETIC_STATUS_TIMEOUT_MS = 10_000
const SYNTHETIC_STATUS_BACKOFF_MS = 15_000
const SYNTHETIC_WARNING = "TEST - SYNTHETIC DATA - NOT FOR PAYROLL"
const CURRENT_PHASE_DEADLINE_MS = 700_000
const CURRENT_DISPATCH_RESERVE_MS = 30_000
const HISTORICAL_PHASE_DEADLINE_MS = 820_000
const ABSOLUTE_RESPONSE_DEADLINE_MS = 840_000
const MANUAL_CLAIM_READBACK_TIMEOUT_MS = 10_000
const WATCHDOG_DEADLINE_MS = 100_000
const WATCHDOG_LOOKUP_TIMEOUT_MS = 8_000
const WATCHDOG_CONCURRENCY = 8

export interface EmployeeReferralRecipientConfig {
  ta_lead: string
  requesting_manager: string
  scopeVersion: string
  from: string
}

export interface EmployeeReferralPreview {
  report: EmployeeReferralReport
  sourceSetFingerprint: string
  payloadFingerprint: string
}

export interface EmployeeReferralMasterSheetSyncResult {
  status: "sheet_updated"
  correlationId: string
  periodStartLocal: string
  periodEndLocalExclusive: string
  counts: EmployeeReferralReport["counts"]
  updatedTabs: string[]
  currentCohortRowCount: number
}

export interface EmployeeReferralManualArtifactHandle {
  rollback: () => Promise<void>
}

export interface EmployeeReferralRunResult {
  status:
    | "provider_accepted"
    | "already_delivered"
    | "in_progress"
    | "manual_prepared"
  correlationId: string
  periodStartLocal: string
  periodEndLocalExclusive: string
  revision: number
  counts: EmployeeReferralReport["counts"]
  recipientSlots: {
    recipientSlot: EmployeeReferralRecipientSlot
    deliveryStatus: string
    providerMessageId: string | null
  }[]
  historicalReconciliation: {
    checkedPeriodCount: number
    driftCount: number
    issueCount: number
  }
}

export interface EmployeeReferralRunnerDependencies {
  loadSnapshot: typeof loadEmployeeReferralSnapshot
  buildReport: typeof buildEmployeeReferralReport
  store: EmployeeReferralReportStore
  send: typeof sendEmail
  retrieveStatus: typeof retrieveEmailStatus
  writeMasterSheet: (
    report: EmployeeReferralReport
  ) => Promise<EmployeeReferralMasterSheetWriteResult>
  env: (name: string) => string | undefined
  now: () => Date
  clock: () => number
  piiFingerprint: (value: unknown, context: string) => string
  sleep: (milliseconds: number) => Promise<void>
  log: (message: string) => void
}

export class EmployeeReferralRunnerError extends Error {
  readonly code: string
  readonly publicDiagnostics: Record<string, string | number | boolean>

  constructor(
    code: string,
    message: string,
    publicDiagnostics: Record<string, string | number | boolean> = {}
  ) {
    super(message)
    this.name = "EmployeeReferralRunnerError"
    this.code = code
    this.publicDiagnostics = publicDiagnostics
  }
}

export function isEmployeeReferralReportSendEnabled(
  env: (name: string) => string | undefined = readEnv
): boolean {
  return env("EMPLOYEE_REFERRAL_REPORT_SEND_ENABLED") === "true"
}

export function readEmployeeReferralRecipientConfig(
  env: (name: string) => string | undefined = readEnv,
  options: { requireFrom?: boolean } = {}
): EmployeeReferralRecipientConfig {
  const raw = env("EMPLOYEE_REFERRAL_REPORT_RECIPIENTS")
  const scopeVersion = env("EMPLOYEE_REFERRAL_REPORT_RECIPIENT_SCOPE_VERSION")
  const from = env("NOTIFY_EMAIL_FROM")
  if (!raw || !scopeVersion || ((options.requireFrom ?? true) && !from)) {
    throw new EmployeeReferralRunnerError(
      "recipient_configuration_missing",
      "Employee referral report recipient configuration is incomplete"
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new EmployeeReferralRunnerError(
      "recipient_configuration_invalid",
      "Employee referral report recipients must be a JSON object"
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EmployeeReferralRunnerError(
      "recipient_configuration_invalid",
      "Employee referral report recipients must be a JSON object"
    )
  }
  const record = parsed as Record<string, unknown>
  if (
    Object.keys(record).sort().join(",") !== "requesting_manager,ta_lead" ||
    typeof record.ta_lead !== "string" ||
    typeof record.requesting_manager !== "string"
  ) {
    throw new EmployeeReferralRunnerError(
      "recipient_configuration_invalid",
      "Employee referral report recipient slots are invalid"
    )
  }
  const ta_lead = normalizeCorporateAddress(record.ta_lead)
  const requestingManager = normalizeCorporateAddress(record.requesting_manager)
  if (ta_lead === requestingManager) {
    throw new EmployeeReferralRunnerError(
      "recipient_configuration_invalid",
      "Employee referral report requires two distinct corporate recipients"
    )
  }
  if (!/^scope-v[1-9][0-9]{0,9}$/.test(scopeVersion)) {
    throw new EmployeeReferralRunnerError(
      "recipient_scope_invalid",
      "Employee referral report recipient scope version is invalid"
    )
  }
  return {
    ta_lead,
    requesting_manager: requestingManager,
    scopeVersion,
    from: from ?? "",
  }
}

export async function previewEmployeeReferralReport(
  period: EmployeeReferralReportPeriod,
  options: {
    revision?: number
    supersedesRevision?: number | null
    correlationId?: string
    deadlineAtMs?: number
  } = {},
  overrides: Partial<EmployeeReferralRunnerDependencies> = {}
): Promise<EmployeeReferralPreview> {
  const dependencies = runnerDependencies(overrides)
  const correlationId = options.correlationId ?? randomUUID()
  const deadlineAtMs =
    options.deadlineAtMs ?? dependencies.clock() + CURRENT_PHASE_DEADLINE_MS
  const snapshot = await dependencies.loadSnapshot(period, undefined, {
    deadlineAtMs,
    now: dependencies.clock,
    sleep: dependencies.sleep,
  })
  const report = dependencies.buildReport(snapshot, {
    correlationId,
    revision: options.revision ?? 1,
    supersedesRevision: options.supersedesRevision ?? null,
    assessmentDateLocal: employeeReferralLocalDate(dependencies.now()),
    masterSpreadsheetId: readEmployeeReferralMasterSpreadsheetId(
      dependencies.env,
      { required: false }
    ),
  })
  validateRenderedReport(report)
  return {
    report,
    sourceSetFingerprint: createPayloadFingerprint({
      governedSourceIds: report.observedReferralSourceIds.filter((id) => id === "4000194004"),
      observedReferralSourceIds: report.observedReferralSourceIds,
    }),
    payloadFingerprint: dependencies.piiFingerprint(
      {
        period: report.period,
        policyVersion: report.policyVersion,
        policyExportSha256: report.policyExportSha256,
        rows: report.rows,
        subject: report.subject,
        html: report.html,
        csv: report.csv,
      },
      "employee-referral-report-payload-v1"
    ),
  }
}

export async function syncEmployeeReferralMasterSheet(
  period?: EmployeeReferralReportPeriod,
  overrides: Partial<EmployeeReferralRunnerDependencies> = {}
): Promise<EmployeeReferralMasterSheetSyncResult> {
  const dependencies = runnerDependencies(overrides)
  const resolvedPeriod =
    period ?? createPreviousEmployeeReferralMonth(dependencies.now())
  const preview = await previewEmployeeReferralReport(
    resolvedPeriod,
    {},
    dependencies
  )
  const result = await dependencies.writeMasterSheet(preview.report)
  dependencies.log(
    JSON.stringify({
      event: "employee_referral_master_sheet_updated",
      period_start_local: resolvedPeriod.periodStartLocal,
      period_end_local_exclusive: resolvedPeriod.periodEndLocalExclusive,
      updated_tab_count: result.updatedTabs.length,
      current_cohort_row_count: result.currentCohortRowCount,
    })
  )
  return {
    status: "sheet_updated",
    correlationId: preview.report.publicDiagnostics.correlationId,
    periodStartLocal: resolvedPeriod.periodStartLocal,
    periodEndLocalExclusive: resolvedPeriod.periodEndLocalExclusive,
    counts: preview.report.counts,
    updatedTabs: result.updatedTabs,
    currentCohortRowCount: result.currentCohortRowCount,
  }
}

export async function runEmployeeReferralReport(
  input: {
    period?: EmployeeReferralReportPeriod
    revision?: number
    supersedesRevision?: number | null
    correctionReason?: string | null
    mode?: "send" | "prepare_manual"
    promoteCorrection?: boolean
    acknowledgePossibleLateDelivery?: boolean
    lateDeliveryReason?: string | null
    manualArtifactWriter?: (
      report: EmployeeReferralReport
    ) => Promise<EmployeeReferralManualArtifactHandle>
    expectedPayloadFingerprint?: string
  } = {},
  overrides: Partial<EmployeeReferralRunnerDependencies> = {}
): Promise<EmployeeReferralRunResult> {
  const dependencies = runnerDependencies(overrides)
  const invocationStartedAt = dependencies.clock()
  const currentDeadlineAtMs = invocationStartedAt + CURRENT_PHASE_DEADLINE_MS
  const historicalDeadlineAtMs =
    invocationStartedAt + HISTORICAL_PHASE_DEADLINE_MS
  const absoluteDeadlineAtMs =
    invocationStartedAt + ABSOLUTE_RESPONSE_DEADLINE_MS
  if (!isEmployeeReferralReportSendEnabled(dependencies.env)) {
    throw new EmployeeReferralRunnerError(
      "send_gate_disabled",
      "Employee referral report send gate is disabled"
    )
  }
  const mode = input.mode ?? "send"
  const config = readEmployeeReferralRecipientConfig(dependencies.env, {
    requireFrom: mode === "send",
  })
  const period = input.period ?? createPreviousEmployeeReferralMonth(dependencies.now())
  const revision = input.revision ?? 1
  const supersedesRevision = input.supersedesRevision ?? null
  if (mode === "prepare_manual" && (!isInitialPeriod(period) || revision !== 1)) {
    throw new EmployeeReferralRunnerError(
      "manual_period_forbidden",
      "Manual delivery is allowed only for the initial April-June revision 1"
    )
  }
  if (mode === "prepare_manual") {
    if (!input.manualArtifactWriter) {
      throw new EmployeeReferralRunnerError(
        "manual_artifact_writer_required",
        "Manual delivery preparation requires a private artifact writer"
      )
    }
    const existingState = await awaitRunnerDeadline(
      (signal) =>
        dependencies.store.getPeriodState(
          period.periodStartLocal,
          period.periodEndLocalExclusive,
          { signal }
        ),
      currentDeadlineAtMs,
      dependencies
    )
    if (existingState.runs.length > 0 || existingState.deliveries.length > 0) {
      throw new EmployeeReferralRunnerError(
        "manual_delivery_already_exists",
        "Manual delivery has already been prepared for the initial April-June period"
      )
    }
  }
  const correlationId = randomUUID()
  const preview = await previewEmployeeReferralReport(
    period,
    {
      revision,
      supersedesRevision,
      correlationId,
      deadlineAtMs: currentDeadlineAtMs - CURRENT_DISPATCH_RESERVE_MS,
    },
    dependencies
  )
  if (
    input.expectedPayloadFingerprint !== undefined &&
    preview.payloadFingerprint !== input.expectedPayloadFingerprint
  ) {
    throw new EmployeeReferralRunnerError(
      "approved_preview_mismatch",
      "Employee referral report no longer matches the approved preview"
    )
  }
  const masterSheet = await dependencies.writeMasterSheet(preview.report)
  dependencies.log(
    JSON.stringify({
      event: "employee_referral_master_sheet_updated",
      period_start_local: period.periodStartLocal,
      period_end_local_exclusive: period.periodEndLocalExclusive,
      updated_tab_count: masterSheet.updatedTabs.length,
      current_cohort_row_count: masterSheet.currentCohortRowCount,
    })
  )
  requireRunnerBudget(
    dependencies,
    currentDeadlineAtMs,
    CURRENT_DISPATCH_RESERVE_MS,
    "current_phase_deadline_exhausted"
  )
  const attachmentFilename = referralCsvFilename(period, revision)
  const requestFingerprints: Partial<Record<EmployeeReferralRecipientSlot, string>> =
    mode === "send"
      ? requestFingerprintsForReport(
          preview.report,
          attachmentFilename,
          config,
          dependencies
        )
      : {}
  const idempotencyKeys: Partial<Record<EmployeeReferralRecipientSlot, string>> =
    mode === "send" ? idempotencyKeysFor(period, revision) : {}
  const deliveryDeadlineAt = deliveryDeadline(period, revision, dependencies.now())

  if (input.promoteCorrection) {
    if (!supersedesRevision || revision !== supersedesRevision + 1) {
      throw new EmployeeReferralRunnerError(
        "correction_lineage_invalid",
        "Employee referral correction revision must immediately follow its predecessor"
      )
    }
    const promoted = await awaitRunnerDeadline(
      (signal) =>
        dependencies.store.promoteCorrection(
          {
            period,
            predecessorRevision: supersedesRevision,
            sourceSetFingerprint: preview.sourceSetFingerprint,
            payloadFingerprint: preview.payloadFingerprint,
            recipientScopeVersion: config.scopeVersion,
            counts: preview.report.counts,
            policyVersion: preview.report.policyVersion,
            policyExportSha256: preview.report.policyExportSha256,
            correctionReason: requiredCorrectionReason(input.correctionReason),
            deliveryDeadlineAt,
            requestFingerprints,
            idempotencyKeys,
            acknowledgePossibleLateDelivery: input.acknowledgePossibleLateDelivery,
            lateDeliveryReason: input.lateDeliveryReason,
          },
          { signal }
        ),
      currentDeadlineAtMs,
      dependencies
    )
    if (promoted !== revision) {
      throw new EmployeeReferralRunnerError(
        "correction_promotion_mismatch",
        "Employee referral correction promotion returned an unexpected revision"
      )
    }
  }

  const manualArtifact =
    mode === "prepare_manual"
      ? await input.manualArtifactWriter!(preview.report)
      : null
  const prepareInput: EmployeeReferralPrepareInput = {
    period,
    revision,
    supersedesRevision,
    sourceSetFingerprint: preview.sourceSetFingerprint,
    payloadFingerprint: preview.payloadFingerprint,
    recipientScopeVersion: config.scopeVersion,
    counts: preview.report.counts,
    policyVersion: preview.report.policyVersion,
    policyExportSha256: preview.report.policyExportSha256,
    correctionReason:
      revision > 1 ? requiredCorrectionReason(input.correctionReason) : null,
    deliveryDeadlineAt,
    deliveryChannel:
      mode === "prepare_manual" ? "manual_corporate_email" : "resend",
    manualPreparationToken: mode === "prepare_manual" ? correlationId : null,
    requestFingerprints,
    idempotencyKeys,
  }
  let claims: EmployeeReferralDeliveryClaim[]
  try {
    requireRunnerBudget(
      dependencies,
      currentDeadlineAtMs,
      mode === "send" ? CURRENT_DISPATCH_RESERVE_MS : 5_000,
      "current_phase_deadline_before_claim"
    )
  } catch (error) {
    if (manualArtifact) await manualArtifact.rollback().catch(() => undefined)
    throw error
  }
  let prepareStarted = false
  try {
    claims = await awaitRunnerDeadline(
      (signal) => {
        prepareStarted = true
        return dependencies.store.prepareAndClaim(prepareInput, { signal })
      },
      currentDeadlineAtMs,
      dependencies
    )
  } catch (error) {
    if (!manualArtifact) throw error
    if (!prepareStarted) {
      await manualArtifact.rollback().catch(() => undefined)
      throw error
    }
    if (
      error instanceof EmployeeReferralReportStoreError &&
      error.outcome === "rejected"
    ) {
      await manualArtifact.rollback().catch(() => undefined)
      throw error
    }
    let state: EmployeeReferralPeriodState
    try {
      state = await awaitRunnerDeadline(
        (signal) =>
          dependencies.store.getPeriodState(
            period.periodStartLocal,
            period.periodEndLocalExclusive,
            { signal }
          ),
        Math.min(
          absoluteDeadlineAtMs,
          dependencies.clock() + MANUAL_CLAIM_READBACK_TIMEOUT_MS
        ),
        dependencies
      )
    } catch {
      dependencies.log(
        JSON.stringify({
          event: "employee_referral_manual_prepare_commit_unconfirmed",
          period_start_local: period.periodStartLocal,
          period_end_local_exclusive: period.periodEndLocalExclusive,
          revision,
          artifact_preserved: true,
        })
      )
      throw new EmployeeReferralRunnerError(
        "manual_delivery_commit_unconfirmed",
        "Manual delivery ledger commit could not be confirmed; the private artifact was preserved",
        {
          payload_fingerprint: preview.payloadFingerprint,
          manual_preparation_token: correlationId,
        }
      )
    }
    const recoveredClaims = committedManualPreparationClaims(state, prepareInput)
    if (recoveredClaims) {
      claims = recoveredClaims
      dependencies.log(
        JSON.stringify({
          event: "employee_referral_manual_prepare_response_recovered",
          period_start_local: period.periodStartLocal,
          period_end_local_exclusive: period.periodEndLocalExclusive,
          revision,
        })
      )
    } else if (manualPreparationOwnedByAnotherInvocation(state, prepareInput)) {
      await manualArtifact.rollback().catch(() => undefined)
      throw new EmployeeReferralRunnerError(
        "manual_delivery_already_exists",
        "A different manual preparation invocation owns the initial ledger"
      )
    } else {
      dependencies.log(
        JSON.stringify({
          event: "employee_referral_manual_prepare_commit_unconfirmed",
          period_start_local: period.periodStartLocal,
          period_end_local_exclusive: period.periodEndLocalExclusive,
          revision,
          artifact_preserved: true,
        })
      )
      throw new EmployeeReferralRunnerError(
        "manual_delivery_commit_unconfirmed",
        "Manual delivery ledger commit could not be confirmed; the private artifact was preserved",
        {
          payload_fingerprint: preview.payloadFingerprint,
          manual_preparation_token: correlationId,
        }
      )
    }
  }

  if (
    claims.some(
      (claim) =>
        claim.deadlineMissedAtCreation &&
        (claim.claimed || mode === "prepare_manual")
    )
  ) {
    dependencies.log(
      JSON.stringify({
        event: "employee_referral_delivery_deadline_missed_at_creation",
        period_start_local: period.periodStartLocal,
        period_end_local_exclusive: period.periodEndLocalExclusive,
        revision,
      })
    )
  }

  if (mode === "prepare_manual") {
    if (claims.length !== 2) {
      await manualArtifact!.rollback().catch(() => undefined)
      throw new EmployeeReferralRunnerError(
        "manual_delivery_claim_invalid",
        "Manual delivery preparation did not create both recipient slots"
      )
    }
    return runResult("manual_prepared", correlationId, preview.report, revision, claims)
  }

  const claimed = claims.filter((claim) => claim.claimed)
  if (claimed.length === 0) {
    const parentStatus = claims[0]?.parentStatus
    if (parentStatus === "delivered") {
      const historicalReconciliation = await reconcileHistoricalReports(
        period,
        dependencies,
        { historicalDeadlineAtMs, absoluteDeadlineAtMs }
      )
      return runResult(
        "already_delivered",
        correlationId,
        preview.report,
        revision,
        claims,
        historicalReconciliation
      )
    }
    if (parentStatus === "attention_required" || parentStatus === "ambiguous") {
      try {
        const attentionState = await awaitRunnerDeadline(
          (signal) =>
            dependencies.store.getPeriodState(
              period.periodStartLocal,
              period.periodEndLocalExclusive,
              { signal }
            ),
          currentDeadlineAtMs,
          dependencies
        )
        logOpenCorrectionProposalsFromState(
          dependencies,
          period.periodStartLocal,
          period.periodEndLocalExclusive,
          attentionState.proposals
        )
      } catch {
        // The safe aggregate exception below remains the retry/monitoring signal.
      }
      throw new EmployeeReferralRunnerError(
        "delivery_attention_required",
        "Employee referral report delivery requires an explicit correction or recovery",
        { revision, parentStatus: parentStatus ?? "unknown" }
      )
    }
    return runResult("in_progress", correlationId, preview.report, revision, claims)
  }

  const outcomes = await Promise.allSettled(
    claimed.map((claim) => {
      const requestFingerprint = requestFingerprints[claim.recipientSlot]
      const idempotencyKey = idempotencyKeys[claim.recipientSlot]
      if (!requestFingerprint || !idempotencyKey) {
        throw new EmployeeReferralRunnerError(
          "claimed_request_tokens_missing",
          "Claimed employee referral recipient slot is missing frozen request tokens"
        )
      }
      return dispatchClaim({
        claim,
        report: preview.report,
        revision,
        attachmentFilename,
        config,
        requestFingerprint,
        idempotencyKey,
        deadlineAtMs: currentDeadlineAtMs,
        dependencies,
      })
    })
  )
  if (outcomes.some((outcome) => outcome.status === "rejected")) {
    throw new EmployeeReferralRunnerError(
      "delivery_attempt_failed",
      "Employee referral report has an unresolved recipient delivery attempt",
      { revision, claimedRecipientCount: claimed.length }
    )
  }
  const states = outcomes.map((outcome) =>
    outcome.status === "fulfilled" ? outcome.value : "ambiguous"
  )
  if (states.some((state) => state !== "provider_accepted")) {
    throw new EmployeeReferralRunnerError(
      "delivery_attempt_incomplete",
      "Employee referral report delivery did not reach provider acceptance for every claimed slot",
      { revision, claimedRecipientCount: claimed.length }
    )
  }
  const state = await awaitRunnerDeadline(
    (signal) =>
      dependencies.store.getPeriodState(
        period.periodStartLocal,
        period.periodEndLocalExclusive,
        { signal }
      ),
    currentDeadlineAtMs,
    dependencies
  )
  const currentDeliveries = state.deliveries.filter(
    (delivery) => Number(delivery.revision) === revision
  )
  const resultClaims = currentDeliveries.map((delivery) => ({
    parentStatus: "provider_accepted" as EmployeeReferralParentStatus,
    recipientSlot: delivery.recipient_slot as EmployeeReferralRecipientSlot,
    deliveryStatus: String(delivery.status) as EmployeeReferralDeliveryStatus,
    claimed: false,
    leaseToken: null,
    attemptCount: Number(delivery.attempt_count ?? 0),
    providerRequestFingerprint: null,
    idempotencyKey: null,
    idempotencyExpiresAt: null,
    providerMessageId:
      typeof delivery.provider_message_id === "string" ? delivery.provider_message_id : null,
  }))
  dependencies.log(
    JSON.stringify({
      event: "employee_referral_report_provider_accepted",
      correlation_id: correlationId,
      period_start_local: period.periodStartLocal,
      period_end_local_exclusive: period.periodEndLocalExclusive,
      revision,
      total_row_count: preview.report.counts.totalRowCount,
      mapping_review_count: preview.report.counts.mappingReviewCount,
    })
  )
  const historicalReconciliation = await reconcileHistoricalReports(
    period,
    dependencies,
    { historicalDeadlineAtMs, absoluteDeadlineAtMs }
  )
  return runResult(
    "provider_accepted",
    correlationId,
    preview.report,
    revision,
    resultClaims.length ? resultClaims : claims,
    historicalReconciliation
  )
}

export async function sendSyntheticEmployeeReferralTest(
  overrides: Partial<EmployeeReferralRunnerDependencies> = {}
): Promise<{ status: "delivered"; providerMessageId: string; event: string }> {
  const dependencies = runnerDependencies(overrides)
  if (dependencies.env("EMPLOYEE_REFERRAL_REPORT_OPERATOR_MODE") !== "true") {
    throw new EmployeeReferralRunnerError(
      "operator_mode_disabled",
      "Synthetic employee referral test requires operator mode"
    )
  }
  if (!isEmployeeReferralReportSendEnabled(dependencies.env)) {
    throw new EmployeeReferralRunnerError(
      "send_gate_disabled",
      "Synthetic employee referral test requires the report send gate"
    )
  }
  const recipient = normalizeCorporateAddress(
    dependencies.env("EMPLOYEE_REFERRAL_REPORT_TEST_RECIPIENT") ?? ""
  )
  const imageDigest = dependencies.env("EMPLOYEE_REFERRAL_REPORT_IMAGE_DIGEST")
  if (!imageDigest || !/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
    throw new EmployeeReferralRunnerError(
      "image_digest_missing",
      "Synthetic employee referral test requires the immutable image digest"
    )
  }
  const report = buildSyntheticEmployeeReferralFixture(dependencies.buildReport)
  const subject = `${SYNTHETIC_WARNING} - ${report.subject}`
  // The renderer remains production-identical; only a plain warning is inserted after <body>.
  const safeHtml = report.html.replace(
    /<body([^>]*)>/,
    `<body$1><p><strong>${SYNTHETIC_WARNING}</strong></p>`
  )
  const providerMessageId = await dependencies.send(recipient, subject, safeHtml, {
    idempotencyKey: `employee-referral-synthetic-${createStableChecksum({ imageDigest })}`,
    attachment: {
      filename: "TEST-SYNTHETIC-employee-referrals.csv",
      content: labelSyntheticCsv(report.csv),
      contentType: "text/csv; charset=utf-8",
    },
  })
  let event: string | null = null
  // Keep the one-off task inside its 900-second ceiling while allowing bounded provider
  // propagation. Provider delivery evidence is the launch gate.
  for (let attempt = 0; attempt < SYNTHETIC_STATUS_ATTEMPTS; attempt++) {
    try {
      event = await dependencies.retrieveStatus(providerMessageId, {
        timeoutMs: SYNTHETIC_STATUS_TIMEOUT_MS,
      })
    } catch {
      // A bounded retry may recover a provider-read propagation or network delay.
    }
    if (event && ["delivered", "opened", "clicked"].includes(event)) break
    if (
      event &&
      [
        "complained",
        "failed",
        "delivery_failed",
        "bounced",
        "suppressed",
        "canceled",
      ].includes(event)
    ) {
      throw new EmployeeReferralRunnerError(
        "synthetic_delivery_failed",
        "Synthetic employee referral email reached a terminal non-delivery event",
        { providerEvent: event }
      )
    }
    if (attempt < SYNTHETIC_STATUS_ATTEMPTS - 1) {
      await dependencies.sleep(SYNTHETIC_STATUS_BACKOFF_MS)
    }
  }
  if (!event || !["delivered", "opened", "clicked"].includes(event)) {
    throw new EmployeeReferralRunnerError(
      "synthetic_delivery_unconfirmed",
      "Synthetic employee referral email did not reach provider delivery evidence",
      { providerEvent: event ?? "unavailable" }
    )
  }
  dependencies.log(
    JSON.stringify({
      event: "employee_referral_synthetic_delivered",
      provider_message_id: providerMessageId,
      provider_event: event,
    })
  )
  return { status: "delivered", providerMessageId, event }
}

function labelSyntheticCsv(csv: string): string {
  return csv
    .split("\r\n")
    .map((line, index) => {
      if (!line) return line
      return index === 0
        ? `"test_marker",${line}`
        : `"${SYNTHETIC_WARNING}",${line}`
    })
    .join("\r\n")
}

export function buildSyntheticEmployeeReferralFixture(
  buildReport: typeof buildEmployeeReferralReport = buildEmployeeReferralReport
): EmployeeReferralReport {
  const report = buildReport(syntheticSnapshot(), {
    correlationId: "synthetic-self-test",
    revision: 1,
  })
  validateRenderedReport(report)
  return report
}

export async function runEmployeeReferralWatchdog(
  overrides: Partial<EmployeeReferralRunnerDependencies> = {}
): Promise<{
  status: "healthy" | "unhealthy"
  checkedSlotCount: number
  unhealthyCount: number
  complaintCount: number
  lookupFailureCount: number
  missingDuePeriod: boolean
}> {
  const dependencies = runnerDependencies(overrides)
  const watchdogDeadlineAtMs = dependencies.clock() + WATCHDOG_DEADLINE_MS
  const now = dependencies.now()
  const nowIso = now.toISOString()
  const targets = await awaitRunnerDeadline(
    dependencies.store.listWatchdogTargets(nowIso),
    watchdogDeadlineAtMs,
    dependencies
  )
  let complaintCount = 0
  let lookupFailureCount = 0
  const unhealthy = new Set<string>()
  const periods = new Set<string>()
  const deliveredHeadRevisions = new Set<string>()

  await mapWithConcurrency(targets, WATCHDOG_CONCURRENCY, async (target) => {
    const periodKey = `${target.period_start_local}:${target.period_end_local_exclusive}`
    periods.add(periodKey)
    const targetKey = `${periodKey}:r${target.revision}:${target.recipient_slot}`
    if (target.authoritative_head && target.parent_status !== "delivered") {
      unhealthy.add(targetKey)
    }
    const stillObservable =
      target.provider_message_id &&
      target.observation_expires_at &&
      now < new Date(target.observation_expires_at)
    if (stillObservable) {
      try {
        const event = await retryStatusLookup(
          target.provider_message_id as string,
          dependencies,
          watchdogDeadlineAtMs
        )
        const parentStatus = await awaitRunnerDeadline(
          dependencies.store.recordProviderEvent({
            periodStartLocal: target.period_start_local,
            periodEndLocalExclusive: target.period_end_local_exclusive,
            revision: target.revision,
            recipientSlot: target.recipient_slot,
            providerMessageId: target.provider_message_id as string,
            providerEvent: event,
          }),
          watchdogDeadlineAtMs,
          dependencies
        )
        if (event === "complained" && target.delivery_status !== "complained") {
          complaintCount += 1
          dependencies.log(
            JSON.stringify({
              event: "employee_referral_recipient_complaint",
              period_start_local: target.period_start_local,
              period_end_local_exclusive: target.period_end_local_exclusive,
              revision: target.revision,
              recipient_slot: target.recipient_slot,
              provider_message_id: target.provider_message_id,
            })
          )
        }
        const terminalStatus = mappedTerminalProviderStatus(event)
        if (terminalStatus && target.delivery_status !== terminalStatus) {
          dependencies.log(
            JSON.stringify({
              event: "employee_referral_provider_terminal_observed",
              period_start_local: target.period_start_local,
              period_end_local_exclusive: target.period_end_local_exclusive,
              revision: target.revision,
              recipient_slot: target.recipient_slot,
              provider_message_id: target.provider_message_id,
              provider_event: event,
            })
          )
        }
        if (target.authoritative_head && parentStatus === "delivered") {
          deliveredHeadRevisions.add(`${periodKey}:r${target.revision}`)
        }
        if (
          target.authoritative_head &&
          ["sent", "queued", "scheduled", "delivery_delayed"].includes(event) &&
          now >= new Date(target.recovery_eligible_at)
        ) {
          await awaitRunnerDeadline(
            dependencies.store.markDeliveryDeadline({
              periodStartLocal: target.period_start_local,
              periodEndLocalExclusive: target.period_end_local_exclusive,
              revision: target.revision,
              recipientSlot: target.recipient_slot,
            }),
            watchdogDeadlineAtMs,
            dependencies
          )
          logCorrectionProposalOpened(dependencies, target, "delivery_deadline")
          unhealthy.add(targetKey)
        }
      } catch {
        lookupFailureCount += 1
        if (
          target.authoritative_head &&
          target.provider_message_id &&
          ["provider_accepted", "pending", "delivery_delayed"].includes(
            target.delivery_status
          ) &&
          now >= new Date(target.recovery_eligible_at)
        ) {
          await awaitRunnerDeadline(
            dependencies.store.markDeliveryDeadline({
              periodStartLocal: target.period_start_local,
              periodEndLocalExclusive: target.period_end_local_exclusive,
              revision: target.revision,
              recipientSlot: target.recipient_slot,
            }),
            watchdogDeadlineAtMs,
            dependencies
          )
          logCorrectionProposalOpened(dependencies, target, "delivery_deadline")
        }
        if (target.authoritative_head) unhealthy.add(targetKey)
      }
    } else if (
      target.authoritative_head &&
      target.delivery_status === "ambiguous" &&
      now >= new Date(target.recovery_eligible_at) &&
      (target.idempotency_expires_at === null ||
        now >= new Date(new Date(target.idempotency_expires_at).getTime() - 5 * 60_000))
    ) {
      try {
        await awaitRunnerDeadline(
          dependencies.store.markDeliveryDeadline({
            periodStartLocal: target.period_start_local,
            periodEndLocalExclusive: target.period_end_local_exclusive,
            revision: target.revision,
            recipientSlot: target.recipient_slot,
          }),
          watchdogDeadlineAtMs,
          dependencies
        )
        logCorrectionProposalOpened(dependencies, target, "dispatch_unresolved")
      } catch {
        lookupFailureCount += 1
      }
      unhealthy.add(targetKey)
    }
  })

  for (const deliveredHead of deliveredHeadRevisions) {
    for (const key of unhealthy) {
      if (key.startsWith(`${deliveredHead}:`)) unhealthy.delete(key)
    }
  }

  for (const key of periods) {
    const [start, end] = key.split(":")
    let state
    try {
      state = await awaitRunnerDeadline(
        dependencies.store.getPeriodState(start, end),
        watchdogDeadlineAtMs,
        dependencies
      )
    } catch {
      unhealthy.add(`${key}:watchdog_deadline`)
      continue
    }
    const unresolvedRecovery = state.proposals.filter(
      (proposal) =>
        proposal.kind === "delivery_recovery" &&
        (proposal.status === "open" || proposal.status === "promoted")
    )
    const openIssues = state.issues.filter((issue) => issue.status === "open")
    logOpenCorrectionProposalsFromState(
      dependencies,
      start,
      end,
      state.proposals
    )
    if (unresolvedRecovery.length || openIssues.length) unhealthy.add(`${key}:obligation`)
  }

  const duePeriods = dueScheduledPeriods(now, dependencies.env)
  let missingDuePeriod = false
  for (const due of duePeriods) {
    let state
    try {
      state = await awaitRunnerDeadline(
        dependencies.store.getPeriodState(
          due.periodStartLocal,
          due.periodEndLocalExclusive
        ),
        watchdogDeadlineAtMs,
        dependencies
      )
    } catch {
      unhealthy.add(
        `${due.periodStartLocal}:${due.periodEndLocalExclusive}:watchdog_deadline`
      )
      continue
    }
    if (state.runs.length === 0) {
      missingDuePeriod = true
      unhealthy.add(`${due.periodStartLocal}:${due.periodEndLocalExclusive}:missing`)
    }
  }
  const result = {
    status: unhealthy.size ? ("unhealthy" as const) : ("healthy" as const),
    checkedSlotCount: targets.length,
    unhealthyCount: unhealthy.size,
    complaintCount,
    lookupFailureCount,
    missingDuePeriod,
  }
  dependencies.log(
    JSON.stringify({
      event: "employee_referral_watchdog_heartbeat",
      ...result,
      observed_at: nowIso,
    })
  )
  return result
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        await worker(items[index])
      }
    }
  )
  await Promise.all(workers)
}

function mappedTerminalProviderStatus(event: string): string | null {
  if (["sent", "queued", "scheduled", "delivery_delayed"].includes(event)) {
    return null
  }
  if (["delivered", "opened", "clicked", "complained"].includes(event)) {
    return null
  }
  if (event === "failed") return "delivery_failed"
  if (["delivery_failed", "bounced", "suppressed", "canceled"].includes(event)) {
    return event
  }
  return "unknown_event"
}

function logCorrectionProposalOpened(
  dependencies: EmployeeReferralRunnerDependencies,
  target: EmployeeReferralWatchdogTarget,
  causeCode: "delivery_deadline" | "dispatch_unresolved"
): void {
  dependencies.log(
    JSON.stringify({
      event: "employee_referral_correction_proposal_opened",
      period_start_local: target.period_start_local,
      period_end_local_exclusive: target.period_end_local_exclusive,
      predecessor_revision: target.revision,
      kind: "delivery_recovery",
      cause_code: causeCode,
    })
  )
}

function logOpenCorrectionProposalsFromState(
  dependencies: EmployeeReferralRunnerDependencies,
  periodStartLocal: string,
  periodEndLocalExclusive: string,
  proposals: readonly Record<string, unknown>[]
): void {
  for (const proposal of proposals) {
    if (proposal.status !== "open" && proposal.status !== "promoted") continue
    dependencies.log(
      JSON.stringify({
        event: "employee_referral_correction_proposal_opened",
        period_start_local: periodStartLocal,
        period_end_local_exclusive: periodEndLocalExclusive,
        predecessor_revision: proposal.predecessor_revision,
        proposal_id: proposal.proposal_id,
        kind: proposal.kind,
        cause_code: proposal.cause_code,
        proposal_status: proposal.status,
      })
    )
  }
}

function requireRunnerBudget(
  dependencies: EmployeeReferralRunnerDependencies,
  deadlineAtMs: number,
  requiredRemainingMs: number,
  code: string
): void {
  if (deadlineAtMs - dependencies.clock() < requiredRemainingMs) {
    throw new EmployeeReferralRunnerError(
      code,
      "Employee referral report execution phase deadline was exhausted"
    )
  }
}

async function awaitRunnerDeadline<T>(
  operation: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  deadlineAtMs: number,
  dependencies: EmployeeReferralRunnerDependencies
): Promise<T> {
  const remaining = deadlineAtMs - dependencies.clock()
  if (remaining <= 0) {
    throw new EmployeeReferralRunnerError(
      "phase_deadline_exhausted",
      "Employee referral report execution phase deadline was exhausted"
    )
  }
  const controller = typeof operation === "function" ? new AbortController() : null
  const promise =
    typeof operation === "function"
      ? Promise.resolve().then(() => operation(controller!.signal))
      : operation
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => {
            reject(
              new EmployeeReferralRunnerError(
                "phase_deadline_exhausted",
                "Employee referral report execution phase deadline was exhausted"
              )
            )
            controller?.abort()
          },
          remaining
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function runnerDependencies(
  overrides: Partial<EmployeeReferralRunnerDependencies>
): EmployeeReferralRunnerDependencies {
  const env = overrides.env ?? readEnv
  return {
    loadSnapshot: overrides.loadSnapshot ?? loadEmployeeReferralSnapshot,
    buildReport: overrides.buildReport ?? buildEmployeeReferralReport,
    store: overrides.store ?? new EmployeeReferralReportStore(),
    send: overrides.send ?? sendEmail,
    retrieveStatus: overrides.retrieveStatus ?? retrieveEmailStatus,
    writeMasterSheet:
      overrides.writeMasterSheet ??
      ((report) => writeEmployeeReferralMasterSheet(report, { env })),
    env,
    now: overrides.now ?? (() => new Date()),
    clock: overrides.clock ?? Date.now,
    piiFingerprint:
      overrides.piiFingerprint ??
      ((value, context) => createPiiFingerprint(value, { context, dataProvenance: "live" })),
    sleep:
      overrides.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    log: overrides.log ?? console.log,
  }
}

async function dispatchClaim(input: {
  claim: EmployeeReferralDeliveryClaim
  report: EmployeeReferralReport
  revision: number
  attachmentFilename: string
  config: EmployeeReferralRecipientConfig
  requestFingerprint: string
  idempotencyKey: string
  deadlineAtMs: number
  dependencies: EmployeeReferralRunnerDependencies
}): Promise<"provider_accepted" | "transport_failed" | "ambiguous"> {
  const { claim, report, revision, dependencies } = input
  if (!claim.leaseToken) {
    throw new EmployeeReferralRunnerError(
      "claimed_slot_missing_lease",
      "Claimed employee referral recipient slot has no lease token"
    )
  }
  const leaseToken = claim.leaseToken
  requireRunnerBudget(
    dependencies,
    input.deadlineAtMs,
    25_000,
    "current_phase_deadline_before_provider_start"
  )
  await awaitRunnerDeadline(
    (signal) =>
      dependencies.store.startProviderAttempt(
        {
          periodStartLocal: report.period.periodStartLocal,
          periodEndLocalExclusive: report.period.periodEndLocalExclusive,
          revision,
          recipientSlot: claim.recipientSlot,
          leaseToken,
          providerRequestFingerprint: input.requestFingerprint,
          idempotencyKey: input.idempotencyKey,
        },
        { signal }
      ),
    input.deadlineAtMs,
    dependencies
  )
  const remainingAfterStart = input.deadlineAtMs - dependencies.clock()
  if (remainingAfterStart <= 5_000) {
    await awaitRunnerDeadline(
      (signal) =>
        dependencies.store.finalizeProviderAttempt(
          {
            periodStartLocal: report.period.periodStartLocal,
            periodEndLocalExclusive: report.period.periodEndLocalExclusive,
            revision,
            recipientSlot: claim.recipientSlot,
            leaseToken,
            status: "transport_failed",
            errorCode: "current_phase_deadline_before_dispatch",
          },
          { signal }
        ),
      input.deadlineAtMs,
      dependencies
    )
    return "transport_failed"
  }
  const recipient = input.config[claim.recipientSlot]
  const sendOptions: SendEmailOptions = {
    idempotencyKey: input.idempotencyKey,
    timeoutMs: Math.min(20_000, remainingAfterStart - 5_000),
    attachment: {
      filename: input.attachmentFilename,
      content: report.csv,
      contentType: "text/csv; charset=utf-8",
    },
  }
  let providerMessageId: string
  try {
    providerMessageId = await dependencies.send(
      recipient,
      report.subject,
      report.html,
      sendOptions
    )
  } catch (error) {
    const ambiguous = !(error instanceof EmailTransportError) || error.dispatchMayHaveOccurred
    const status = ambiguous ? "ambiguous" : "transport_failed"
    const errorCode =
      error instanceof EmailTransportError ? error.code : "unexpected_dispatch_failure"
    await awaitRunnerDeadline(
      (signal) =>
        dependencies.store.finalizeProviderAttempt(
          {
            periodStartLocal: report.period.periodStartLocal,
            periodEndLocalExclusive: report.period.periodEndLocalExclusive,
            revision,
            recipientSlot: claim.recipientSlot,
            leaseToken,
            status,
            errorCode,
          },
          { signal }
        ),
      input.deadlineAtMs,
      dependencies
    )
    return status
  }
  // A persistence failure after provider acceptance remains ambiguous. This invocation must
  // never issue another provider request or overwrite that uncertainty with a second finalize.
  await awaitRunnerDeadline(
    (signal) =>
      dependencies.store.finalizeProviderAttempt(
        {
          periodStartLocal: report.period.periodStartLocal,
          periodEndLocalExclusive: report.period.periodEndLocalExclusive,
          revision,
          recipientSlot: claim.recipientSlot,
          leaseToken,
          status: "provider_accepted",
          providerMessageId,
        },
        { signal }
      ),
    input.deadlineAtMs,
    dependencies
  )
  return "provider_accepted"
}

function requestFingerprintsForReport(
  report: EmployeeReferralReport,
  attachmentFilename: string,
  config: EmployeeReferralRecipientConfig,
  dependencies: EmployeeReferralRunnerDependencies
): Record<EmployeeReferralRecipientSlot, string> {
  return Object.fromEntries(
    (["ta_lead", "requesting_manager"] as const).map((slot) => [
      slot,
      dependencies.piiFingerprint(
        {
          from: config.from,
          to: config[slot],
          subject: report.subject,
          html: report.html,
          attachment: {
            filename: attachmentFilename,
            contentType: "text/csv; charset=utf-8",
            content: report.csv,
          },
        },
        "employee-referral-resend-request-v1"
      ),
    ])
  ) as Record<EmployeeReferralRecipientSlot, string>
}

function idempotencyKeysFor(
  period: EmployeeReferralReportPeriod,
  revision: number
): Record<EmployeeReferralRecipientSlot, string> {
  return Object.fromEntries(
    (["ta_lead", "requesting_manager"] as const).map((slot) => [
      slot,
      `employee-referral-${createStableChecksum({
        namespace: "employee-referral-monthly-report-v1",
        periodStartLocal: period.periodStartLocal,
        periodEndLocalExclusive: period.periodEndLocalExclusive,
        revision,
        recipientSlot: slot,
      })}`,
    ])
  ) as Record<EmployeeReferralRecipientSlot, string>
}

function deliveryDeadline(
  period: EmployeeReferralReportPeriod,
  revision: number,
  now: Date
): string {
  if (revision === 1 && isInitialPeriod(period)) return INITIAL_BACKFILL_DEADLINE
  if (revision > 1) return new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString()
  const end = new Date(`${period.periodEndLocalExclusive}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 2)
  return employeeReferralLocalDateTimeToUtc(end.toISOString().slice(0, 10), 12)
}

export function dueScheduledPeriods(
  now: Date,
  env: (name: string) => string | undefined
): EmployeeReferralReportPeriod[] {
  const first = env("EMPLOYEE_REFERRAL_REPORT_FIRST_SCHEDULED_PERIOD") ?? "2026-07-01"
  if (!/^\d{4}-\d{2}-01$/.test(first)) {
    throw new EmployeeReferralRunnerError(
      "first_scheduled_period_invalid",
      "Employee referral first scheduled period is invalid"
    )
  }
  const previous = createPreviousEmployeeReferralMonth(now)
  if (previous.periodStartLocal < first) return []
  const periods: EmployeeReferralReportPeriod[] = []
  let cursor = first
  while (cursor <= previous.periodStartLocal) {
    const [year, month] = cursor.split("-").map(Number)
    const endDate = new Date(Date.UTC(year, month, 1))
    const end = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, "0")}-01`
    const period = createEmployeeReferralReportPeriod(cursor, end)
    if (now >= new Date(deliveryDeadline(period, 1, now))) periods.push(period)
    cursor = end
  }
  return periods
}

function normalizeCorporateAddress(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US")
  if (!CORPORATE_EMAIL.test(normalized)) {
    throw new EmployeeReferralRunnerError(
      "corporate_recipient_required",
      "Employee referral report recipient must be a corporate address"
    )
  }
  return normalized
}

function validateRenderedReport(report: EmployeeReferralReport): void {
  if (
    report.rows.length !== report.counts.totalRowCount ||
    report.counts.totalRowCount !==
      report.counts.currentCohortCount +
        report.counts.deprecatedReviewCount +
        report.counts.ungovernedSourceReviewCount
  ) {
    throw new EmployeeReferralRunnerError(
      "rendered_count_invariant_failed",
      "Employee referral report rendered-row count invariant failed"
    )
  }
  if (!report.csv.startsWith('"record_type",') || !report.html.includes("not payout authorization")) {
    throw new EmployeeReferralRunnerError(
      "rendered_payload_invariant_failed",
      "Employee referral report output warning or schema is missing"
    )
  }
}

function referralCsvFilename(period: EmployeeReferralReportPeriod, revision: number): string {
  return `employee-referral-cohort-${period.periodStartLocal}-to-${period.periodEndLocalExclusive}-r${revision}.csv`
}

function isInitialPeriod(period: EmployeeReferralReportPeriod): boolean {
  return (
    period.periodStartLocal === INITIAL_PERIOD_START &&
    period.periodEndLocalExclusive === INITIAL_PERIOD_END
  )
}

function requiredCorrectionReason(reason: string | null | undefined): string {
  const value = reason?.trim()
  if (!value) {
    throw new EmployeeReferralRunnerError(
      "correction_reason_required",
      "Employee referral correction requires a nonblank reason"
    )
  }
  return value
}

function committedManualPreparationClaims(
  state: EmployeeReferralPeriodState,
  input: EmployeeReferralPrepareInput
): EmployeeReferralDeliveryClaim[] | null {
  if (
    input.deliveryChannel !== "manual_corporate_email" ||
    state.runs.length !== 1 ||
    state.deliveries.length !== 2 ||
    state.proposals.length !== 0 ||
    state.issues.length !== 0
  ) {
    return null
  }
  const run = state.runs[0]
  if (
    run.period_start_local !== input.period.periodStartLocal ||
    run.period_end_local_exclusive !== input.period.periodEndLocalExclusive ||
    run.revision !== input.revision ||
    run.supersedes_revision !== input.supersedesRevision ||
    run.status !== "prepared" ||
    !sameInstant(run.window_start_utc, input.period.windowStartUtc) ||
    !sameInstant(run.window_end_utc, input.period.windowEndUtc) ||
    run.source_set_fingerprint !== input.sourceSetFingerprint ||
    run.payload_fingerprint !== input.payloadFingerprint ||
    run.recipient_scope_version !== input.recipientScopeVersion ||
    run.current_cohort_count !== input.counts.currentCohortCount ||
    run.deprecated_review_count !== input.counts.deprecatedReviewCount ||
    run.ungoverned_source_review_count !== input.counts.ungovernedSourceReviewCount ||
    run.total_row_count !== input.counts.totalRowCount ||
    run.mapping_review_count !== input.counts.mappingReviewCount ||
    run.policy_version !== input.policyVersion ||
    run.policy_export_sha256 !== input.policyExportSha256 ||
    run.correction_reason !== input.correctionReason ||
    run.manual_preparation_token !== input.manualPreparationToken ||
    !sameInstant(run.delivery_deadline_at, input.deliveryDeadlineAt) ||
    typeof run.deadline_missed_at_creation !== "boolean" ||
    run.delivered_at !== null
  ) {
    return null
  }

  const deliveries = new Map<string, Record<string, unknown>>()
  for (const delivery of state.deliveries) {
    if (
      delivery.period_start_local !== input.period.periodStartLocal ||
      delivery.period_end_local_exclusive !== input.period.periodEndLocalExclusive ||
      delivery.revision !== input.revision ||
      (delivery.recipient_slot !== "ta_lead" &&
        delivery.recipient_slot !== "requesting_manager") ||
      delivery.delivery_channel !== "manual_corporate_email" ||
      delivery.status !== "prepared" ||
      delivery.attempt_count !== 0 ||
      delivery.provider_request_fingerprint !== null ||
      delivery.idempotency_key !== null ||
      delivery.lease_token !== null ||
      delivery.lease_expires_at !== null ||
      delivery.first_provider_attempt_at !== null ||
      delivery.idempotency_expires_at !== null ||
      delivery.provider_message_id !== null ||
      delivery.provider_last_event !== null ||
      delivery.manual_evidence_ref !== null ||
      delivery.error_code !== null ||
      delivery.provider_accepted_at !== null ||
      delivery.delivered_at !== null ||
      deliveries.has(delivery.recipient_slot)
    ) {
      return null
    }
    deliveries.set(delivery.recipient_slot, delivery)
  }
  if (!deliveries.has("ta_lead") || !deliveries.has("requesting_manager")) {
    return null
  }

  return (["ta_lead", "requesting_manager"] as const).map((recipientSlot) => ({
    parentStatus: "prepared",
    recipientSlot,
    deliveryStatus: "prepared",
    claimed: false,
    leaseToken: null,
    attemptCount: 0,
    providerRequestFingerprint: null,
    idempotencyKey: null,
    idempotencyExpiresAt: null,
    providerMessageId: null,
    deadlineMissedAtCreation: run.deadline_missed_at_creation as boolean,
  }))
}

function manualPreparationOwnedByAnotherInvocation(
  state: EmployeeReferralPeriodState,
  input: EmployeeReferralPrepareInput
): boolean {
  return state.runs.some(
    (run) =>
      run.period_start_local === input.period.periodStartLocal &&
      run.period_end_local_exclusive === input.period.periodEndLocalExclusive &&
      run.revision === input.revision &&
      typeof run.manual_preparation_token === "string" &&
      run.manual_preparation_token !== input.manualPreparationToken
  )
}

function sameInstant(value: unknown, expected: string): boolean {
  return typeof value === "string" && Date.parse(value) === Date.parse(expected)
}

function runResult(
  status: EmployeeReferralRunResult["status"],
  correlationId: string,
  report: EmployeeReferralReport,
  revision: number,
  claims: readonly Pick<
    EmployeeReferralDeliveryClaim,
    "recipientSlot" | "deliveryStatus" | "providerMessageId"
  >[],
  historicalReconciliation: EmployeeReferralRunResult["historicalReconciliation"] = {
    checkedPeriodCount: 0,
    driftCount: 0,
    issueCount: 0,
  }
): EmployeeReferralRunResult {
  return {
    status,
    correlationId,
    periodStartLocal: report.period.periodStartLocal,
    periodEndLocalExclusive: report.period.periodEndLocalExclusive,
    revision,
    counts: report.counts,
    recipientSlots: claims.map((claim) => ({
      recipientSlot: claim.recipientSlot,
      deliveryStatus: claim.deliveryStatus,
      providerMessageId: claim.providerMessageId,
    })),
    historicalReconciliation,
  }
}

async function reconcileHistoricalReports(
  currentPeriod: EmployeeReferralReportPeriod,
  dependencies: EmployeeReferralRunnerDependencies,
  timing: { historicalDeadlineAtMs: number; absoluteDeadlineAtMs: number }
): Promise<EmployeeReferralRunResult["historicalReconciliation"]> {
  const outcome = { checkedPeriodCount: 0, driftCount: 0, issueCount: 0 }
  let heads
  try {
    heads = await awaitRunnerDeadline(
      dependencies.store.listAuthoritativeHeads(),
      timing.historicalDeadlineAtMs,
      dependencies
    )
  } catch {
    dependencies.log(
      JSON.stringify({ event: "employee_referral_historical_inventory_failed" })
    )
    outcome.issueCount += 1
    return outcome
  }
  for (const head of heads) {
    if (head.status !== "delivered") continue
    if (
      head.period_start_local === currentPeriod.periodStartLocal &&
      head.period_end_local_exclusive === currentPeriod.periodEndLocalExclusive
    ) {
      continue
    }
    if (dependencies.clock() >= timing.historicalDeadlineAtMs) {
      outcome.issueCount += 1
      dependencies.log(
        JSON.stringify({ event: "employee_referral_historical_phase_deadline" })
      )
      break
    }
    outcome.checkedPeriodCount += 1
    let activeHead: EmployeeReferralAuthoritativeHead = head
    try {
      let reconciled = false
      for (let headAttempt = 0; headAttempt < 3; headAttempt++) {
        const period = createEmployeeReferralReportPeriod(
          activeHead.period_start_local,
          activeHead.period_end_local_exclusive
        )
        const preview = await previewEmployeeReferralReport(
          period,
          {
            revision: activeHead.revision,
            supersedesRevision:
              activeHead.revision > 1 ? activeHead.revision - 1 : null,
            deadlineAtMs: timing.historicalDeadlineAtMs,
          },
          dependencies
        )
        if (
          preview.report.policyVersion !== activeHead.policy_version ||
          preview.report.policyExportSha256 !== activeHead.policy_export_sha256
        ) {
          throw new Error("historical_policy_version_unavailable")
        }
        if (preview.payloadFingerprint !== activeHead.payload_fingerprint) {
          try {
            await awaitRunnerDeadline(
              dependencies.store.openDataDrift({
                periodStartLocal: activeHead.period_start_local,
                periodEndLocalExclusive: activeHead.period_end_local_exclusive,
                predecessorRevision: activeHead.revision,
                proposedPayloadFingerprint: preview.payloadFingerprint,
              }),
              timing.historicalDeadlineAtMs,
              dependencies
            )
          } catch (error) {
            const refreshedHead = (
              await awaitRunnerDeadline(
                dependencies.store.listAuthoritativeHeads(),
                timing.historicalDeadlineAtMs,
                dependencies
              )
            ).find(
              (candidate) =>
                candidate.period_start_local === activeHead.period_start_local &&
                candidate.period_end_local_exclusive ===
                  activeHead.period_end_local_exclusive
            )
            if (!refreshedHead || refreshedHead.revision === activeHead.revision) {
              throw error
            }
            activeHead = refreshedHead
            if (activeHead.status !== "delivered") {
              reconciled = true
              break
            }
            continue
          }
          outcome.driftCount += 1
          dependencies.log(
            JSON.stringify({
              event: "employee_referral_correction_proposal_opened",
              cause: "historical_data_drift",
              period_start_local: activeHead.period_start_local,
              period_end_local_exclusive: activeHead.period_end_local_exclusive,
              predecessor_revision: activeHead.revision,
            })
          )
        }
        const state = await awaitRunnerDeadline(
          dependencies.store.getPeriodState(
            activeHead.period_start_local,
            activeHead.period_end_local_exclusive
          ),
          timing.historicalDeadlineAtMs,
          dependencies
        )
        for (const issue of state.issues) {
          const issueRevision = Number(issue.revision)
          if (
            issue.issue_code === "historical_rediff_failed" &&
            issue.status === "open" &&
            Number.isInteger(issueRevision) &&
            issueRevision > 0
          ) {
            await awaitRunnerDeadline(
              dependencies.store.resolveReconciliationIssue({
                periodStartLocal: activeHead.period_start_local,
                periodEndLocalExclusive: activeHead.period_end_local_exclusive,
                revision: issueRevision,
                issueCode: "historical_rediff_failed",
                reason: "successful_historical_rediff",
              }),
              timing.historicalDeadlineAtMs,
              dependencies
            )
          }
        }
        reconciled = true
        break
      }
      if (!reconciled) throw new Error("historical_head_changed_repeatedly")
    } catch {
      outcome.issueCount += 1
      const issueInput = {
        periodStartLocal: activeHead.period_start_local,
        periodEndLocalExclusive: activeHead.period_end_local_exclusive,
        revision: activeHead.revision,
        issueCode: "historical_rediff_failed",
      }
      try {
        await awaitRunnerDeadline(
          dependencies.store.upsertReconciliationIssue(issueInput),
          timing.absoluteDeadlineAtMs,
          dependencies
        )
      } catch {
        // Current delivery remains successful; the PII-free log drives the monitoring fallback.
      }
      dependencies.log(
        JSON.stringify({
          event: "employee_referral_historical_reconciliation_issue",
          period_start_local: activeHead.period_start_local,
          period_end_local_exclusive: activeHead.period_end_local_exclusive,
          revision: activeHead.revision,
          issue_code: issueInput.issueCode,
        })
      )
    }
  }
  return outcome
}

async function retryStatusLookup(
  providerMessageId: string,
  dependencies: EmployeeReferralRunnerDependencies,
  deadlineAtMs = Number.POSITIVE_INFINITY
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const remaining = deadlineAtMs - dependencies.clock()
      if (remaining <= 1_000) throw new Error("status_lookup_deadline_exhausted")
      return await dependencies.retrieveStatus(providerMessageId, {
        timeoutMs: Math.min(WATCHDOG_LOOKUP_TIMEOUT_MS, remaining - 1_000),
      })
    } catch {
      if (attempt === 2) throw new Error("status_lookup_exhausted")
      const backoffMs = 250 * 2 ** attempt
      if (deadlineAtMs - dependencies.clock() <= backoffMs + 1_000) {
        throw new Error("status_lookup_deadline_exhausted")
      }
      await dependencies.sleep(backoffMs)
    }
  }
  throw new Error("status_lookup_exhausted")
}

function syntheticSnapshot(): EmployeeReferralSnapshot {
  const period = createEmployeeReferralReportPeriod("2099-01-01", "2099-02-01")
  return {
    period,
    currentOffers: [
      {
        id: 900001,
        version: 1,
        resolved_at: "2099-01-15T20:00:00Z",
        application_id: 900101,
        starts_on: "2099-02-01",
        job_id: 900201,
        status: "Accepted",
        candidate_id: 900301,
        custom_fields: { hiring_location: { value: "USA" } },
      },
    ],
    allVersionOffers: [],
    applications: [
      {
        id: 900101,
        candidate_id: 900301,
        job_id: 900201,
        status: "hired",
        source_id: 4000194004,
        referrer_id: 900401,
      },
    ],
    candidates: [{ id: 900301, first_name: "Synthetic", last_name: "Candidate" }],
    jobs: [{ id: 900201, name: "Synthetic Engineer", department_id: 4069524004 }],
    departments: [{ id: 4069524004, name: "R&D / Engineering" }],
    referrers: [{ id: 900401, user_id: 900501, name: "Synthetic Referrer" }],
    sources: [
      {
        id: 4000194004,
        name: "Referral",
        type: { id: 4000002004, name: "Referral" },
      },
    ],
    customFields: [
      {
        id: 23150958004,
        name: "Hiring Location",
        name_key: "hiring_location",
        field_type: "offer",
        active: true,
      },
    ],
  }
}
