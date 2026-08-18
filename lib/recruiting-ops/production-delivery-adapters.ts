import { getDeliverableAutomationSeed } from "./automation-seed-matrix"
import type { DeliverableAutonomyState, DeliverableReadinessState, KillSwitchState } from "./autonomy"
import { assertPublicSafe } from "./safe-public-output"
import { assertNonEmptyArray, assertNonEmptyString, validateId, type ValidationSummary } from "./substrate"

export type ProductionDeliveryTargetSystem =
  | "slack"
  | "gmail"
  | "google_sheets"
  | "google_docs"
  | "greenhouse"
  | "linkedin"
  | "power_bi"
  | "n8n"

export type ProductionDeliveryOperation = "send" | "write" | "update" | "sync"
export type ProductionDeliveryPreflightCheckId =
  | "phase_5_boundary"
  | "adapter_disabled"
  | "sam_approval"
  | "ui_mutation_controls"
  | "deliverable_binding"
  | "kill_switch"

export interface ProductionDeliveryAdapterContract {
  adapterId: string
  targetSystem: ProductionDeliveryTargetSystem
  operation: ProductionDeliveryOperation
  supportedDeliverableIds: readonly string[]
  disabledByDefault: true
  sendsEnabled: false
  writesEnabled: false
  requiresOperatorApproval: true
  noLiveExecution: true
  approvalBoundary: "phase_5_design_only"
}

export interface ProductionDeliveryRequest {
  deliverableId: string
  runId: string
  recipientFingerprint: string
  payloadFingerprint: string
  publicSummary: Record<string, unknown>
}

export interface DisabledProductionDeliveryAdapter {
  contract: ProductionDeliveryAdapterContract
  send(request: ProductionDeliveryRequest): Promise<never>
  write(request: ProductionDeliveryRequest): Promise<never>
}

export interface ProductionDeliveryPreflightInput {
  contract: ProductionDeliveryAdapterContract
  deliverableId: string
  runId: string
  requestedAt: string
  requestedBy: string
  readinessState: DeliverableReadinessState
  autonomyState: DeliverableAutonomyState
  externalAdapterApproved?: boolean
  uiMutationControlEnabled?: boolean
  /**
   * Affirmative kill-switch evidence read from the durable store (migration 019).
   * The kill_switch check passes ONLY when the store was reachable and no
   * applicable switch is engaged; absent or unreachable evidence fails closed.
   */
  killSwitchEvidence?: KillSwitchPreflightEvidence
}

export interface KillSwitchPreflightEvidence {
  storeReachable: boolean
  states: readonly KillSwitchState[]
  readAt: string
}

export interface ProductionDeliveryPreflightCheck {
  checkId: ProductionDeliveryPreflightCheckId
  status: "pass" | "fail"
  detail: string
}

export interface ProductionDeliveryPreflightResult {
  preflightId: string
  adapterId: string
  deliverableId: string
  runId: string
  targetSystem: ProductionDeliveryTargetSystem
  operation: ProductionDeliveryOperation
  status: "blocked"
  deliveryAuthorized: false
  sendReachable: false
  writeReachable: false
  checks: readonly ProductionDeliveryPreflightCheck[]
  publicSummary: Record<string, unknown>
}

export class ProductionDeliveryDisabledError extends Error {
  constructor(adapterId: string, operation: "send" | "write") {
    super(`Production delivery adapter ${adapterId} is disabled; ${operation} is unreachable in Phase 5.`)
    this.name = "ProductionDeliveryDisabledError"
  }
}

export const productionDeliveryAdapterContracts = [
  adapter("slack_delivery_disabled", "slack", "send", ["recruiter_lead_slack_draft"]),
  adapter("gmail_delivery_disabled", "gmail", "send", ["recruiting_inbox_queue"]),
  adapter("google_sheets_delivery_disabled", "google_sheets", "write", [
    "weekly_recruitment_sheet",
    "weekly_progress_sheet",
    "rps_tracking_sheet",
    "role_assignment_sheet",
    "role_pipeline_sheets",
    "pipeline_graph_sheet",
    "final_offer_sheet",
    "all_hires_sheet",
  ]),
  adapter("google_docs_delivery_disabled", "google_docs", "write", ["elt_recruiting_doc"]),
  adapter("greenhouse_delivery_disabled", "greenhouse", "update", [
    "requisition_action_queue",
    "offer_action_queue",
    "greenhouse_user_action_queue",
    "greenhouse_clarification_log",
    "duplicate_candidate_review_queue",
  ]),
  adapter("linkedin_delivery_disabled", "linkedin", "update", ["linkedin_manual_action_queue"]),
  adapter("power_bi_delivery_disabled", "power_bi", "sync", [
    "power_bi_dashboard_alerts",
    "power_bi_rls_matrix",
  ]),
  adapter("n8n_delivery_disabled", "n8n", "sync", ["n8n_custody_packet"]),
] as const satisfies readonly ProductionDeliveryAdapterContract[]

export function validateProductionDeliveryAdapterContract(
  contract: ProductionDeliveryAdapterContract
): ValidationSummary {
  validateId(contract.adapterId, "productionDeliveryAdapter.adapterId")
  assertNonEmptyString(contract.targetSystem, `${contract.adapterId}.targetSystem`)
  assertNonEmptyString(contract.operation, `${contract.adapterId}.operation`)
  assertNonEmptyArray(contract.supportedDeliverableIds, `${contract.adapterId}.supportedDeliverableIds`)
  for (const deliverableId of contract.supportedDeliverableIds) getDeliverableAutomationSeed(deliverableId)
  if (contract.disabledByDefault !== true) throw new Error(`${contract.adapterId} must be disabled by default`)
  if (contract.sendsEnabled !== false) throw new Error(`${contract.adapterId}.sendsEnabled must remain false`)
  if (contract.writesEnabled !== false) throw new Error(`${contract.adapterId}.writesEnabled must remain false`)
  if (contract.requiresOperatorApproval !== true) throw new Error(`${contract.adapterId} must require the operator approval`)
  if (contract.noLiveExecution !== true) throw new Error(`${contract.adapterId} must not expose live execution`)
  if (contract.approvalBoundary !== "phase_5_design_only") {
    throw new Error(`${contract.adapterId}.approvalBoundary must be phase_5_design_only`)
  }
  return { ok: true, id: contract.adapterId, checked: ["ids", "deliverables", "disabled", "approval"] }
}

export function validateProductionDeliveryAdapterContracts(
  contracts: readonly ProductionDeliveryAdapterContract[] = productionDeliveryAdapterContracts
): { ok: true; count: number } {
  const seen = new Set<string>()
  for (const contract of contracts) {
    validateProductionDeliveryAdapterContract(contract)
    if (seen.has(contract.adapterId)) throw new Error(`Duplicate production delivery adapter: ${contract.adapterId}`)
    seen.add(contract.adapterId)
  }
  return { ok: true, count: contracts.length }
}

export function createDisabledProductionDeliveryAdapter(
  contract: ProductionDeliveryAdapterContract
): DisabledProductionDeliveryAdapter {
  validateProductionDeliveryAdapterContract(contract)
  return {
    contract,
    async send() {
      throw new ProductionDeliveryDisabledError(contract.adapterId, "send")
    },
    async write() {
      throw new ProductionDeliveryDisabledError(contract.adapterId, "write")
    },
  }
}

export function evaluateProductionDeliveryPreflight(
  input: ProductionDeliveryPreflightInput
): ProductionDeliveryPreflightResult {
  validateProductionDeliveryAdapterContract(input.contract)
  validateId(input.deliverableId, "productionDeliveryPreflight.deliverableId")
  validateId(input.runId, "productionDeliveryPreflight.runId")
  assertNonEmptyString(input.requestedAt, "productionDeliveryPreflight.requestedAt")
  assertNonEmptyString(input.requestedBy, "productionDeliveryPreflight.requestedBy")
  const checks = [
    check("phase_5_boundary", "fail", "Phase 5 is interface/design only; production delivery cannot be authorized."),
    check(
      "adapter_disabled",
      input.contract.sendsEnabled === false && input.contract.writesEnabled === false ? "pass" : "fail",
      "Adapter send/write flags must remain disabled."
    ),
    check(
      "sam_approval",
      input.externalAdapterApproved === true ? "fail" : "pass",
      input.externalAdapterApproved === true
        ? "Approval state cannot activate production delivery during Phase 5."
        : "No approved production delivery adapter is active."
    ),
    check(
      "ui_mutation_controls",
      input.uiMutationControlEnabled === true ? "fail" : "pass",
      input.uiMutationControlEnabled === true
        ? "UI mutation controls are enabled; Phase 5 requires disabled design only."
        : "UI mutation controls are disabled."
    ),
    check(
      "deliverable_binding",
      input.contract.supportedDeliverableIds.includes(input.deliverableId) ? "pass" : "fail",
      "Deliverable must be explicitly bound to the disabled adapter contract."
    ),
    // AUTONOMY-1/P4: the kill switch lives at the send/write chokepoint. The check
    // passes ONLY on affirmative durable-store evidence (reachable + no applicable
    // switch engaged); no evidence or an unreachable store fails closed — the
    // preflight never claims the switch is provably disengaged without proof.
    evaluateKillSwitchPreflightCheck(input),
  ]
  const publicSummary = {
    adapterId: input.contract.adapterId,
    targetSystem: input.contract.targetSystem,
    operation: input.contract.operation,
    deliverableId: input.deliverableId,
    readinessState: input.readinessState,
    autonomyState: input.autonomyState,
    deliveryAuthorized: false,
    sendReachable: false,
    writeReachable: false,
    failedCheckCount: checks.filter((item) => item.status === "fail").length,
  }
  assertPublicSafe(publicSummary, "productionDeliveryPreflight.publicSummary")
  return {
    preflightId: `preflight_${input.contract.adapterId}_${input.runId}`,
    adapterId: input.contract.adapterId,
    deliverableId: input.deliverableId,
    runId: input.runId,
    targetSystem: input.contract.targetSystem,
    operation: input.contract.operation,
    status: "blocked",
    deliveryAuthorized: false,
    sendReachable: false,
    writeReachable: false,
    checks,
    publicSummary,
  }
}

function evaluateKillSwitchPreflightCheck(input: ProductionDeliveryPreflightInput): ProductionDeliveryPreflightCheck {
  const evidence = input.killSwitchEvidence
  if (!evidence) {
    return check(
      "kill_switch",
      "fail",
      "No durable kill-switch evidence supplied; the send chokepoint fails closed until the store is read and provably disengaged."
    )
  }
  if (!evidence.storeReachable) {
    return check("kill_switch", "fail", "Durable kill-switch store was unreachable; the send chokepoint fails closed.")
  }
  const engaged = evidence.states.filter((state) => state.enabled)
  const applicable = engaged.filter((state) => killSwitchAppliesToDeliverable(state, input.deliverableId))
  if (applicable.length > 0) {
    const scopes = applicable.map((state) => `${state.scope}:${state.scopeId}`).join(", ")
    return check("kill_switch", "fail", `Kill switch engaged (${scopes}); the send chokepoint is closed.`)
  }
  return check(
    "kill_switch",
    "pass",
    `Durable kill-switch store read at ${evidence.readAt}: no applicable switch is engaged.`
  )
}

function killSwitchAppliesToDeliverable(state: KillSwitchState, deliverableId: string): boolean {
  if (state.scope === "global") return true
  if (state.scope === "deliverable") return state.scopeId === deliverableId
  if (state.scope === "capability") {
    return state.scopeId === getDeliverableAutomationSeed(deliverableId).capabilityId
  }
  // recipient_scope switches cannot be resolved at this preflight (no recipient
  // context); an ENGAGED one blocks conservatively rather than being ignored.
  return true
}

function adapter(
  adapterId: string,
  targetSystem: ProductionDeliveryTargetSystem,
  operation: ProductionDeliveryOperation,
  supportedDeliverableIds: readonly string[]
): ProductionDeliveryAdapterContract {
  return {
    adapterId,
    targetSystem,
    operation,
    supportedDeliverableIds,
    disabledByDefault: true,
    sendsEnabled: false,
    writesEnabled: false,
    requiresOperatorApproval: true,
    noLiveExecution: true,
    approvalBoundary: "phase_5_design_only",
  }
}

function check(
  checkId: ProductionDeliveryPreflightCheckId,
  status: ProductionDeliveryPreflightCheck["status"],
  detail: string
): ProductionDeliveryPreflightCheck {
  return { checkId, status, detail }
}
