import {
  validateDeliverableAutonomyContracts,
  type AutoEligibility,
  type DeliverableAutonomyContract,
  type DeliverableAutonomyState,
  type DeliverableLane,
  type DeliverableReadinessState,
  type StaleBehavior,
} from "./autonomy"
import { outputContractRegistry } from "./registries"

const WEEKLY_TTL_MINUTES = 7 * 24 * 60
const DAILY_TTL_MINUTES = 24 * 60

const AUTO_READINESS = ["ready_for_review", "ready_with_warnings", "ready_for_delivery", "blocked"] as const
const REVIEW_READINESS = ["draft_only", "ready_for_review", "ready_with_warnings", "blocked"] as const
const ACTION_READINESS = ["draft_only", "ready_for_review", "blocked", "human_only"] as const
const NEVER_AUTO_READINESS = ["blocked", "human_only"] as const

export interface DeliverableAutomationSeedRow extends DeliverableAutonomyContract {
  source: "docs/recruiting-ops/AUTOMATION_DELIVERABLE_SEED_MATRIX.md"
}

export const deliverableAutomationSeedMatrix = [
  seed(
    "final_offer_sheet",
    "offer_and_hire_lifecycle_intelligence",
    "review_assisted",
    "review_required",
    "blocked",
    4,
    ["leadership_visibility"],
    "internal_review_identifiers",
    WEEKLY_TTL_MINUTES,
    "block",
    REVIEW_READINESS,
    ["review_required"],
    "Contains offer/hire lifecycle rows with internal identifiers; stakeholder delivery needs review until audience-specific summaries exist."
  ),
  seed(
    "all_hires_sheet",
    "offer_and_hire_lifecycle_intelligence",
    "review_assisted",
    "review_required",
    "blocked",
    4,
    ["internal_audit"],
    "internal_review_identifiers",
    DAILY_TTL_MINUTES,
    "block",
    REVIEW_READINESS,
    ["review_required"],
    "All-hires custody and status context is operationally sensitive until scoped views are defined."
  ),
  seedCandidate("rps_tracking_sheet", "scorecard_accountability", ["recruiter_scoped_visibility"], "internal_review_identifiers"),
  seed(
    "role_pipeline_sheets",
    "pipeline_movement_intelligence",
    "review_assisted",
    "shadow",
    "blocked",
    4,
    ["recruiter_scoped_visibility"],
    "internal_review_identifiers",
    WEEKLY_TTL_MINUTES,
    "block",
    REVIEW_READINESS,
    ["shadow", "review_required"],
    "Detailed pipeline rows can contain internal identifiers; auto-delivery requires recruiter-scoped recipient views."
  ),
  seedCandidate("weekly_progress_sheet", "pipeline_movement_intelligence", ["recruiter_scoped_visibility"], "public_safe"),
  seedCandidate("pipeline_graph_sheet", "pipeline_movement_intelligence", ["team_scoped_visibility"], "public_safe"),
  seedCandidate("role_assignment_sheet", "ownership_capacity_management", ["team_scoped_visibility"], "public_safe"),
  seed(
    "weekly_recruitment_sheet",
    "structured_hiring_status",
    "review_assisted",
    "review_required",
    "blocked",
    4,
    ["leadership_visibility"],
    "public_safe",
    WEEKLY_TTL_MINUTES,
    "warn",
    REVIEW_READINESS,
    ["review_required"],
    "Leadership-priority fields remain human-owned and need review before delivery."
  ),
  seed(
    "elt_recruiting_doc",
    "stakeholder_narrative_generation",
    "review_assisted",
    "review_required",
    "blocked",
    4,
    ["leadership_visibility"],
    "internal_review_identifiers",
    WEEKLY_TTL_MINUTES,
    "warn",
    REVIEW_READINESS,
    ["review_required"],
    "Narrative and leadership-sensitive framing require human review."
  ),
  seed(
    "recruiter_lead_slack_draft",
    "stakeholder_narrative_generation",
    "review_assisted",
    "review_required",
    "blocked",
    4,
    ["team_scoped_visibility"],
    "public_safe",
    WEEKLY_TTL_MINUTES,
    "warn",
    REVIEW_READINESS,
    ["review_required"],
    "Slack content is a draft over deterministic facts; sending remains human-owned."
  ),
  seedNeverAuto(
    "requisition_action_queue",
    "requisition_lifecycle_control",
    "review_required",
    ["admin_action_review"],
    "public_safe",
    "Opening, closing, or updating requisitions is a mutation and requires human execution."
  ),
  seedNeverAuto(
    "offer_action_queue",
    "offer_administration",
    "never_auto",
    ["admin_action_review"],
    "public_safe",
    "Offer approval or offer mutation is irreversible/sensitive and must never auto-execute."
  ),
  seedNeverAuto(
    "greenhouse_user_action_queue",
    "access_and_identity_administration",
    "never_auto",
    ["admin_action_review"],
    "public_safe",
    "Access grants and identity changes require human execution."
  ),
  seedNeverAuto(
    "linkedin_manual_action_queue",
    "access_and_identity_administration",
    "never_auto",
    ["admin_action_review"],
    "public_safe",
    "LinkedIn identity/admin work must remain manual and externally controlled."
  ),
  seedNeverAuto(
    "google_groups_action_queue",
    "access_and_identity_administration",
    "never_auto",
    ["admin_action_review"],
    "public_safe",
    "Google group membership affects access and must never auto-execute."
  ),
  seed(
    "recruiting_inbox_queue",
    "recruiting_inbox_triage",
    "review_assisted",
    "review_required",
    "blocked",
    7,
    ["admin_action_review"],
    "public_safe",
    DAILY_TTL_MINUTES,
    "block",
    REVIEW_READINESS,
    ["review_required"],
    "Drafts and triage can be assisted, but human sends and owns responses."
  ),
  seed(
    "greenhouse_clarification_log",
    "recruiting_inbox_triage",
    "review_assisted",
    "review_required",
    "blocked",
    7,
    ["admin_action_review"],
    "public_safe",
    DAILY_TTL_MINUTES,
    "block",
    REVIEW_READINESS,
    ["review_required"],
    "Clarification decisions can affect recruiting process state and need review."
  ),
  seedNeverAuto(
    "duplicate_candidate_review_queue",
    "candidate_identity_resolution",
    "never_auto",
    ["admin_action_review"],
    "internal_review_identifiers",
    "Candidate merge/no-merge adjudication is candidate-impacting and must never auto-execute."
  ),
  seedCandidate("rc_tracker_sheet", "external_artifact_monitoring", ["internal_audit"], "public_safe", DAILY_TTL_MINUTES),
  seedCandidate("power_bi_dashboard_alerts", "external_artifact_monitoring", ["internal_audit"], "public_safe"),
  seedNeverAuto(
    "power_bi_rls_matrix",
    "external_artifact_monitoring",
    "review_required",
    ["admin_action_review"],
    "public_safe",
    "RLS/access/vendor coordination affects permissions and payment-adjacent work; human execution required."
  ),
  seed(
    "recruiter_daily_sheet",
    "automation_custody",
    "review_assisted",
    "review_required",
    "blocked",
    4,
    ["internal_audit"],
    "public_safe",
    DAILY_TTL_MINUTES,
    "block",
    REVIEW_READINESS,
    ["review_required"],
    "Transitional automation custody output; replacement/retirement decisions need review."
  ),
  seed(
    "n8n_custody_packet",
    "automation_custody",
    "review_assisted",
    "review_required",
    "blocked",
    4,
    ["internal_audit"],
    "public_safe",
    WEEKLY_TTL_MINUTES,
    "block",
    REVIEW_READINESS,
    ["review_required"],
    "Credential/export custody and rotation risks require human review."
  ),
  seed(
    "apps_script_asset_registry",
    "automation_custody",
    "review_assisted",
    "review_required",
    "blocked",
    4,
    ["internal_audit"],
    "public_safe",
    WEEKLY_TTL_MINUTES,
    "block",
    REVIEW_READINESS,
    ["review_required"],
    "Script ownership/export/trigger custody requires human review and may expose credential rotation needs."
  ),
  seed(
    "validation_signoff_log",
    "transition_readiness_control",
    "review_assisted",
    "review_required",
    "blocked",
    4,
    ["internal_audit"],
    "public_safe",
    DAILY_TTL_MINUTES,
    "block",
    REVIEW_READINESS,
    ["review_required"],
    "Signoff is human-owned; automation can collect evidence only."
  ),
  seed(
    "handoff_readiness_dashboard",
    "transition_readiness_control",
    "review_assisted",
    "review_required",
    "blocked",
    4,
    ["internal_audit"],
    "public_safe",
    WEEKLY_TTL_MINUTES,
    "block",
    REVIEW_READINESS,
    ["review_required"],
    "Retirement/cutover readiness requires human signoff."
  ),
  seed(
    "exec_state_of_play_snapshot",
    "structured_hiring_status",
    "review_assisted",
    "review_required",
    "blocked",
    4,
    ["leadership_visibility"],
    "internal_review_identifiers",
    DAILY_TTL_MINUTES,
    "block",
    REVIEW_READINESS,
    ["review_required"],
    "Carries finalist candidate names and Greenhouse profile links for the exec page; delivery beyond the authed page requires review."
  ),
] as const satisfies readonly DeliverableAutomationSeedRow[]

export const deliverableAutonomyContracts: readonly DeliverableAutonomyContract[] = deliverableAutomationSeedMatrix

export function getDeliverableAutomationSeed(deliverableId: string): DeliverableAutomationSeedRow {
  const row = deliverableAutomationSeedMatrix.find((item) => item.deliverableId === deliverableId)
  if (!row) throw new Error(`Unknown deliverable automation seed: ${deliverableId}`)
  return row
}

export function validateDeliverableAutomationSeedMatrix(): { ok: true; count: number } {
  validateDeliverableAutonomyContracts(deliverableAutomationSeedMatrix)
  assertOneToOneWithOutputContracts()
  for (const row of deliverableAutomationSeedMatrix) {
    if (row.autoEligibility === "candidate" && row.shadowRunRequirement <= 0) {
      throw new Error(`${row.deliverableId}.shadowRunRequirement must be positive for auto-delivery candidates`)
    }
    if (row.autoEligibility === "never_auto" && !row.neverAutoReason?.trim()) {
      throw new Error(`${row.deliverableId}.neverAutoReason is required`)
    }
    if (row.autoEligibility === "blocked" && !row.blockedReason?.trim()) {
      throw new Error(`${row.deliverableId}.blockedReason is required`)
    }
  }
  return { ok: true, count: deliverableAutomationSeedMatrix.length }
}

function seedCandidate(
  deliverableId: string,
  capabilityId: string,
  recipientScopeRuleIds: readonly string[],
  piiPolicy: DeliverableAutonomyContract["piiPolicy"],
  freshnessTtlMinutes = WEEKLY_TTL_MINUTES
): DeliverableAutomationSeedRow {
  return seed(
    deliverableId,
    capabilityId,
    "auto_delivery",
    "shadow",
    "candidate",
    4,
    recipientScopeRuleIds,
    piiPolicy,
    freshnessTtlMinutes,
    "block",
    AUTO_READINESS,
    ["shadow", "auto_eligible", "auto_paused"]
  )
}

function seedNeverAuto(
  deliverableId: string,
  capabilityId: string,
  initialAutonomyState: Extract<DeliverableAutonomyState, "review_required" | "never_auto">,
  recipientScopeRuleIds: readonly string[],
  piiPolicy: DeliverableAutonomyContract["piiPolicy"],
  neverAutoReason: string
): DeliverableAutomationSeedRow {
  return seed(
    deliverableId,
    capabilityId,
    "action_proposal",
    initialAutonomyState,
    "never_auto",
    0,
    recipientScopeRuleIds,
    piiPolicy,
    DAILY_TTL_MINUTES,
    "block",
    initialAutonomyState === "never_auto" ? NEVER_AUTO_READINESS : ACTION_READINESS,
    initialAutonomyState === "never_auto" ? ["never_auto"] : ["review_required", "never_auto"],
    undefined,
    neverAutoReason
  )
}

function seed(
  deliverableId: string,
  capabilityId: string,
  lane: DeliverableLane,
  initialAutonomyState: DeliverableAutonomyState,
  autoEligibility: AutoEligibility,
  shadowRunRequirement: number,
  recipientScopeRuleIds: readonly string[],
  piiPolicy: DeliverableAutonomyContract["piiPolicy"],
  freshnessTtlMinutes: number,
  staleBehavior: StaleBehavior,
  readinessStatesAllowed: readonly DeliverableReadinessState[],
  eligibleAutonomyStates: readonly DeliverableAutonomyState[],
  blockedReason?: string,
  neverAutoReason?: string
): DeliverableAutomationSeedRow {
  return {
    deliverableId,
    capabilityId,
    lane,
    initialAutonomyState,
    eligibleAutonomyStates,
    readinessStatesAllowed,
    recipientScopeRuleIds,
    freshnessTtlMinutes,
    staleBehavior,
    piiPolicy,
    shadowRunRequirement,
    autoEligibility,
    blockedReason,
    neverAutoReason,
    source: "docs/recruiting-ops/AUTOMATION_DELIVERABLE_SEED_MATRIX.md",
  }
}

function assertOneToOneWithOutputContracts(): void {
  const seedIds = deliverableAutomationSeedMatrix.map((row) => row.deliverableId)
  const outputIds = outputContractRegistry.map((row) => row.id)
  const missing = outputIds.filter((id) => !seedIds.includes(id))
  if (missing.length > 0) throw new Error(`Seed matrix missing deliverables: ${missing.join(", ")}`)
  const extra = seedIds.filter((id) => !outputIds.includes(id))
  if (extra.length > 0) throw new Error(`Seed matrix has unknown deliverables: ${extra.join(", ")}`)
  const duplicates = seedIds.filter((id, index) => seedIds.indexOf(id) !== index)
  if (duplicates.length > 0) throw new Error(`Seed matrix has duplicate deliverables: ${duplicates.join(", ")}`)
}
