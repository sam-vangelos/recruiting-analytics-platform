import { getSupabase } from "../supabase"
import type {
  EmployeeReferralReportCounts,
  EmployeeReferralReportPeriod,
} from "./employee-referral-report"

export type EmployeeReferralRecipientSlot = "ta_lead" | "requesting_manager"
export type EmployeeReferralDeliveryChannel = "resend" | "manual_corporate_email"

export type EmployeeReferralParentStatus =
  | "prepared"
  | "sending"
  | "provider_accepted"
  | "partially_delivered"
  | "delivered"
  | "attention_required"
  | "ambiguous"

export type EmployeeReferralDeliveryStatus =
  | "prepared"
  | "sending"
  | "provider_accepted"
  | "pending"
  | "delivery_delayed"
  | "delivered"
  | "manual_delivered"
  | "complained"
  | "transport_failed"
  | "ambiguous"
  | "delivery_failed"
  | "bounced"
  | "suppressed"
  | "canceled"
  | "unknown_event"
  | "status_unverifiable"

const PARENT_STATUSES = new Set<EmployeeReferralParentStatus>([
  "prepared",
  "sending",
  "provider_accepted",
  "partially_delivered",
  "delivered",
  "attention_required",
  "ambiguous",
])
const DELIVERY_STATUSES = new Set<EmployeeReferralDeliveryStatus>([
  "prepared",
  "sending",
  "provider_accepted",
  "pending",
  "delivery_delayed",
  "delivered",
  "manual_delivered",
  "complained",
  "transport_failed",
  "ambiguous",
  "delivery_failed",
  "bounced",
  "suppressed",
  "canceled",
  "unknown_event",
  "status_unverifiable",
])

export interface EmployeeReferralDeliveryClaim {
  parentStatus: EmployeeReferralParentStatus
  recipientSlot: EmployeeReferralRecipientSlot
  deliveryStatus: EmployeeReferralDeliveryStatus
  claimed: boolean
  leaseToken: string | null
  attemptCount: number
  providerRequestFingerprint: string | null
  idempotencyKey: string | null
  idempotencyExpiresAt: string | null
  providerMessageId: string | null
  deadlineMissedAtCreation: boolean
}

export interface EmployeeReferralPrepareInput {
  period: EmployeeReferralReportPeriod
  revision: number
  supersedesRevision: number | null
  sourceSetFingerprint: string
  payloadFingerprint: string
  recipientScopeVersion: string
  counts: EmployeeReferralReportCounts
  policyVersion: string
  policyExportSha256: string
  correctionReason: string | null
  deliveryDeadlineAt: string
  deliveryChannel?: EmployeeReferralDeliveryChannel
  manualPreparationToken?: string | null
  leaseSeconds?: number
  requestFingerprints?: Partial<Record<EmployeeReferralRecipientSlot, string>>
  idempotencyKeys?: Partial<Record<EmployeeReferralRecipientSlot, string>>
}

export interface EmployeeReferralWatchdogTarget {
  period_start_local: string
  period_end_local_exclusive: string
  revision: number
  authoritative_head: boolean
  parent_status: EmployeeReferralParentStatus
  recipient_slot: EmployeeReferralRecipientSlot
  delivery_status: EmployeeReferralDeliveryStatus
  provider_message_id: string | null
  first_provider_attempt_at: string | null
  idempotency_expires_at: string | null
  recovery_eligible_at: string
  observation_expires_at: string | null
}

export interface EmployeeReferralPeriodState {
  runs: Record<string, unknown>[]
  deliveries: Record<string, unknown>[]
  proposals: Record<string, unknown>[]
  issues: Record<string, unknown>[]
}

export interface EmployeeReferralAuthoritativeHead {
  period_start_local: string
  period_end_local_exclusive: string
  revision: number
  status: EmployeeReferralParentStatus
  payload_fingerprint: string
  policy_version: string
  policy_export_sha256: string
}

export class EmployeeReferralReportStoreError extends Error {
  readonly code: string
  readonly operation: string
  readonly outcome: "unknown" | "rejected"

  constructor(
    operation: string,
    code = "employee_referral_store_rpc_failed",
    outcome: "unknown" | "rejected" = "unknown"
  ) {
    super(`Employee referral report state operation failed: ${operation}`)
    this.name = "EmployeeReferralReportStoreError"
    this.code = code
    this.operation = operation
    this.outcome = outcome
  }
}

interface RpcResult {
  data: unknown
  error: unknown
  status?: number
  statusText?: string
}

export interface EmployeeReferralRpcClient {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult> & {
    abortSignal?: (signal: AbortSignal) => PromiseLike<RpcResult>
  }
}

interface EmployeeReferralStoreCallOptions {
  signal?: AbortSignal
}

export class EmployeeReferralReportStore {
  constructor(private readonly client?: EmployeeReferralRpcClient) {}

  async prepareAndClaim(
    input: EmployeeReferralPrepareInput,
    options: EmployeeReferralStoreCallOptions = {}
  ): Promise<EmployeeReferralDeliveryClaim[]> {
    validatePrepareInput(input)
    const data = await this.rpc("employee_referral_prepare_and_claim", {
      p_period_start_local: input.period.periodStartLocal,
      p_period_end_local_exclusive: input.period.periodEndLocalExclusive,
      p_revision: input.revision,
      p_supersedes_revision: input.supersedesRevision,
      p_window_start_utc: input.period.windowStartUtc,
      p_window_end_utc: input.period.windowEndUtc,
      p_source_set_fingerprint: input.sourceSetFingerprint,
      p_payload_fingerprint: input.payloadFingerprint,
      p_recipient_scope_version: input.recipientScopeVersion,
      p_current_cohort_count: input.counts.currentCohortCount,
      p_deprecated_review_count: input.counts.deprecatedReviewCount,
      p_ungoverned_source_review_count: input.counts.ungovernedSourceReviewCount,
      p_total_row_count: input.counts.totalRowCount,
      p_mapping_review_count: input.counts.mappingReviewCount,
      p_policy_version: input.policyVersion,
      p_policy_export_sha256: input.policyExportSha256,
      p_correction_reason: input.correctionReason,
      p_delivery_deadline_at: input.deliveryDeadlineAt,
      p_delivery_channel: input.deliveryChannel ?? "resend",
      p_lease_seconds: input.leaseSeconds ?? 300,
      p_request_fingerprints: input.requestFingerprints ?? {},
      p_idempotency_keys: input.idempotencyKeys ?? {},
      p_manual_preparation_token: input.manualPreparationToken ?? null,
    }, options)
    if (!Array.isArray(data)) throw new EmployeeReferralReportStoreError("prepare_and_claim")
    return data.map(parseClaim)
  }

  async startProviderAttempt(input: {
    periodStartLocal: string
    periodEndLocalExclusive: string
    revision: number
    recipientSlot: EmployeeReferralRecipientSlot
    leaseToken: string
    providerRequestFingerprint: string
    idempotencyKey: string
  }, options: EmployeeReferralStoreCallOptions = {}): Promise<void> {
    await this.rpc("employee_referral_start_provider_attempt", {
      p_period_start_local: input.periodStartLocal,
      p_period_end_local_exclusive: input.periodEndLocalExclusive,
      p_revision: input.revision,
      p_recipient_slot: input.recipientSlot,
      p_lease_token: input.leaseToken,
      p_provider_request_fingerprint: input.providerRequestFingerprint,
      p_idempotency_key: input.idempotencyKey,
    }, options)
  }

  async finalizeProviderAttempt(input: {
    periodStartLocal: string
    periodEndLocalExclusive: string
    revision: number
    recipientSlot: EmployeeReferralRecipientSlot
    leaseToken: string
    status: "provider_accepted" | "transport_failed" | "ambiguous"
    providerMessageId?: string | null
    errorCode?: string | null
  }, options: EmployeeReferralStoreCallOptions = {}): Promise<EmployeeReferralParentStatus> {
    return this.rpcString("employee_referral_finalize_provider_attempt", {
      p_period_start_local: input.periodStartLocal,
      p_period_end_local_exclusive: input.periodEndLocalExclusive,
      p_revision: input.revision,
      p_recipient_slot: input.recipientSlot,
      p_lease_token: input.leaseToken,
      p_status: input.status,
      p_provider_message_id: input.providerMessageId ?? null,
      p_error_code: input.errorCode ?? null,
    }, options) as Promise<EmployeeReferralParentStatus>
  }

  async recordProviderEvent(input: {
    periodStartLocal: string
    periodEndLocalExclusive: string
    revision: number
    recipientSlot: EmployeeReferralRecipientSlot
    providerMessageId: string
    providerEvent: string
  }): Promise<EmployeeReferralParentStatus> {
    return this.rpcString("employee_referral_record_provider_event", {
      p_period_start_local: input.periodStartLocal,
      p_period_end_local_exclusive: input.periodEndLocalExclusive,
      p_revision: input.revision,
      p_recipient_slot: input.recipientSlot,
      p_provider_message_id: input.providerMessageId,
      p_provider_event: input.providerEvent,
    }) as Promise<EmployeeReferralParentStatus>
  }

  async markDeliveryDeadline(input: {
    periodStartLocal: string
    periodEndLocalExclusive: string
    revision: number
    recipientSlot: EmployeeReferralRecipientSlot
  }): Promise<EmployeeReferralParentStatus> {
    return this.rpcString("employee_referral_mark_delivery_deadline", {
      p_period_start_local: input.periodStartLocal,
      p_period_end_local_exclusive: input.periodEndLocalExclusive,
      p_revision: input.revision,
      p_recipient_slot: input.recipientSlot,
    }) as Promise<EmployeeReferralParentStatus>
  }

  async openDataDrift(input: {
    periodStartLocal: string
    periodEndLocalExclusive: string
    predecessorRevision: number
    proposedPayloadFingerprint: string
  }): Promise<string> {
    return this.rpcString("employee_referral_open_data_drift", {
      p_period_start_local: input.periodStartLocal,
      p_period_end_local_exclusive: input.periodEndLocalExclusive,
      p_predecessor_revision: input.predecessorRevision,
      p_proposed_payload_fingerprint: input.proposedPayloadFingerprint,
    })
  }

  async dismissDataDrift(proposalId: string, reason: string): Promise<string> {
    return this.rpcString("employee_referral_dismiss_data_drift", {
      p_proposal_id: proposalId,
      p_reason: reason,
    })
  }

  async promoteCorrection(
    input: Omit<EmployeeReferralPrepareInput, "revision" | "supersedesRevision" | "deliveryChannel"> & {
      predecessorRevision: number
      acknowledgePossibleLateDelivery?: boolean
      lateDeliveryReason?: string | null
    },
    options: EmployeeReferralStoreCallOptions = {}
  ): Promise<number> {
    validatePrepareInput({
      ...input,
      revision: input.predecessorRevision + 1,
      supersedesRevision: input.predecessorRevision,
      deliveryChannel: "resend",
    })
    const data = await this.rpc("employee_referral_promote_correction", {
      p_period_start_local: input.period.periodStartLocal,
      p_period_end_local_exclusive: input.period.periodEndLocalExclusive,
      p_predecessor_revision: input.predecessorRevision,
      p_window_start_utc: input.period.windowStartUtc,
      p_window_end_utc: input.period.windowEndUtc,
      p_source_set_fingerprint: input.sourceSetFingerprint,
      p_payload_fingerprint: input.payloadFingerprint,
      p_recipient_scope_version: input.recipientScopeVersion,
      p_current_cohort_count: input.counts.currentCohortCount,
      p_deprecated_review_count: input.counts.deprecatedReviewCount,
      p_ungoverned_source_review_count: input.counts.ungovernedSourceReviewCount,
      p_total_row_count: input.counts.totalRowCount,
      p_mapping_review_count: input.counts.mappingReviewCount,
      p_policy_version: input.policyVersion,
      p_policy_export_sha256: input.policyExportSha256,
      p_correction_reason: input.correctionReason,
      p_delivery_deadline_at: input.deliveryDeadlineAt,
      p_acknowledge_possible_late_delivery: input.acknowledgePossibleLateDelivery ?? false,
      p_late_delivery_reason: input.lateDeliveryReason ?? null,
    }, options)
    if (!Number.isInteger(data)) throw new EmployeeReferralReportStoreError("promote_correction")
    return data as number
  }

  async recordManualDelivery(input: {
    periodStartLocal: string
    periodEndLocalExclusive: string
    revision: number
    recipientSlot: EmployeeReferralRecipientSlot
    deliveredAt: string
    manualEvidenceRef: string
  }): Promise<EmployeeReferralParentStatus> {
    return this.rpcString("employee_referral_record_manual_delivery", {
      p_period_start_local: input.periodStartLocal,
      p_period_end_local_exclusive: input.periodEndLocalExclusive,
      p_revision: input.revision,
      p_recipient_slot: input.recipientSlot,
      p_delivered_at: input.deliveredAt,
      p_manual_evidence_ref: input.manualEvidenceRef,
    }) as Promise<EmployeeReferralParentStatus>
  }

  async upsertReconciliationIssue(input: {
    periodStartLocal: string
    periodEndLocalExclusive: string
    revision: number
    issueCode: string
  }): Promise<string> {
    return this.rpcString("employee_referral_upsert_reconciliation_issue", {
      p_period_start_local: input.periodStartLocal,
      p_period_end_local_exclusive: input.periodEndLocalExclusive,
      p_revision: input.revision,
      p_issue_code: input.issueCode,
    })
  }

  async resolveReconciliationIssue(input: {
    periodStartLocal: string
    periodEndLocalExclusive: string
    revision: number
    issueCode: string
    reason: string
  }): Promise<string> {
    return this.rpcString("employee_referral_resolve_reconciliation_issue", {
      p_period_start_local: input.periodStartLocal,
      p_period_end_local_exclusive: input.periodEndLocalExclusive,
      p_revision: input.revision,
      p_issue_code: input.issueCode,
      p_reason: input.reason,
    })
  }

  async getPeriodState(
    periodStartLocal: string,
    periodEndLocalExclusive: string,
    options: EmployeeReferralStoreCallOptions = {}
  ): Promise<EmployeeReferralPeriodState> {
    const data = await this.rpc("employee_referral_get_period_state", {
      p_period_start_local: periodStartLocal,
      p_period_end_local_exclusive: periodEndLocalExclusive,
    }, options)
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new EmployeeReferralReportStoreError("get_period_state")
    }
    const state = data as Partial<EmployeeReferralPeriodState>
    if (
      !Array.isArray(state.runs) ||
      !Array.isArray(state.deliveries) ||
      !Array.isArray(state.proposals) ||
      !Array.isArray(state.issues)
    ) {
      throw new EmployeeReferralReportStoreError("get_period_state")
    }
    return state as EmployeeReferralPeriodState
  }

  async listWatchdogTargets(now: string): Promise<EmployeeReferralWatchdogTarget[]> {
    const data = await this.rpc("employee_referral_list_watchdog_targets", { p_now: now })
    if (!Array.isArray(data)) throw new EmployeeReferralReportStoreError("list_watchdog_targets")
    return data.map(parseWatchdogTarget)
  }

  async listAuthoritativeHeads(): Promise<EmployeeReferralAuthoritativeHead[]> {
    const data = await this.rpc("employee_referral_list_authoritative_heads", {})
    if (!Array.isArray(data)) {
      throw new EmployeeReferralReportStoreError("list_authoritative_heads")
    }
    return data.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new EmployeeReferralReportStoreError("list_authoritative_heads")
      }
      const row = value as Record<string, unknown>
      if (
        typeof row.period_start_local !== "string" ||
        typeof row.period_end_local_exclusive !== "string" ||
        typeof row.revision !== "number" ||
        !PARENT_STATUSES.has(row.status as EmployeeReferralParentStatus) ||
        typeof row.payload_fingerprint !== "string" ||
        typeof row.policy_version !== "string" ||
        typeof row.policy_export_sha256 !== "string"
      ) {
        throw new EmployeeReferralReportStoreError("list_authoritative_heads")
      }
      return row as unknown as EmployeeReferralAuthoritativeHead
    })
  }

  private async rpc(
    name: string,
    args: Record<string, unknown>,
    options: EmployeeReferralStoreCallOptions = {}
  ): Promise<unknown> {
    let result: RpcResult
    try {
      const client =
        this.client ?? (getSupabase() as unknown as EmployeeReferralRpcClient)
      const request = client.rpc(name, args)
      result = await (options.signal && typeof request.abortSignal === "function"
        ? request.abortSignal(options.signal)
        : request)
    } catch {
      throw new EmployeeReferralReportStoreError(name)
    }
    if (result.error) {
      throw new EmployeeReferralReportStoreError(
        name,
        isDefinitiveRpcRejection(result)
          ? "employee_referral_store_rpc_rejected"
          : "employee_referral_store_rpc_failed",
        isDefinitiveRpcRejection(result) ? "rejected" : "unknown"
      )
    }
    return result.data
  }

  private async rpcString(
    name: string,
    args: Record<string, unknown>,
    options: EmployeeReferralStoreCallOptions = {}
  ): Promise<string> {
    const data = await this.rpc(name, args, options)
    if (typeof data !== "string" || !data.trim()) {
      throw new EmployeeReferralReportStoreError(name)
    }
    return data
  }
}

function isDefinitiveRpcRejection(result: RpcResult): boolean {
  return (
    typeof result.status === "number" &&
    result.status >= 400 &&
    result.status < 500 &&
    ![408, 425, 429, 499].includes(result.status)
  )
}

function parseClaim(value: unknown): EmployeeReferralDeliveryClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EmployeeReferralReportStoreError("prepare_and_claim")
  }
  const row = value as Record<string, unknown>
  if (
    !PARENT_STATUSES.has(row.parent_status as EmployeeReferralParentStatus) ||
    (row.recipient_slot !== "ta_lead" && row.recipient_slot !== "requesting_manager") ||
    !DELIVERY_STATUSES.has(row.delivery_status as EmployeeReferralDeliveryStatus) ||
    typeof row.claimed !== "boolean" ||
    typeof row.attempt_count !== "number" ||
    !Number.isInteger(row.attempt_count) ||
    row.attempt_count < 0 ||
    typeof row.deadline_missed_at_creation !== "boolean"
  ) {
    throw new EmployeeReferralReportStoreError("prepare_and_claim")
  }
  return {
    parentStatus: row.parent_status as EmployeeReferralParentStatus,
    recipientSlot: row.recipient_slot,
    deliveryStatus: row.delivery_status as EmployeeReferralDeliveryStatus,
    claimed: row.claimed,
    leaseToken: safeNullableString(row.lease_token, /^[0-9a-f-]{36}$/i),
    attemptCount: row.attempt_count,
    providerRequestFingerprint: safeNullableString(
      row.provider_request_fingerprint,
      /^hmac-sha256:[0-9a-f]{64}$/
    ),
    idempotencyKey: safeNullableString(
      row.idempotency_key,
      /^employee-referral-[0-9a-f]{64}$/
    ),
    idempotencyExpiresAt: safeNullableTimestamp(row.idempotency_expires_at),
    providerMessageId: safeNullableString(row.provider_message_id, /^[A-Za-z0-9_-]{1,200}$/),
    deadlineMissedAtCreation: row.deadline_missed_at_creation,
  }
}

function safeNullableString(value: unknown, pattern: RegExp): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new EmployeeReferralReportStoreError("unsafe_rpc_response")
  }
  return value
}

function safeNullableTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new EmployeeReferralReportStoreError("unsafe_rpc_response")
  }
  return value
}

function parseWatchdogTarget(value: unknown): EmployeeReferralWatchdogTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EmployeeReferralReportStoreError("list_watchdog_targets")
  }
  const row = value as Record<string, unknown>
  if (
    typeof row.period_start_local !== "string" ||
    typeof row.period_end_local_exclusive !== "string" ||
    !Number.isInteger(row.revision) ||
    typeof row.authoritative_head !== "boolean" ||
    !PARENT_STATUSES.has(row.parent_status as EmployeeReferralParentStatus) ||
    (row.recipient_slot !== "ta_lead" && row.recipient_slot !== "requesting_manager") ||
    !DELIVERY_STATUSES.has(row.delivery_status as EmployeeReferralDeliveryStatus) ||
    !Object.hasOwn(row, "idempotency_expires_at") ||
    typeof row.recovery_eligible_at !== "string" ||
    !Number.isFinite(Date.parse(row.recovery_eligible_at))
  ) {
    throw new EmployeeReferralReportStoreError("list_watchdog_targets")
  }
  return {
    period_start_local: row.period_start_local,
    period_end_local_exclusive: row.period_end_local_exclusive,
    revision: row.revision as number,
    authoritative_head: row.authoritative_head,
    parent_status: row.parent_status as EmployeeReferralParentStatus,
    recipient_slot: row.recipient_slot,
    delivery_status: row.delivery_status as EmployeeReferralDeliveryStatus,
    provider_message_id: safeNullableString(
      row.provider_message_id,
      /^[A-Za-z0-9_-]{1,200}$/
    ),
    first_provider_attempt_at: safeNullableTimestamp(row.first_provider_attempt_at),
    idempotency_expires_at: safeNullableTimestamp(row.idempotency_expires_at),
    recovery_eligible_at: row.recovery_eligible_at,
    observation_expires_at: safeNullableTimestamp(row.observation_expires_at),
  }
}

function validatePrepareInput(input: EmployeeReferralPrepareInput): void {
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new EmployeeReferralReportStoreError("prepare_validation", "invalid_revision")
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.sourceSetFingerprint)) {
    throw new EmployeeReferralReportStoreError(
      "prepare_validation",
      "invalid_source_set_fingerprint"
    )
  }
  if (!/^hmac-sha256:[0-9a-f]{64}$/.test(input.payloadFingerprint)) {
    throw new EmployeeReferralReportStoreError("prepare_validation", "invalid_payload_fingerprint")
  }
  if (!/^[0-9a-f]{64}$/.test(input.policyExportSha256)) {
    throw new EmployeeReferralReportStoreError("prepare_validation", "invalid_policy_export_hash")
  }
  if (!/^scope-v[1-9][0-9]{0,9}$/.test(input.recipientScopeVersion)) {
    throw new EmployeeReferralReportStoreError("prepare_validation", "missing_recipient_scope")
  }
  if (!Number.isFinite(Date.parse(input.deliveryDeadlineAt))) {
    throw new EmployeeReferralReportStoreError("prepare_validation", "invalid_delivery_deadline")
  }
  const manualChannel = input.deliveryChannel === "manual_corporate_email"
  if (
    (manualChannel &&
      (typeof input.manualPreparationToken !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          input.manualPreparationToken
        ))) ||
    (!manualChannel && input.manualPreparationToken != null)
  ) {
    throw new EmployeeReferralReportStoreError(
      "prepare_validation",
      "invalid_manual_preparation_token"
    )
  }
  for (const slot of ["ta_lead", "requesting_manager"] as const) {
    const requestFingerprint = input.requestFingerprints?.[slot]
    const idempotencyKey = input.idempotencyKeys?.[slot]
    if (!manualChannel) {
      if (!requestFingerprint || !/^hmac-sha256:[0-9a-f]{64}$/.test(requestFingerprint)) {
        throw new EmployeeReferralReportStoreError(
          "prepare_validation",
          "invalid_request_fingerprint"
        )
      }
      if (!idempotencyKey || !/^employee-referral-[0-9a-f]{64}$/.test(idempotencyKey)) {
        throw new EmployeeReferralReportStoreError(
          "prepare_validation",
          "invalid_idempotency_key"
        )
      }
    }
  }
}
