import { type LegacyArtifact, validateLegacyArtifact } from "./legacy-artifacts"

const workbookFact = (detail: string) => ({
  label: "FACT" as const,
  source: "workbook inventory",
  detail,
})

const artifactDecision = (detail: string) => ({
  label: "DECISION" as const,
  source: "command-center substrate",
  detail,
})

export const legacyArtifactRegistry = [
  legacyQueryArtifact(
    "legacy_q12_final_offer",
    "Q12 Final Offer lifecycle artifact",
    ["T07"],
    ["Q12"],
    ["final_offer_sheet"],
    ["application_id", "job_id", "offer_status", "month_bucket", "recruiter_name"]
  ),
  legacyQueryArtifact(
    "legacy_q11_rps_tracking",
    "Q11 RPS scorecard artifact",
    ["T05"],
    ["Q11"],
    ["rps_tracking_sheet"],
    ["application_id", "job_id", "interview_stage", "scorecard_status", "week_bucket"]
  ),
  legacyQueryArtifact(
    "legacy_q04_q09_pipeline_family",
    "Q04-Q09 role pipeline artifact family",
    ["T02"],
    ["Q04", "Q05", "Q06", "Q07", "Q08", "Q09"],
    ["role_pipeline_sheets"],
    ["application_id", "job_id", "stage_name", "stage_changed_at", "req_id"]
  ),
  legacyQueryArtifact(
    "legacy_q10_pipeline_graph",
    "Q10 FDL pipeline graph artifact",
    ["T04"],
    ["Q10"],
    ["pipeline_graph_sheet"],
    ["req_group", "stage_name", "movement_count", "week_bucket"]
  ),
  legacyQueryArtifact(
    "legacy_q13_q14_role_assignment",
    "Q13/Q14 role assignment artifacts",
    ["T09"],
    ["Q13", "Q14"],
    ["role_assignment_sheet"],
    ["job_id", "recruiter_name", "sourcer_name", "pod_name", "openings_count"]
  ),
  legacyQueryArtifact(
    "legacy_q01_q03_weekly_recruitment",
    "Q01-Q03 weekly recruitment artifacts",
    ["T01"],
    ["Q01", "Q02", "Q03"],
    ["weekly_recruitment_sheet"],
    ["job_id", "req_status", "pipeline_count", "offer_count", "week_bucket"]
  ),
  legacyDocArtifact(
    "legacy_elt_recruiting_update_doc",
    "Legacy ELT recruiting update doc",
    ["T06"],
    ["elt_recruiting_doc"]
  ),
  legacyScriptArtifact(
    "legacy_all_hires_apps_script",
    "Legacy All Hires Apps Script automation",
    ["T08"],
    ["all_hires_apps_script"],
    ["all_hires_sheet"]
  ),
  legacyDormantReportArtifact(
    "legacy_q15_recruiter_daily_report",
    "Q15 recruiter dormant daily report",
    ["T10"],
    ["Q15"],
    ["recruiter_daily_apps_script"],
    ["recruiter_daily_sheet"]
  ),
  legacySheetArtifact(
    "legacy_rc_tracker_sheet",
    "Legacy RC Tracker sheet",
    ["T12"],
    ["rc_tracker_sheet"],
    ["rc_id", "status", "owner", "last_updated_at", "exception_flag"]
  ),
  legacyPowerBiArtifact(
    "legacy_power_bi_dashboard_registry",
    "Legacy Power BI dashboard registry and refresh alerts",
    ["T13"],
    ["power_bi_dashboard_alerts"]
  ),
  legacyPowerBiArtifact(
    "legacy_power_bi_rls_vendor_packet",
    "Legacy Power BI RLS and the BI vendor coordination packet",
    ["T14"],
    ["power_bi_rls_matrix"]
  ),
  legacyN8nWorkflowArtifact(
    "legacy_duplicate_candidate_n8n_workflow",
    "Legacy duplicate candidate n8n workflow",
    ["T15"],
    ["duplicate_candidate_n8n"],
    ["duplicate_candidate_review_queue"]
  ),
  legacyN8nWorkflowArtifact(
    "legacy_n8n_mailgun_custody_packet",
    "Legacy n8n and Mailgun custody packet",
    ["T16"],
    ["duplicate_candidate_n8n"],
    ["n8n_custody_packet"]
  ),
  legacyScriptArtifact(
    "legacy_apps_script_asset_registry",
    "Legacy Apps Script asset registry",
    ["T17"],
    ["weekly_recruitment_apps_script", "role_pipeline_apps_script", "all_hires_apps_script", "recruiter_daily_apps_script"],
    ["apps_script_asset_registry"]
  ),
  legacySlackPatternArtifact(
    "legacy_recruiter_lead_slack_update_pattern",
    "Legacy recruiter lead Slack update pattern",
    ["T18"],
    ["recruiter_lead_slack_draft"]
  ),
  legacyValidationArtifact(
    "legacy_validation_coordination_log",
    "Legacy validation coordination log",
    ["T19"],
    ["validation_signoff_log"]
  ),
  legacyHandoffReadinessArtifact(
    "legacy_handoff_readiness_tracker",
    "Legacy Jordan handoff readiness tracker",
    ["T20/T21"],
    ["handoff_readiness_dashboard"]
  ),
  legacyAdminRunbookArtifact(
    "legacy_s01_requisition_action_runbook",
    "Legacy S01 requisition action runbook",
    ["S01"],
    "greenhouse",
    ["requisition_action_queue"]
  ),
  legacyAdminRunbookArtifact(
    "legacy_s02_offer_action_runbook",
    "Legacy S02 offer action runbook",
    ["S02"],
    "greenhouse",
    ["offer_action_queue"]
  ),
  legacyAdminRunbookArtifact(
    "legacy_s05_greenhouse_user_runbook",
    "Legacy S05 Greenhouse user runbook",
    ["S05"],
    "greenhouse",
    ["greenhouse_user_action_queue"]
  ),
  legacyAdminRunbookArtifact(
    "legacy_s06_linkedin_user_runbook",
    "Legacy S06 LinkedIn user runbook",
    ["S06"],
    "linkedin",
    ["linkedin_manual_action_queue"]
  ),
  legacyAdminRunbookArtifact(
    "legacy_s07_google_groups_runbook",
    "Legacy S07 Google Groups runbook",
    ["S07"],
    "google_admin",
    ["google_groups_action_queue"]
  ),
  legacySupportRunbookArtifact(
    "legacy_s03_greenhouse_clarification_log",
    "Legacy S03 Greenhouse clarification log",
    ["S03"],
    "greenhouse",
    ["greenhouse_clarification_log"]
  ),
  legacySupportRunbookArtifact(
    "legacy_s04_recruiting_inbox_runbook",
    "Legacy S04 recruiting inbox runbook",
    ["S04"],
    "gmail",
    ["recruiting_inbox_queue"]
  ),
] as const satisfies readonly LegacyArtifact[]

export function validateLegacyArtifactRegistry(): { ok: true; count: number } {
  for (const artifact of legacyArtifactRegistry) validateLegacyArtifact(artifact)
  return { ok: true, count: legacyArtifactRegistry.length }
}

function legacyQueryArtifact(
  id: string,
  title: string,
  workflowIds: readonly string[],
  queryIds: readonly string[],
  outputContractIds: readonly string[],
  expectedHeaders: readonly string[]
): LegacyArtifact {
  return {
    id,
    artifactType: "query_tab",
    workflowIds,
    queryIds,
    scriptAssetIds: [],
    outputContractIds,
    sourceId: "looker_sql_runner",
    title,
    locationLabel: "Workbook query tab reference; execution is evidence-only.",
    custodyStatus: "export_required",
    accessStatus: "manual",
    expectedHeaders,
    provenance: [
      workbookFact(`${title} identified from workbook query inventory.`),
      artifactDecision("Registered as legacy evidence, not canonical truth."),
    ],
    blockers: ["OPEN: capture exact tab/source reference and accepted header sample before module cutover."],
    nextGate: "Attach redacted sample export or exact workbook tab reference for comparison tests.",
  }
}

function legacyDocArtifact(
  id: string,
  title: string,
  workflowIds: readonly string[],
  outputContractIds: readonly string[]
): LegacyArtifact {
  return {
    id,
    artifactType: "doc",
    workflowIds,
    queryIds: [],
    scriptAssetIds: [],
    outputContractIds,
    sourceId: "google_docs",
    title,
    locationLabel: "Legacy Google Doc production contract; local renderer only in command-center foundation.",
    custodyStatus: "owner_confirm_required",
    accessStatus: "manual",
    expectedHeaders: [],
    provenance: [
      workbookFact(`${title} identified from transition workflow inventory.`),
      artifactDecision("Registered as narrative evidence and compatibility target, not canonical truth."),
      {
        label: "OPEN",
        source: "doc custody follow-up",
        detail: "Capture exact doc link, section structure, and approved human-review process before cutover.",
      },
    ],
    blockers: ["OPEN: capture doc owner, section structure, and review expectations before any production adapter."],
    nextGate: "Render local narrative draft rows and compare only against useful legacy doc section evidence.",
  }
}

function legacyScriptArtifact(
  id: string,
  title: string,
  workflowIds: readonly string[],
  scriptAssetIds: readonly string[],
  outputContractIds: readonly string[]
): LegacyArtifact {
  return {
    id,
    artifactType: "apps_script",
    workflowIds,
    queryIds: [],
    scriptAssetIds,
    outputContractIds,
    sourceId: "google_apps_script",
    title,
    locationLabel: "Legacy Apps Script project reference; secrets must not be copied into source control.",
    custodyStatus: "export_required",
    accessStatus: "manual",
    expectedHeaders: [],
    provenance: [
      workbookFact(`${title} identified from transition workflow inventory.`),
      artifactDecision("Registered as automation custody evidence; existing automation remains external."),
      {
        label: "OPEN",
        source: "script custody follow-up",
        detail: "Export sanitized source, trigger metadata, execution history, and credential ownership evidence.",
      },
    ],
    blockers: ["OPEN: capture sanitized Apps Script source, trigger owner, and service-credential reissue evidence."],
    nextGate: "Render local monitor rows and prove two clean external sync cycles before any retirement discussion.",
  }
}

function legacyDormantReportArtifact(
  id: string,
  title: string,
  workflowIds: readonly string[],
  queryIds: readonly string[],
  scriptAssetIds: readonly string[],
  outputContractIds: readonly string[]
): LegacyArtifact {
  return {
    id,
    artifactType: "reference_packet",
    workflowIds,
    queryIds,
    scriptAssetIds,
    outputContractIds,
    sourceId: "looker_sql_runner",
    title,
    locationLabel: "Dormant report template and Q15 reference; execution remains stopped by default.",
    custodyStatus: "reference_only",
    accessStatus: "manual",
    expectedHeaders: ["LAST_RUN_DATE", "resume_gate", "template_reference"],
    provenance: [
      workbookFact(`${title} identified as Stop/dormant in transition notes.`),
      artifactDecision("Preserve template and query evidence while blocking accidental reactivation."),
    ],
    blockers: ["OPEN: confirm consumer request before any resumed execution."],
    nextGate: "Keep dormant unless Jordan explicitly requests resume and validates the preserved template.",
  }
}

function legacySheetArtifact(
  id: string,
  title: string,
  workflowIds: readonly string[],
  outputContractIds: readonly string[],
  expectedHeaders: readonly string[]
): LegacyArtifact {
  return {
    id,
    artifactType: "sheet",
    workflowIds,
    queryIds: [],
    scriptAssetIds: [],
    outputContractIds,
    sourceId: "google_sheets",
    title,
    locationLabel: "Legacy Google Sheet contract; command center renders local monitor artifacts only.",
    custodyStatus: "owner_confirm_required",
    accessStatus: "manual",
    expectedHeaders,
    provenance: [
      workbookFact(`${title} identified from transition workflow inventory.`),
      artifactDecision("Registered as external-sheet evidence and compatibility target."),
    ],
    blockers: ["OPEN: capture exact sheet link, owner, and accepted status/exception semantics."],
    nextGate: "Render local monitor rows and classify differences before any production adapter.",
  }
}

function legacyPowerBiArtifact(id: string, title: string, workflowIds: readonly string[], outputContractIds: readonly string[]): LegacyArtifact {
  return {
    id,
    artifactType: "power_bi_dashboard",
    workflowIds,
    queryIds: [],
    scriptAssetIds: [],
    outputContractIds,
    sourceId: "power_bi",
    title,
    locationLabel: "Power BI workspace/dashboard inventory and refresh-alert evidence.",
    custodyStatus: "owner_confirm_required",
    accessStatus: "unknown",
    expectedHeaders: ["dashboard_id", "dashboard_title", "workspace_name", "refresh_status", "last_refresh_at"],
    provenance: [
      workbookFact(`${title} identified from systems/access transition inventory.`),
      artifactDecision("Registered as dashboard evidence and alert-triage compatibility target."),
    ],
    blockers: ["OPEN: capture workspace access, nine-dashboard inventory, alert routing, and triage owner."],
    nextGate: "Render local dashboard alert rows and classify refresh/status differences before any API adapter.",
  }
}

function legacyN8nWorkflowArtifact(
  id: string,
  title: string,
  workflowIds: readonly string[],
  scriptAssetIds: readonly string[],
  outputContractIds: readonly string[]
): LegacyArtifact {
  return {
    id,
    artifactType: "n8n_workflow",
    workflowIds,
    queryIds: [],
    scriptAssetIds,
    outputContractIds,
    sourceId: "n8n",
    title,
    locationLabel: "External n8n workflow and Mailgun-dependent duplicate-candidate process.",
    custodyStatus: "export_required",
    accessStatus: "unknown",
    expectedHeaders: [],
    provenance: [
      workbookFact(`${title} identified from transition workflow inventory.`),
      artifactDecision("Registered as custody evidence before rebuilding duplicate detection in the command center."),
      {
        label: "OPEN",
        source: "n8n/Mailgun custody follow-up",
        detail: "Export workflow JSON, business rules, sample outputs, and credential-owner names without secret values.",
      },
    ],
    blockers: ["OPEN: capture n8n export, Mailgun credential owner, and duplicate-review sample outputs."],
    nextGate: "Render local duplicate-review queue rows while preserving n8n/Mailgun custody blockers.",
  }
}

function legacySlackPatternArtifact(
  id: string,
  title: string,
  workflowIds: readonly string[],
  outputContractIds: readonly string[]
): LegacyArtifact {
  return {
    id,
    artifactType: "slack_pattern",
    workflowIds,
    queryIds: [],
    scriptAssetIds: [],
    outputContractIds,
    sourceId: "slack",
    title,
    locationLabel: "Legacy Slack update examples and recipient/channel pattern; command center renders drafts only.",
    custodyStatus: "owner_confirm_required",
    accessStatus: "manual",
    expectedHeaders: ["lead_id", "req_group", "week_bucket", "message_template"],
    provenance: [
      workbookFact(`${title} identified from transition workflow inventory.`),
      artifactDecision("Registered as draft-format evidence; sending remains human-owned."),
      {
        label: "OPEN",
        source: "Slack draft custody follow-up",
        detail: "Capture accepted examples, recipient/channel rules, and reviewer before any Slack adapter.",
      },
    ],
    blockers: ["OPEN: capture accepted Slack examples, recipient rules, and human-send approval owner."],
    nextGate: "Render local Slack draft rows and require human review before any messaging adapter.",
  }
}

function legacyValidationArtifact(
  id: string,
  title: string,
  workflowIds: readonly string[],
  outputContractIds: readonly string[]
): LegacyArtifact {
  return {
    id,
    artifactType: "manual_export",
    workflowIds,
    queryIds: [],
    scriptAssetIds: [],
    outputContractIds,
    sourceId: "google_sheets",
    title,
    locationLabel: "Legacy validation tracker and owner signoff evidence; command center renders a local ledger.",
    custodyStatus: "owner_confirm_required",
    accessStatus: "manual",
    expectedHeaders: ["target_id", "workflow_id", "run_id", "owner", "attestation_status"],
    provenance: [
      workbookFact(`${title} identified from transition workflow inventory.`),
      artifactDecision("Registered as signoff evidence and acceptance gate, not as a production write target."),
      {
        label: "OPEN",
        source: "validation custody follow-up",
        detail: "Capture accepted evidence examples, owner attestation format, and review cadence before cutover.",
      },
    ],
    blockers: ["OPEN: capture owner attestation format, accepted evidence examples, and review cadence."],
    nextGate: "Render local validation ledger rows and require owner acceptance before cutover.",
  }
}

function legacyHandoffReadinessArtifact(
  id: string,
  title: string,
  workflowIds: readonly string[],
  outputContractIds: readonly string[]
): LegacyArtifact {
  return {
    id,
    artifactType: "manual_export",
    workflowIds,
    queryIds: [],
    scriptAssetIds: [],
    outputContractIds,
    sourceId: "google_sheets",
    title,
    locationLabel: "Legacy handoff tracker and readiness checklist; command center renders a local dashboard.",
    custodyStatus: "owner_confirm_required",
    accessStatus: "manual",
    expectedHeaders: ["area_id", "area_name", "readiness_status", "owner", "sam_signoff_status"],
    provenance: [
      workbookFact(`${title} identified from transition workflow inventory.`),
      artifactDecision("Registered as handoff-readiness evidence; signoff is represented as data, not as cutover."),
      {
        label: "OPEN",
        source: "handoff readiness follow-up",
        detail: "Capture final readiness checklist, required evidence, and Jordan acceptance semantics before closeout.",
      },
    ],
    blockers: ["OPEN: capture final readiness checklist, required evidence, and Jordan acceptance semantics."],
    nextGate: "Render local readiness dashboard rows and keep retirement/cutover out of scope.",
  }
}

function legacyAdminRunbookArtifact(
  id: string,
  title: string,
  workflowIds: readonly string[],
  sourceId: string,
  outputContractIds: readonly string[]
): LegacyArtifact {
  return {
    id,
    artifactType: "reference_packet",
    workflowIds,
    queryIds: [],
    scriptAssetIds: [],
    outputContractIds,
    sourceId,
    title,
    locationLabel: "Legacy admin runbook and witnessed-action evidence; command center renders dry-run proposals only.",
    custodyStatus: "owner_confirm_required",
    accessStatus: "manual",
    expectedHeaders: ["target_reference", "action_type", "approval_state", "evidence_refs"],
    provenance: [
      workbookFact(`${title} identified from transition workflow inventory.`),
      artifactDecision("Registered as admin-runbook evidence; live mutation remains out of scope."),
      {
        label: "OPEN",
        source: "admin runbook follow-up",
        detail: "Capture approver, allowed manual steps, forbidden actions, and witnessed walkthrough evidence.",
      },
    ],
    blockers: ["OPEN: capture approver, allowed manual steps, forbidden actions, and witnessed walkthrough evidence."],
    nextGate: "Render local dry-run proposal rows; never execute admin mutations from this module.",
  }
}

function legacySupportRunbookArtifact(
  id: string,
  title: string,
  workflowIds: readonly string[],
  sourceId: string,
  outputContractIds: readonly string[]
): LegacyArtifact {
  return {
    id,
    artifactType: "reference_packet",
    workflowIds,
    queryIds: [],
    scriptAssetIds: [],
    outputContractIds,
    sourceId,
    title,
    locationLabel: "Legacy support runbook, examples, and owner rules; command center renders local queues only.",
    custodyStatus: "owner_confirm_required",
    accessStatus: "manual",
    expectedHeaders: ["item_id", "category", "status", "owner", "next_gate"],
    provenance: [
      workbookFact(`${title} identified from transition workflow inventory.`),
      artifactDecision("Registered as support-runbook evidence; sending and external updates remain human-owned."),
      {
        label: "OPEN",
        source: "support runbook follow-up",
        detail: "Capture accepted examples, triage categories, owner rules, and escalation path.",
      },
    ],
    blockers: ["OPEN: capture accepted examples, triage categories, owner rules, and escalation path."],
    nextGate: "Render local support queue rows and require human owner review before any external action.",
  }
}
