import {
  outputContractRegistry,
  requiredWorkflowIds,
  workflowRegistry,
} from "./registries"

/**
 * Capability registry — the capability-first product source of truth.
 *
 * A capability owns a durable (or, for the handover window, transitional)
 * recruiting-ops outcome consumed by a real audience through a deliverable.
 * Workbook task IDs (`T##`/`S##`/`Q##`) are legacy coverage/provenance only:
 * every workflow maps to exactly one capability here, but capabilities — not
 * workflow IDs — are the primary product abstraction. See
 * `docs/recruiting-ops/CAPABILITY_NORTH_STAR.md`.
 */

export const CAPABILITY_DURABILITIES = ["durable", "transitional"] as const
export const CAPABILITY_SUNSET_STATES = ["active", "sunsetting", "retired_by_signoff"] as const

export type CapabilityDurability = (typeof CAPABILITY_DURABILITIES)[number]
export type CapabilitySunsetState = (typeof CAPABILITY_SUNSET_STATES)[number]

export interface AudienceContract {
  audience: string
  consumptionPurpose: string
  cadence: string
  deliverableIds: readonly string[]
  deliveryMechanism: string
  piiPosture: string
  humanGate: string
}

export interface CapabilityRegistryRow {
  capabilityId: string
  outcome: string
  durability: CapabilityDurability
  /** Required when `durability` is `transitional`; the sunset path for handover-only capabilities. */
  sunsetState?: CapabilitySunsetState
  audiences: readonly AudienceContract[]
  consumptionPurposes: readonly string[]
  deliverableIds: readonly string[]
  automationBoundary: string
  humanGates: readonly string[]
  evidenceRefs: readonly string[]
  /** Legacy coverage: workbook workflow IDs this capability subsumes. */
  workflowIds: readonly string[]
  /** Runnable module IDs that declare this `capabilityId`. */
  moduleIds: readonly string[]
}

export const requiredCapabilityIds = [
  "offer_and_hire_lifecycle_intelligence",
  "scorecard_accountability",
  "pipeline_movement_intelligence",
  "ownership_capacity_management",
  "structured_hiring_status",
  "stakeholder_narrative_generation",
  "requisition_lifecycle_control",
  "offer_administration",
  "access_and_identity_administration",
  "recruiting_inbox_triage",
  "candidate_identity_resolution",
  "external_artifact_monitoring",
  "automation_custody",
  "transition_readiness_control",
] as const

export const capabilityRegistry: readonly CapabilityRegistryRow[] = [
  {
    capabilityId: "offer_and_hire_lifecycle_intelligence",
    outcome: "Monitor offer, accepted-hire, and start-readiness lifecycle health, including recruiter/team throughput vs target.",
    durability: "durable",
    audiences: [
      {
        audience: "Operator, recruiting leadership, HODs",
        consumptionPurpose: "Visibility, exception review, escalation prevention",
        cadence: "Weekly/monthly plus exception-driven",
        deliverableIds: ["final_offer_sheet", "all_hires_sheet"],
        deliveryMechanism: "Command Center, local CSV/JSON",
        piiPosture: "Aggregated or operational rows; no public candidate contact fields",
        humanGate: "Operator reviews before stakeholder delivery; no live writes",
      },
    ],
    consumptionPurposes: ["visibility", "exception_review", "escalation_prevention"],
    deliverableIds: ["final_offer_sheet", "all_hires_sheet"],
    automationBoundary: "Automate offer/hire lifecycle facts, stuck-offer detection, and recruiter/team target-vs-actual; human reviews stakeholder delivery.",
    humanGates: ["Operator reviews before stakeholder delivery", "no live writes"],
    evidenceRefs: ["T07", "T08", "Q12", "final_offer_sheet", "all_hires_apps_script"],
    workflowIds: ["T07", "T08"],
    moduleIds: ["t07-final-offer", "t08-all-hires-tracker"],
  },
  {
    capabilityId: "scorecard_accountability",
    outcome: "Make interview/scorecard ownership, overdue accountability, interviewer match/mismatch, and screening volume by team visible.",
    durability: "durable",
    audiences: [
      {
        audience: "Recruiters, hiring managers, recruiting leads, operator",
        consumptionPurpose: "Accountability, exception review, escalation",
        cadence: "Weekly plus exception-driven",
        deliverableIds: ["rps_tracking_sheet"],
        deliveryMechanism: "Command Center, local CSV",
        piiPosture: "Owner/task-level rows; no raw candidate payloads in public summaries",
        humanGate: "Operator approves nudges/escalations",
      },
    ],
    consumptionPurposes: ["accountability", "exception_review", "escalation", "throughput_visibility"],
    deliverableIds: ["rps_tracking_sheet"],
    automationBoundary: "Automate scorecard/interview facts, overdue detection, interviewer match/mismatch, and per-team screening volume; human approves nudges.",
    humanGates: ["Operator approves nudges/escalations"],
    evidenceRefs: ["T05", "Q11", "rps_tracking_sheet"],
    workflowIds: ["T05"],
    moduleIds: ["t05-rps", "scorecard-accountability-shadow"],
  },
  {
    capabilityId: "pipeline_movement_intelligence",
    outcome: "Monitor stage movement, stalled candidates, and pipeline progress.",
    durability: "durable",
    audiences: [
      {
        audience: "Operator, recruiter leads, leadership",
        consumptionPurpose: "Visibility, pipeline diagnosis, escalation prevention",
        cadence: "Weekly plus exception-driven",
        deliverableIds: ["role_pipeline_sheets", "weekly_progress_sheet", "pipeline_graph_sheet"],
        deliveryMechanism: "Command Center, local CSV/JSON",
        piiPosture: "Aggregate by role/stage by default; detailed rows internal only",
        humanGate: "Operator reviews stakeholder output",
      },
    ],
    consumptionPurposes: ["visibility", "pipeline_diagnosis", "escalation_prevention"],
    deliverableIds: ["role_pipeline_sheets", "weekly_progress_sheet", "pipeline_graph_sheet"],
    automationBoundary: "Automate stage-movement signals and progress over a shared stage taxonomy; human reviews stakeholder output.",
    humanGates: ["Operator reviews stakeholder output"],
    evidenceRefs: ["T02", "T03", "T04", "Q04", "Q10", "role_pipeline_sheets"],
    workflowIds: ["T02", "T03", "T04"],
    moduleIds: ["t02-pipeline", "t03-progress", "t04-pipeline-graph", "recruiter-weekly-req-progress-shadow"],
  },
  {
    capabilityId: "ownership_capacity_management",
    outcome: "Show recruiter/owner workload, unmapped ownership, and capacity risk.",
    durability: "durable",
    audiences: [
      {
        audience: "Operator, recruiting leads",
        consumptionPurpose: "Planning, accountability, operational hygiene",
        cadence: "Weekly",
        deliverableIds: ["role_assignment_sheet"],
        deliveryMechanism: "Command Center, local CSV",
        piiPosture: "Owner/job-level rows; no public candidate payloads",
        humanGate: "Operator approves reassignment proposals",
      },
    ],
    consumptionPurposes: ["planning", "accountability", "operational_hygiene"],
    deliverableIds: ["role_assignment_sheet"],
    automationBoundary: "Automate workload/unmapped-owner detection over the shared recruiter→team dimension; human approves reassignment.",
    humanGates: ["Operator approves reassignment proposals"],
    evidenceRefs: ["T09", "Q13", "Q14", "role_assignment_sheet"],
    workflowIds: ["T09"],
    moduleIds: ["t09-ownership", "ownership-capacity-shadow"],
  },
  {
    capabilityId: "structured_hiring_status",
    outcome: "Produce the org-wide weekly hiring-status rollup (req/headcount/offer/pipeline) with leadership-priority fields, composed from capability facts.",
    durability: "durable",
    audiences: [
      {
        audience: "Bob/CEO, executives, HODs, operator",
        consumptionPurpose: "Visibility, operational control, escalation prevention",
        cadence: "Weekly",
        deliverableIds: ["weekly_recruitment_sheet"],
        deliveryMechanism: "Command Center, local CSV first; later Sheet behind approval",
        piiPosture: "Aggregate and leadership-safe; candidate details excluded by default",
        humanGate: "Operator reviews and finalizes; leadership-priority fields stay human-owned",
      },
      {
        audience: "Bob/CEO, executives",
        consumptionPurpose: "Bookmarkable state-of-play: what is open, what needs attention and why, what moved, who is close to a hire",
        cadence: "Continuous (scheduled runs)",
        deliverableIds: ["exec_state_of_play_snapshot"],
        deliveryMechanism: "Authed /state-of-play page over the durable snapshot; ELT facts artifact for the weekly doc",
        piiPosture: "Finalist names + Greenhouse profile links only; no emails, no raw application ids",
        humanGate: "Operator reviews the page before exec rollout; delivery beyond the authed page requires review",
      },
    ],
    consumptionPurposes: ["visibility", "operational_control", "escalation_prevention"],
    deliverableIds: ["weekly_recruitment_sheet", "exec_state_of_play_snapshot"],
    automationBoundary: "Compose the structured req-status rollup from offer/pipeline/ownership facts and pre-fill draftable fields; Billable/Priority/Role Type/Job Health/Progress/Comments stay human-owned. E01 derives health/momentum from scorecard-truthed activity with reason strings on every row.",
    humanGates: ["Operator reviews and finalizes", "leadership-priority fields human-owned", "exec page reviewed before rollout"],
    evidenceRefs: ["T01", "Q01", "Q02", "Q03", "weekly_recruitment_sheet", "E01", "exec_state_of_play_snapshot"],
    workflowIds: ["T01", "E01"],
    moduleIds: ["t01-weekly-leadership", "exec-state-of-play"],
  },
  {
    capabilityId: "stakeholder_narrative_generation",
    outcome: "Draft leadership/ELT and recruiter-lead narrative artifacts over computed facts; the numbers are deterministic, the model only drafts the sentence.",
    durability: "durable",
    audiences: [
      {
        audience: "ELT, org heads, recruiter leads, operator",
        consumptionPurpose: "Narrative/context, alignment, escalation prevention",
        cadence: "Weekly",
        deliverableIds: ["elt_recruiting_doc", "recruiter_lead_slack_draft"],
        deliveryMechanism: "Local Markdown/Doc/CSV first; later Doc/Slack with approval",
        piiPosture: "Aggregate and leadership-safe; candidate details excluded by default",
        humanGate: "Operator reviews and sends; human owns the story",
      },
    ],
    consumptionPurposes: ["narrative_context", "alignment", "escalation_prevention"],
    deliverableIds: ["elt_recruiting_doc", "recruiter_lead_slack_draft"],
    automationBoundary: "Draft narrative over structured_hiring_status and pipeline/offer facts; human reviews and sends. Never generate the figures, only the prose describing them.",
    humanGates: ["Operator reviews and sends", "human owns the narrative"],
    evidenceRefs: ["T06", "T18", "elt_recruiting_doc", "recruiter_lead_slack_draft"],
    workflowIds: ["T06", "T18"],
    moduleIds: ["t06-elt-recruiting-updates", "t18-recruiter-lead-slack-updates"],
  },
  {
    capabilityId: "requisition_lifecycle_control",
    outcome: "Reconcile open/tracked/excluded/closed requisitions and stage requisition action proposals (the weekly engine behind the hiring-status report).",
    durability: "durable",
    audiences: [
      {
        audience: "the operator, RecOps owner, approved admins",
        consumptionPurpose: "Operational control, visibility, approval, audit",
        cadence: "Daily/weekly plus ad hoc",
        deliverableIds: ["requisition_action_queue"],
        deliveryMechanism: "Command Center, local artifacts; production adapters later only by approval",
        piiPosture: "Req/role metadata and redacted payload fingerprints",
        humanGate: "Human approval required to open/update a requisition",
      },
    ],
    consumptionPurposes: ["operational_control", "visibility", "approval", "audit"],
    deliverableIds: ["requisition_action_queue"],
    automationBoundary: "Detect open-vs-tracked-vs-excluded-vs-closed req drift and stage dry-run proposals; the human opens/updates the requisition.",
    humanGates: ["Human approval required for every requisition action", "dry-run only"],
    evidenceRefs: ["S01", "T01", "requisition_action_queue"],
    workflowIds: ["S01"],
    moduleIds: ["s01-requisition-action-queue"],
  },
  {
    capabilityId: "offer_administration",
    outcome: "Stage human-gated offer-administration proposals (approve/update); offer analytics live in offer-and-hire-lifecycle intelligence.",
    durability: "durable",
    audiences: [
      {
        audience: "the operator, RecOps owner, approved admins",
        consumptionPurpose: "Operational control, approval, audit",
        cadence: "Daily/ad hoc",
        deliverableIds: ["offer_action_queue"],
        deliveryMechanism: "Command Center, local artifacts; production adapters later only by approval",
        piiPosture: "Redacted summaries and payload fingerprints",
        humanGate: "Offer approval is never-tier; human owns execution",
      },
    ],
    consumptionPurposes: ["operational_control", "approval", "audit"],
    deliverableIds: ["offer_action_queue"],
    automationBoundary: "Surface pending offers and stage dry-run update proposals; offer approval stays never-tier and human-owned.",
    humanGates: ["Offer approval never-tier", "dry-run only", "human owns execution"],
    evidenceRefs: ["S02", "offer_action_queue"],
    workflowIds: ["S02"],
    moduleIds: ["s02-offer-action-queue"],
  },
  {
    capabilityId: "access_and_identity_administration",
    outcome: "Stage human-gated access/identity proposals for Greenhouse users, LinkedIn seats, and Google Groups; execution stays human-owned.",
    durability: "durable",
    audiences: [
      {
        audience: "the operator, RecOps owner, approved admins",
        consumptionPurpose: "Operational control, approval, audit",
        cadence: "Ad hoc",
        deliverableIds: ["greenhouse_user_action_queue", "linkedin_manual_action_queue", "google_groups_action_queue"],
        deliveryMechanism: "Command Center, local artifacts; no provisioning/auth implementation",
        piiPosture: "Role/scope metadata and redacted summaries; no credentials",
        humanGate: "Access grants are human-owned; dry-run proposals only",
      },
    ],
    consumptionPurposes: ["operational_control", "approval", "audit"],
    deliverableIds: ["greenhouse_user_action_queue", "linkedin_manual_action_queue", "google_groups_action_queue"],
    automationBoundary: "Detect and stage access/identity proposals (dry-run). Explicitly excludes scoped-MCP / auth / provisioning implementation; a human executes every grant.",
    humanGates: ["Access grants human-owned", "dry-run only", "no provisioning implementation"],
    evidenceRefs: ["S05", "S06", "S07", "greenhouse_user_action_queue"],
    workflowIds: ["S05", "S06", "S07"],
    moduleIds: ["s05-greenhouse-user-action-queue", "s06-linkedin-manual-action-queue", "s07-google-groups-action-queue"],
  },
  {
    capabilityId: "recruiting_inbox_triage",
    outcome: "Triage the recruiting inbox and Greenhouse clarification cases — categorize, draft, and log decisions; sending stays human.",
    durability: "durable",
    audiences: [
      {
        audience: "the operator, RecOps owner",
        consumptionPurpose: "Operational control, exception review, audit",
        cadence: "Daily/ad hoc",
        deliverableIds: ["recruiting_inbox_queue", "greenhouse_clarification_log"],
        deliveryMechanism: "Command Center, local artifacts; human-send only",
        piiPosture: "Case/item metadata and redacted summaries; no candidate payloads",
        humanGate: "Human sends every response; clarification decisions human-owned",
      },
    ],
    consumptionPurposes: ["operational_control", "exception_review", "audit"],
    deliverableIds: ["recruiting_inbox_queue", "greenhouse_clarification_log"],
    automationBoundary: "Triage/categorize inbound mail and clarification cases and draft responses; a human sends and owns the decision.",
    humanGates: ["Human-send required", "clarification decisions human-owned"],
    evidenceRefs: ["S03", "S04", "recruiting_inbox_queue", "greenhouse_clarification_log"],
    workflowIds: ["S03", "S04"],
    moduleIds: ["s03-greenhouse-clarification-log", "s04-recruiting-inbox-queue"],
  },
  {
    capabilityId: "candidate_identity_resolution",
    outcome: "Surface duplicate/dual-agency candidate conflicts for review.",
    durability: "durable",
    audiences: [
      {
        audience: "the operator, RecOps/admin owners",
        consumptionPurpose: "Exception review, financial risk reduction, audit",
        cadence: "Exception-driven",
        deliverableIds: ["duplicate_candidate_review_queue"],
        deliveryMechanism: "Command Center action queue, local CSV/JSON",
        piiPosture: "Internal review only; minimized candidate identifiers",
        humanGate: "Human adjudication required; no auto-merge",
      },
    ],
    consumptionPurposes: ["exception_review", "financial_risk_reduction", "audit"],
    deliverableIds: ["duplicate_candidate_review_queue"],
    automationBoundary: "Automate duplicate detection; human adjudicates merge/no-merge.",
    humanGates: ["Human adjudication required", "no auto-merge"],
    evidenceRefs: ["T15", "n8n_duplicate_workflow", "mailgun_evidence"],
    workflowIds: ["T15"],
    moduleIds: ["t15-duplicate-candidate-review"],
  },
  {
    capabilityId: "external_artifact_monitoring",
    outcome: "Track health of legacy sheets, dashboards, vendor packets, and alerts.",
    durability: "transitional",
    sunsetState: "active",
    audiences: [
      {
        audience: "the operator, systems owners, vendor owners",
        consumptionPurpose: "Dependency management, continuity, escalation",
        cadence: "Weekly/ad hoc",
        deliverableIds: ["rc_tracker_sheet", "power_bi_dashboard_alerts", "power_bi_rls_matrix"],
        deliveryMechanism: "Command Center, local evidence packet",
        piiPosture: "Metadata only unless explicitly approved",
        humanGate: "the operator or named owner resolves",
      },
    ],
    consumptionPurposes: ["dependency_management", "continuity", "escalation"],
    deliverableIds: ["rc_tracker_sheet", "power_bi_dashboard_alerts", "power_bi_rls_matrix"],
    automationBoundary: "Automate health/alert ingestion and triage; human resolves and owns vendor coordination.",
    humanGates: ["the operator or named owner resolves"],
    evidenceRefs: ["T12", "T13", "T14", "power_bi", "vendor"],
    workflowIds: ["T12", "T13", "T14"],
    moduleIds: ["t12-rc-tracker-monitoring", "t13-power-bi-dashboard-monitoring", "t14-power-bi-rls-coordination"],
  },
  {
    capabilityId: "automation_custody",
    outcome: "Capture, classify, preserve, replace, or retire legacy automations; flag exposed credentials for rotation before preserve/export.",
    durability: "transitional",
    sunsetState: "active",
    audiences: [
      {
        audience: "the operator, systems owner",
        consumptionPurpose: "Transition safety, retirement planning, operational control",
        cadence: "Transition/ad hoc",
        deliverableIds: ["recruiter_daily_sheet", "n8n_custody_packet", "apps_script_asset_registry"],
        deliveryMechanism: "Command Center evidence view, local JSON/CSV",
        piiPosture: "No secrets; no copied credentials",
        humanGate: "the operator signs replacement/retirement decisions; exposed secrets flagged for rotation",
      },
    ],
    consumptionPurposes: ["transition_safety", "retirement_planning", "operational_control"],
    deliverableIds: ["recruiter_daily_sheet", "n8n_custody_packet", "apps_script_asset_registry"],
    automationBoundary: "Automate inventory/custody evidence and exposed-credential detection; human signs replacement/retirement; no secret capture, rotation flagged before any preserve/export.",
    humanGates: ["the operator signs replacement/retirement decisions", "exposed credentials flagged for rotation"],
    evidenceRefs: ["T10", "T16", "T17", "apps_script", "n8n", "mailgun"],
    workflowIds: ["T10", "T16", "T17"],
    moduleIds: ["t10-recruiter-daily-report", "t16-n8n-workflow-setup", "t17-apps-script-development"],
  },
  {
    capabilityId: "transition_readiness_control",
    outcome: "Track handoff readiness, signoff evidence, and unresolved transition risk.",
    durability: "transitional",
    sunsetState: "active",
    audiences: [
      {
        audience: "Jordan",
        consumptionPurpose: "Handoff readiness, audit, transition safety",
        cadence: "Transition",
        deliverableIds: ["validation_signoff_log", "handoff_readiness_dashboard"],
        deliveryMechanism: "Command Center, local Markdown/CSV",
        piiPosture: "Internal operational metadata",
        humanGate: "the operator signs off closure",
      },
    ],
    consumptionPurposes: ["handoff_readiness", "audit", "transition_safety"],
    deliverableIds: ["validation_signoff_log", "handoff_readiness_dashboard"],
    automationBoundary: "Automate readiness/signoff tracking; human signs off closure.",
    humanGates: ["the operator signs off closure"],
    evidenceRefs: ["T19", "T20/T21", "transition_tracker"],
    workflowIds: ["T19", "T20/T21"],
    moduleIds: ["t19-validation-coordination", "t20-t21-handoff-preparation"],
  },
]

export interface CapabilityRegistryValidationResult {
  ok: true
  counts: {
    capabilities: number
    durable: number
    transitional: number
  }
}

export function validateCapabilityRegistry(): CapabilityRegistryValidationResult {
  const knownWorkflowIds = new Set<string>(requiredWorkflowIds)
  const knownDeliverableIds = new Set(outputContractRegistry.map((row) => row.id))
  const knownWorkflowRowIds = new Set(workflowRegistry.map((row) => row.id))

  assertCapabilityIds()

  const moduleOwners = new Map<string, string>()
  const workflowOwners = new Map<string, string>()

  for (const row of capabilityRegistry) {
    assertRowContract(row)

    if (row.durability === "transitional" && !row.sunsetState) {
      throw new Error(`capability ${row.capabilityId} is transitional and must declare a sunsetState`)
    }
    if (row.durability === "durable" && row.sunsetState) {
      throw new Error(`capability ${row.capabilityId} is durable and must not declare a sunsetState`)
    }

    for (const workflowId of row.workflowIds) {
      if (!knownWorkflowIds.has(workflowId) || !knownWorkflowRowIds.has(workflowId)) {
        throw new Error(`capability ${row.capabilityId} maps unknown workflow ${workflowId}`)
      }
      const existing = workflowOwners.get(workflowId)
      if (existing) throw new Error(`workflow ${workflowId} mapped by both ${existing} and ${row.capabilityId}`)
      workflowOwners.set(workflowId, row.capabilityId)
    }

    for (const moduleId of row.moduleIds) {
      const existing = moduleOwners.get(moduleId)
      if (existing) throw new Error(`module ${moduleId} mapped by both ${existing} and ${row.capabilityId}`)
      moduleOwners.set(moduleId, row.capabilityId)
    }

    for (const deliverableId of row.deliverableIds) {
      if (!knownDeliverableIds.has(deliverableId)) {
        throw new Error(`capability ${row.capabilityId} references unknown deliverable ${deliverableId}`)
      }
    }
  }

  const missingWorkflows = [...knownWorkflowIds].filter((id) => !workflowOwners.has(id))
  if (missingWorkflows.length > 0) {
    throw new Error(`workflows not covered by any capability: ${missingWorkflows.join(", ")}`)
  }

  return {
    ok: true,
    counts: {
      capabilities: capabilityRegistry.length,
      durable: capabilityRegistry.filter((row) => row.durability === "durable").length,
      transitional: capabilityRegistry.filter((row) => row.durability === "transitional").length,
    },
  }
}

export function getCapability(capabilityId: string): CapabilityRegistryRow {
  const row = capabilityRegistry.find((item) => item.capabilityId === capabilityId)
  if (!row) throw new Error(`Unknown capability: ${capabilityId}`)
  return row
}

export function capabilityForModule(moduleId: string): CapabilityRegistryRow | undefined {
  return capabilityRegistry.find((row) => row.moduleIds.includes(moduleId))
}

export function capabilityForWorkflow(workflowId: string): CapabilityRegistryRow | undefined {
  return capabilityRegistry.find((row) => row.workflowIds.includes(workflowId))
}

function assertCapabilityIds(): void {
  const ids = capabilityRegistry.map((row) => row.capabilityId)
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Duplicate capability id: ${id}`)
    seen.add(id)
  }
  const required = new Set<string>(requiredCapabilityIds)
  const missing = [...required].filter((id) => !seen.has(id))
  if (missing.length > 0) throw new Error(`Missing required capability ids: ${missing.join(", ")}`)
  const extra = ids.filter((id) => !required.has(id))
  if (extra.length > 0) throw new Error(`Unexpected capability ids: ${extra.join(", ")}`)
}

function assertRowContract(row: CapabilityRegistryRow): void {
  if (!row.outcome.trim()) throw new Error(`capability ${row.capabilityId} is missing an outcome`)
  if (!row.automationBoundary.trim()) throw new Error(`capability ${row.capabilityId} is missing an automation boundary`)
  if (row.audiences.length === 0) throw new Error(`capability ${row.capabilityId} is missing audiences`)
  if (row.consumptionPurposes.length === 0) throw new Error(`capability ${row.capabilityId} is missing consumption purposes`)
  if (row.deliverableIds.length === 0) throw new Error(`capability ${row.capabilityId} is missing deliverables`)
  if (row.humanGates.length === 0) throw new Error(`capability ${row.capabilityId} is missing human gates`)
  if (row.evidenceRefs.length === 0) throw new Error(`capability ${row.capabilityId} is missing evidence refs`)
  if (row.workflowIds.length === 0) throw new Error(`capability ${row.capabilityId} is missing workflow coverage`)
  if (row.moduleIds.length === 0) throw new Error(`capability ${row.capabilityId} is missing module bindings`)
  for (const audience of row.audiences) {
    if (!audience.audience.trim()) throw new Error(`capability ${row.capabilityId} has an audience without a name`)
    if (!audience.consumptionPurpose.trim()) throw new Error(`capability ${row.capabilityId} audience missing consumption purpose`)
    if (!audience.deliveryMechanism.trim()) throw new Error(`capability ${row.capabilityId} audience missing delivery mechanism`)
    if (!audience.humanGate.trim()) throw new Error(`capability ${row.capabilityId} audience missing human gate`)
    if (audience.deliverableIds.length === 0) throw new Error(`capability ${row.capabilityId} audience missing deliverables`)
  }
}
