import {
  DELIVERABLE_AUTONOMY_STATES,
  DELIVERABLE_LANES,
  DELIVERABLE_READINESS_STATES,
  STALE_BEHAVIORS,
  getRecipientScopeRule,
  type DeliverableAutonomyState,
  type DeliverableLane,
  type DeliverableReadinessState,
  type StaleBehavior,
} from "./autonomy"
import { getDeliverableAutomationSeed } from "./automation-seed-matrix"
import { getCapability } from "./capabilities"
import { outputContractRegistry, type OutputContractRegistryRow } from "./registries"
import {
  assertBlockersAndGate,
  assertKnownSourceIds,
  assertKnownWorkflowIds,
  assertNonEmptyArray,
  assertProductionDisabled,
  assertProvenance,
  validateId,
  type ArtifactFormat,
  type ProvenanceReference,
  type ValidationSummary,
} from "./substrate"

export type OutputValueType = "string" | "number" | "date" | "boolean"
export type OutputPiiPolicy = "public_safe" | "internal_review_identifiers" | "restricted"

export interface OutputColumnContract {
  key: string
  label: string
  valueType: OutputValueType
  required: boolean
  manual: boolean
  publicSummarySafe: boolean
}

export interface ConcreteOutputContract {
  id: string
  sourceContractId: string
  workflowIds: readonly string[]
  renderer: OutputContractRegistryRow["renderer"]
  format: ArtifactFormat
  schemaVersion: string
  capabilityId: string
  lane: DeliverableLane
  initialAutonomyState: DeliverableAutonomyState
  freshnessTtlMinutes: number
  staleBehavior: StaleBehavior
  recipientScopeRuleIds: readonly string[]
  deliveryLogRequired: true
  deliveryAuthorizationRequired: true
  columns: readonly OutputColumnContract[]
  manualFields: readonly string[]
  validationChecks: readonly string[]
  piiPolicy: OutputPiiPolicy
  sourceIds: readonly string[]
  productionWriteEnabled: false
  provenance: readonly ProvenanceReference[]
  blockers: readonly string[]
  nextGate: string
}

export interface OutputReadinessAuthorizationSummary {
  deliverableId: string
  readinessState: DeliverableReadinessState
  structurallyReady: boolean
  deliveryAuthorizationRequired: true
  deliveryAuthorized: false
}

export const concreteOutputContracts = [
  concreteContract("final_offer_sheet", "csv", "internal_review_identifiers", [
    column("application_id", "Application ID", "string"),
    column("job_id", "Job ID", "string"),
    column("offer_id", "Offer ID", "string"),
    column("offer_status", "Offer status", "string"),
    column("month_bucket", "Month", "string"),
    column("recruiter_name", "Recruiter", "string", false),
  ]),
  concreteContract("rps_tracking_sheet", "csv", "internal_review_identifiers", [
    column("application_id", "Application ID", "string"),
    column("job_id", "Job ID", "string"),
    column("interview_id", "Interview ID", "string"),
    column("interview_stage", "Interview stage", "string"),
    column("scorecard_status", "Scorecard status", "string"),
    column("week_bucket", "Week", "string"),
    column("interviewer_name", "Interviewer", "string", false),
    column("submitter_name", "Submitter", "string", false),
    column("team_name", "Team", "string"),
    column("match_mismatch", "Match/Mismatch", "string"),
    column("overall_recommendation", "Recommendation", "string", false),
  ]),
  concreteContract("role_pipeline_sheets", "csv", "internal_review_identifiers", [
    column("application_id", "Application ID", "string"),
    column("job_id", "Job ID", "string"),
    column("req_id", "Req ID", "string"),
    column("stage_name", "Stage", "string"),
    column("core_stage", "Core stage", "string"),
    column("stage_changed_at", "Stage changed at", "date"),
    column("week_bucket", "Week", "string"),
    column("dedupe_key", "Dedupe key", "string"),
  ]),
  concreteContract("weekly_progress_sheet", "csv", "public_safe", [
    column("req_group", "Req group", "string"),
    column("stage_name", "Stage", "string"),
    column("core_stage", "Core stage", "string"),
    column("movement_count", "Movement count", "number"),
    column("week_bucket", "Week", "string"),
  ]),
  concreteContract("pipeline_graph_sheet", "csv", "public_safe", [
    column("req_group", "Req group", "string"),
    column("week_bucket", "Week", "string"),
    column("stage_name", "Stage", "string"),
    column("stage_order", "Stage order", "number"),
    column("core_stage", "Core stage", "string"),
    column("core_stage_order", "Core stage order", "number"),
    column("movement_count", "Movement count", "number"),
    column("total_movement_count", "Total movements", "number"),
    column("movement_share", "Movement share", "number"),
  ]),
  concreteContract("role_assignment_sheet", "csv", "public_safe", [
    column("view_type", "View type", "string"),
    column("job_id", "Job ID", "string"),
    column("recruiter_name", "Recruiter", "string"),
    column("sourcer_name", "Sourcer", "string", false),
    column("pod_name", "Pod", "string", false),
    column("openings_count", "Openings", "number"),
    column("workload_count", "Workload count", "number"),
  ]),
  concreteContract("weekly_recruitment_sheet", "csv", "public_safe", [
    column("job_id", "Job ID", "string"),
    column("req_status", "Req status", "string"),
    column("pipeline_count", "Pipeline count", "number"),
    column("offer_count", "Offer count", "number"),
    column("rps_missing_count", "RPS missing count", "number"),
    column("openings_count", "Openings", "number"),
    column("recruiter_name", "Recruiter", "string"),
    column("week_bucket", "Week", "string"),
    column("billable", "Billable", "string"),
    column("priority", "Priority", "string"),
    column("role_type", "Role type", "string"),
    column("job_health", "Job health", "string"),
    column("job_progress", "Job progress", "string"),
    column("comments", "Comments", "string", false),
  ]),
  concreteContract("elt_recruiting_doc", "csv", "internal_review_identifiers", [
    column("section_id", "Section ID", "string"),
    column("section_title", "Section title", "string"),
    column("week_bucket", "Week", "string"),
    column("metric_key", "Metric key", "string"),
    column("metric_value", "Metric value", "number"),
    column("narrative_draft", "Narrative draft", "string"),
    column("human_review_required", "Human review required", "boolean"),
    column("source_workflow_ids", "Source workflows", "string"),
  ]),
  concreteContract("all_hires_sheet", "csv", "internal_review_identifiers", [
    column("row_type", "Row type", "string"),
    column("entity_id", "Entity ID", "string"),
    column("status", "Status", "string"),
    column("event_date", "Event date", "date"),
    column("owner", "Owner", "string", false),
    column("source_system", "Source system", "string"),
    column("custody_status", "Custody status", "string"),
    column("review_required", "Review required", "boolean"),
  ]),
  concreteContract("recruiter_daily_sheet", "csv", "public_safe", [
    column("gate_id", "Gate ID", "string"),
    column("status", "Status", "string"),
    column("last_run_date", "Last run date", "date"),
    column("template_preserved", "Template preserved", "boolean"),
    column("resume_requested", "Resume requested", "boolean"),
    column("reason", "Reason", "string"),
    column("next_gate", "Next gate", "string"),
  ]),
  concreteContract("rc_tracker_sheet", "csv", "public_safe", [
    column("rc_id", "RC ID", "string"),
    column("status", "Status", "string"),
    column("owner", "Owner", "string"),
    column("last_updated_at", "Last updated at", "date"),
    column("exception_flag", "Exception flag", "boolean"),
    column("exception_reason", "Exception reason", "string", false),
    column("follow_up_required", "Follow-up required", "boolean"),
  ]),
  concreteContract("power_bi_dashboard_alerts", "csv", "public_safe", [
    column("dashboard_id", "Dashboard ID", "string"),
    column("dashboard_title", "Dashboard title", "string"),
    column("workspace_name", "Workspace", "string"),
    column("refresh_status", "Refresh status", "string"),
    column("last_refresh_at", "Last refresh at", "date"),
    column("owner", "Owner", "string", false),
    column("alert_severity", "Alert severity", "string"),
    column("triage_required", "Triage required", "boolean"),
  ]),
  concreteContract("power_bi_rls_matrix", "csv", "public_safe", [
    column("row_type", "Row type", "string"),
    column("entity_id", "Entity ID", "string"),
    column("status", "Status", "string"),
    column("owner", "Owner", "string"),
    column("workspace_name", "Workspace", "string", false),
    column("dashboard_id", "Dashboard ID", "string", false),
    column("access_scope", "Access scope", "string", false),
    column("vendor_name", "Vendor", "string", false),
    column("coordination_topic", "Coordination topic", "string", false),
    column("payment_status", "Payment status", "string", false),
    column("review_required", "Review required", "boolean"),
  ]),
  concreteContract("duplicate_candidate_review_queue", "csv", "internal_review_identifiers", [
    column("case_id", "Case ID", "string"),
    column("primary_application_id", "Primary application ID", "string"),
    column("duplicate_application_id", "Duplicate application ID", "string"),
    column("confidence", "Confidence", "number"),
    column("match_signals", "Match signals", "string"),
    column("review_status", "Review status", "string"),
    column("custody_status", "Custody status", "string"),
    column("owner", "Owner", "string", false),
    column("review_required", "Review required", "boolean"),
  ]),
  concreteContract("n8n_custody_packet", "csv", "public_safe", [
    column("row_type", "Row type", "string"),
    column("entity_id", "Entity ID", "string"),
    column("workflow_id", "Workflow ID", "string"),
    column("status", "Status", "string"),
    column("owner", "Owner", "string", false),
    column("observed_at", "Observed at", "date", false),
    column("dry_run_status", "Dry-run status", "string"),
    column("evidence_captured", "Evidence captured", "boolean"),
    column("review_required", "Review required", "boolean"),
    column("blocker_reason", "Blocker reason", "string", false),
  ]),
  concreteContract("apps_script_asset_registry", "csv", "public_safe", [
    column("asset_id", "Asset ID", "string"),
    column("workflow_id", "Workflow ID", "string"),
    column("project_name", "Project name", "string"),
    column("export_status", "Export status", "string"),
    column("trigger_status", "Trigger status", "string"),
    column("scope_status", "Scope status", "string"),
    column("custody_posture", "Custody posture", "string"),
    column("owner", "Owner", "string", false),
    column("captured_at", "Captured at", "date", false),
    column("rotation_required", "Rotation required", "boolean"),
    column("review_required", "Review required", "boolean"),
    column("blocker_reason", "Blocker reason", "string", false),
  ]),
  concreteContract("recruiter_lead_slack_draft", "csv", "public_safe", [
    column("lead_id", "Lead ID", "string"),
    column("lead_name", "Lead name", "string"),
    column("target_channel_label", "Target channel label", "string", false),
    column("req_group", "Req group", "string"),
    column("week_bucket", "Week", "string"),
    column("movement_count", "Movement count", "number"),
    column("stalled_count", "Stalled count", "number"),
    column("offer_count", "Offer count", "number"),
    column("draft_body", "Draft body", "string"),
    column("source_workflow_ids", "Source workflows", "string"),
    column("human_send_required", "Human send required", "boolean"),
    column("review_required", "Review required", "boolean"),
  ]),
  concreteContract("validation_signoff_log", "csv", "public_safe", [
    column("target_id", "Target ID", "string"),
    column("workflow_id", "Workflow ID", "string"),
    column("run_id", "Run ID", "string"),
    column("validation_status", "Validation status", "string"),
    column("attestation_status", "Attestation status", "string"),
    column("owner", "Owner", "string"),
    column("evidence_count", "Evidence count", "number"),
    column("open_discrepancy_count", "Open discrepancies", "number"),
    column("blocking_count", "Blocking count", "number"),
    column("source_gap_count", "Source gaps", "number"),
    column("next_gate", "Next gate", "string"),
    column("review_required", "Review required", "boolean"),
  ]),
  concreteContract("handoff_readiness_dashboard", "csv", "public_safe", [
    column("area_id", "Area ID", "string"),
    column("area_name", "Area name", "string"),
    column("category", "Category", "string"),
    column("readiness_status", "Readiness status", "string"),
    column("sam_signoff_status", "the operator signoff status", "string"),
    column("owner", "Owner", "string"),
    column("evidence_count", "Evidence count", "number"),
    column("blocker_count", "Blocker count", "number"),
    column("acceptance_required", "Acceptance required", "boolean"),
    column("next_gate", "Next gate", "string"),
    column("review_required", "Review required", "boolean"),
  ]),
  concreteContract("requisition_action_queue", "csv", "public_safe", actionQueueColumns()),
  concreteContract("offer_action_queue", "csv", "public_safe", actionQueueColumns()),
  concreteContract("greenhouse_user_action_queue", "csv", "public_safe", actionQueueColumns()),
  concreteContract("linkedin_manual_action_queue", "csv", "public_safe", actionQueueColumns()),
  concreteContract("google_groups_action_queue", "csv", "public_safe", actionQueueColumns()),
  concreteContract("greenhouse_clarification_log", "csv", "public_safe", supportQueueColumns()),
  concreteContract("recruiting_inbox_queue", "csv", "public_safe", supportQueueColumns()),
  concreteContract("exec_state_of_play_snapshot", "csv", "internal_review_identifiers", [
    column("req_id", "Req", "string", false),
    column("role", "Role", "string"),
    column("department", "Department", "string"),
    column("req_class", "Req class", "string"),
    column("owner", "Owner", "string", false),
    column("seats", "Open seats", "number"),
    column("days_open", "Days open", "number", false),
    column("engaged_depth", "Beyond screen", "number"),
    column("application_pile", "Application pile", "number"),
    column("furthest_stage", "Furthest stage", "string", false),
    column("conducted_last7", "Interviews last 7d", "number"),
    column("conducted_prior7", "Interviews prior 7d", "number"),
    column("pending_writeups", "Pending write-ups", "number"),
    column("advanced_last7", "Advances last 7d", "number"),
    column("advanced_prior7", "Advances prior 7d", "number"),
    column("added_last7", "Added last 7d", "number"),
    column("conducted_last30", "Interviews last 30d", "number"),
    column("advanced_last30", "Advances last 30d", "number"),
    column("added_last30", "Added last 30d", "number"),
    column("last_advance_at", "Last stage advance", "string", false),
    column("last_hire_accepted_on", "Last hire accepted", "string", false),
    column("tier", "Tier", "string"),
    column("tier_rule", "Tier rule", "string"),
    column("tier_reason", "Tier reason", "string"),
    column("momentum", "Momentum", "string"),
    column("health", "Health", "string"),
    column("health_reason", "Health reason", "string"),
    column("offers_accepted_12wk", "Offers accepted (12 wk)", "number"),
  ]),
] as const satisfies readonly ConcreteOutputContract[]

export function validateConcreteOutputContract(contract: ConcreteOutputContract): ValidationSummary {
  validateId(contract.id, "concreteOutputContract.id")
  validateId(contract.sourceContractId, `${contract.id}.sourceContractId`)
  validateId(contract.capabilityId, `${contract.id}.capabilityId`)
  assertKnownWorkflowIds(contract.workflowIds, `${contract.id}.workflowIds`)
  assertKnownSourceIds(contract.sourceIds, `${contract.id}.sourceIds`)
  assertProductionDisabled(contract.productionWriteEnabled, `${contract.id}.productionWriteEnabled`)
  assertProvenance(contract.provenance, `${contract.id}.provenance`)
  assertBlockersAndGate(contract)
  assertOutputAutomationFields(contract)
  if (!/^\d+\.\d+\.\d+$/.test(contract.schemaVersion)) {
    throw new Error(`${contract.id}.schemaVersion must use semver`)
  }
  if (contract.columns.length === 0) throw new Error(`${contract.id}.columns must not be empty`)
  for (const outputColumn of contract.columns) {
    validateId(outputColumn.key, `${contract.id}.columns.key`)
  }
  return {
    ok: true,
    id: contract.id,
    checked: [
      "ids",
      "workflows",
      "sources",
      "schema",
      "columns",
      "automation",
      "readinessAuthorizationSplit",
      "productionDisabled",
    ],
  }
}

export function validateConcreteOutputContracts(): { ok: true; count: number } {
  for (const contract of concreteOutputContracts) validateConcreteOutputContract(contract)
  return { ok: true, count: concreteOutputContracts.length }
}

export function summarizeOutputReadinessAuthorization(
  contract: ConcreteOutputContract,
  readinessState: DeliverableReadinessState
): OutputReadinessAuthorizationSummary {
  validateConcreteOutputContract(contract)
  assertKnownValue(readinessState, DELIVERABLE_READINESS_STATES, `${contract.id}.readinessState`)
  return {
    deliverableId: contract.sourceContractId,
    readinessState,
    structurallyReady: ["ready_for_review", "ready_with_warnings", "ready_for_delivery"].includes(readinessState),
    deliveryAuthorizationRequired: true,
    deliveryAuthorized: false,
  }
}

function concreteContract(
  sourceContractId: string,
  format: ArtifactFormat,
  piiPolicy: OutputPiiPolicy,
  columns: readonly OutputColumnContract[]
): ConcreteOutputContract {
  const source = outputContractRegistry.find((row) => row.id === sourceContractId)
  if (!source) throw new Error(`Unknown output contract seed: ${sourceContractId}`)
  const automation = getDeliverableAutomationSeed(sourceContractId)
  return {
    id: `${sourceContractId}_v1`,
    sourceContractId,
    workflowIds: source.workflowIds,
    renderer: source.renderer,
    format,
    schemaVersion: "1.0.0",
    capabilityId: automation.capabilityId,
    lane: automation.lane,
    initialAutonomyState: automation.initialAutonomyState,
    freshnessTtlMinutes: automation.freshnessTtlMinutes,
    staleBehavior: automation.staleBehavior,
    recipientScopeRuleIds: automation.recipientScopeRuleIds,
    deliveryLogRequired: true,
    deliveryAuthorizationRequired: true,
    columns,
    manualFields: source.manualFields,
    validationChecks: source.validationChecks,
    piiPolicy: automation.piiPolicy,
    sourceIds: source.sourceIds,
    productionWriteEnabled: false,
    provenance: source.provenance,
    blockers: source.blockers,
    nextGate: "Render local artifact and compare only against useful legacy evidence before any adapter gate.",
  }
}

function column(
  key: string,
  label: string,
  valueType: OutputValueType,
  required = true,
  manual = false
): OutputColumnContract {
  return { key, label, valueType, required, manual, publicSummarySafe: true }
}

function actionQueueColumns(): readonly OutputColumnContract[] {
  return [
    column("proposal_id", "Proposal ID", "string"),
    column("workflow_id", "Workflow ID", "string"),
    column("target_system", "Target system", "string"),
    column("target_reference", "Target reference", "string"),
    column("action_type", "Action type", "string"),
    column("risk_tier", "Risk tier", "string"),
    column("approval_state", "Approval state", "string"),
    column("evidence_count", "Evidence count", "number"),
    column("payload_fingerprint", "Payload fingerprint", "string"),
    column("defer_until", "Defer until", "date", false),
    column("defer_reason", "Defer reason", "string", false),
    column("manual_execution_attested_at", "Manual execution attested at", "date", false),
    column("manual_execution_attested_by", "Manual execution attested by", "string", false),
    column("external_reference", "External reference", "string", false),
    column("no_live_execution", "No live execution", "boolean"),
    column("review_required", "Review required", "boolean"),
  ]
}

function assertOutputAutomationFields(contract: ConcreteOutputContract): void {
  const capability = getCapability(contract.capabilityId)
  if (!capability.deliverableIds.includes(contract.sourceContractId)) {
    throw new Error(`${contract.id}.capabilityId does not own ${contract.sourceContractId}`)
  }
  assertKnownValue(contract.lane, DELIVERABLE_LANES, `${contract.id}.lane`)
  assertKnownValue(contract.initialAutonomyState, DELIVERABLE_AUTONOMY_STATES, `${contract.id}.initialAutonomyState`)
  assertKnownValue(contract.staleBehavior, STALE_BEHAVIORS, `${contract.id}.staleBehavior`)
  if (!Number.isInteger(contract.freshnessTtlMinutes) || contract.freshnessTtlMinutes <= 0) {
    throw new Error(`${contract.id}.freshnessTtlMinutes must be a positive integer`)
  }
  assertNonEmptyArray(contract.recipientScopeRuleIds, `${contract.id}.recipientScopeRuleIds`)
  for (const ruleId of contract.recipientScopeRuleIds) getRecipientScopeRule(ruleId)
  if (contract.deliveryLogRequired !== true) throw new Error(`${contract.id}.deliveryLogRequired must be true`)
  if (contract.deliveryAuthorizationRequired !== true) {
    throw new Error(`${contract.id}.deliveryAuthorizationRequired must be true`)
  }
}

function assertKnownValue<const T extends readonly string[]>(value: string, allowed: T, label: string): asserts value is T[number] {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} is invalid: ${value}`)
  }
}

function supportQueueColumns(): readonly OutputColumnContract[] {
  return [
    column("item_id", "Item ID", "string"),
    column("workflow_id", "Workflow ID", "string"),
    column("source_system", "Source system", "string"),
    column("category", "Category", "string"),
    column("status", "Status", "string"),
    column("owner", "Owner", "string", false),
    column("evidence_count", "Evidence count", "number"),
    column("draft_response", "Draft response", "string", false),
    column("human_action_required", "Human action required", "boolean"),
    column("review_required", "Review required", "boolean"),
    column("next_gate", "Next gate", "string"),
  ]
}
