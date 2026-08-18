export const PROVENANCE_LABELS = ["FACT", "DECISION", "INFERENCE", "OPEN"] as const
export const SOURCE_ADAPTERS = [
  "greenhouse_v3_read",
  "legacy_artifact",
  "manual_export",
  "looker_api",
  "local_renderer",
] as const
export const DISCREPANCY_CLASSES = [
  "legacy_bug",
  "stale_mapping",
  "source_gap",
  "intentional_modernization",
  "modern_bug",
  "business_definition_open",
] as const

export type ProvenanceLabel = (typeof PROVENANCE_LABELS)[number]
export type SourceAdapter = (typeof SOURCE_ADAPTERS)[number]
export type DiscrepancyClass = (typeof DISCREPANCY_CLASSES)[number]

export interface ProvenanceReference {
  label: ProvenanceLabel
  source: string
  detail: string
}

interface RegistryBase {
  id: string
  title: string
  owner: string
  currentRole: string
  provenance: readonly ProvenanceReference[]
  blockers: readonly string[]
  nextGate: string
}

export interface SourceRegistryRow extends RegistryBase {
  kind: "ats" | "reporting" | "workspace" | "automation" | "messaging" | "bi" | "admin" | "vendor"
  accessStatus: "available" | "manual" | "unknown" | "blocked" | "not_applicable"
  credentialClass: "oauth" | "user_oauth" | "service_account_possible" | "api_key" | "vendor_managed" | "manual_user" | "none"
  adapters: readonly SourceAdapter[]
  workflowIds: readonly string[]
}

export interface WorkflowRegistryRow extends RegistryBase {
  category: "reporting" | "admin" | "handoff" | "external_monitor" | "automation_custody"
  cadence: "daily" | "weekly" | "monthly" | "ad_hoc" | "dormant" | "transition"
  priority: "P0" | "P1" | "P2" | "Stop" | "Unknown"
  status: "active" | "partially_automated" | "manual" | "automated_external" | "dormant" | "capture_required"
  capability: string
  sourceIds: readonly string[]
  queryIds: readonly string[]
  outputContractIds: readonly string[]
}

export interface QueryRegistryRow extends RegistryBase {
  workflowIds: readonly string[]
  sourceId: string
  grain: string
  dateLogic: string
  requiredParams: readonly string[]
  outputConsumers: readonly string[]
  legacyEvidence: true
  canonicalTruth: false
  freeFormSqlAllowed: false
  defaultAdapter: Extract<SourceAdapter, "legacy_artifact" | "manual_export" | "looker_api">
}

export interface ScriptAssetRegistryRow extends RegistryBase {
  platform: "apps_script" | "n8n"
  workflowIds: readonly string[]
  sourceIds: readonly string[]
  exportStatus: "export_required" | "custody_required" | "reference_only"
  credentialPosture: "personal_or_departing_risk" | "unknown" | "external_workflow_risk" | "not_secret_bearing"
}

export interface OutputContractRegistryRow extends RegistryBase {
  workflowIds: readonly string[]
  renderer: "google_sheet" | "google_doc" | "slack_draft" | "power_bi" | "inbox_queue" | "admin_queue" | "local_registry"
  sourceIds: readonly string[]
  manualFields: readonly string[]
  validationChecks: readonly string[]
  productionWriteEnabled: false
}

const workbook = (detail: string): ProvenanceReference => ({
  label: "FACT",
  source: "workbook inventory",
  detail,
})

const decision = (detail: string): ProvenanceReference => ({
  label: "DECISION",
  source: "command-center direction",
  detail,
})

const open = (detail: string): ProvenanceReference => ({
  label: "OPEN",
  source: "access/custody follow-up",
  detail,
})

export const sourceRegistry = [
  source("greenhouse", "Greenhouse ATS", "ats", "available", "oauth", ["greenhouse_v3_read"], ["T01", "T02", "T05", "T07", "T08", "T09", "T15", "S01", "S02", "S05", "E01"], "Canonical ATS read source where Harvest v3 exposes the needed objects/events."),
  source("looker_sql_runner", "Looker / SQL Runner", "reporting", "manual", "manual_user", ["legacy_artifact", "manual_export", "looker_api"], ["T01", "T02", "T04", "T05", "T07", "T09", "T10"], "Legacy query execution/evidence path only; not canonical truth."),
  source("google_sheets", "Google Sheets", "workspace", "manual", "user_oauth", ["legacy_artifact", "local_renderer"], ["T01", "T02", "T03", "T04", "T05", "T07", "T08", "T09", "T10", "T12", "T14"], "Production output contracts remain until replacement artifacts are accepted."),
  source("google_apps_script", "Google Apps Script", "automation", "unknown", "user_oauth", ["legacy_artifact"], ["T01", "T02", "T08", "T10", "T17"], "Script source, triggers, scopes, and credential ownership must be captured before retirement."),
  source("google_docs", "Google Docs", "workspace", "manual", "user_oauth", ["legacy_artifact", "local_renderer"], ["T06"], "ELT doc is a production contract; write access is deferred."),
  source("slack", "Slack", "messaging", "available", "api_key", ["legacy_artifact", "local_renderer"], ["T18", "T19"], "Draft and validation surface; human-send first."),
  source("n8n", "n8n", "automation", "unknown", "api_key", ["legacy_artifact"], ["T15", "T16"], "External workflow custody and export are required before rebuild or retirement."),
  source("mailgun", "Mailgun", "automation", "unknown", "api_key", ["legacy_artifact"], ["T15", "T16"], "Credential and event metadata only in P0."),
  source("power_bi", "Power BI", "bi", "unknown", "vendor_managed", ["legacy_artifact"], ["T13", "T14"], "Dashboard and RLS evidence registry; not a Phase 1 blocker."),
  source("gmail", "Gmail / recruiting inbox", "workspace", "manual", "user_oauth", ["legacy_artifact", "local_renderer"], ["S04"], "Triage/draft queue later; human-send only."),
  source("google_admin", "Google Admin / Groups", "admin", "unknown", "user_oauth", ["legacy_artifact", "local_renderer"], ["S07"], "Admin proposal queue only until scopes are approved."),
  source("linkedin", "LinkedIn", "admin", "manual", "manual_user", ["legacy_artifact"], ["S06"], "Manual evidence queue; no full API automation assumed."),
  source("vendor", "the BI vendor", "vendor", "manual", "vendor_managed", ["legacy_artifact"], ["T14"], "Vendor coordination evidence for Power BI/RLS workflows."),
] as const satisfies readonly SourceRegistryRow[]

export const workflowRegistry = [
  workflow("T01", "Weekly Recruitment Report", "reporting", "weekly", "P0", "partially_automated", "Weekly leadership workflow over offer, pipeline, ownership, tracked-req facts, manual fields, and discrepancy queue.", ["greenhouse", "looker_sql_runner", "google_sheets", "google_apps_script"], ["Q01", "Q02", "Q03"], ["weekly_recruitment_sheet"]),
  workflow("T02", "Role-Specific Pipeline Reports", "reporting", "weekly", "P1", "partially_automated", "Parameterized pipeline/stage movement family with req-bundle config and stage taxonomy.", ["greenhouse", "looker_sql_runner", "google_sheets", "google_apps_script"], ["Q04", "Q05", "Q06", "Q07", "Q08", "Q09"], ["role_pipeline_sheets"]),
  workflow("T03", "Weekly Progress Sheet", "reporting", "weekly", "P1", "manual", "Derived progress transformation over pipeline facts.", ["google_sheets"], [], ["weekly_progress_sheet"]),
  workflow("T04", "FDL Pipeline Graph", "reporting", "weekly", "P1", "manual", "Conversion trend/chart renderer over stage-transition facts.", ["greenhouse", "looker_sql_runner", "google_sheets"], ["Q10"], ["pipeline_graph_sheet"]),
  workflow("T05", "RPS Tracking", "reporting", "weekly", "P1", "manual", "Scorecard/interview fact runner with pivot-compatible output and explicit interview taxonomy.", ["greenhouse", "looker_sql_runner", "google_sheets"], ["Q11"], ["rps_tracking_sheet"]),
  workflow("T06", "ELT Recruiting Updates", "reporting", "weekly", "P0", "manual", "Google Doc section renderer and fact-based narrative draft with human review.", ["google_docs", "google_sheets"], [], ["elt_recruiting_doc"]),
  workflow("T07", "Final Offer Report", "reporting", "weekly", "P0", "manual", "Offer lifecycle module with monthly renderer, mapping registry, and discrepancy checks.", ["greenhouse", "looker_sql_runner", "google_sheets"], ["Q12"], ["final_offer_sheet"]),
  workflow("T08", "All Hires Tracker", "external_monitor", "daily", "P1", "automated_external", "Managed external Apps Script automation monitor and replacement candidate after two clean cycles.", ["greenhouse", "google_sheets", "google_apps_script"], [], ["all_hires_sheet"]),
  workflow("T09", "Role Assignment By Pod", "reporting", "weekly", "P1", "manual", "Role ownership and recruiter workload snapshot.", ["greenhouse", "looker_sql_runner", "google_sheets"], ["Q13", "Q14"], ["role_assignment_sheet"]),
  workflow("T10", "Recruiter Daily Report", "reporting", "dormant", "Stop", "dormant", "Dormant template and resume gate.", ["looker_sql_runner", "google_sheets", "google_apps_script"], ["Q15"], ["recruiter_daily_sheet"]),
  workflow("T12", "RC Tracker Monitoring", "external_monitor", "daily", "P1", "manual", "External sheet monitor with exception flags and owner follow-up queue.", ["google_sheets"], [], ["rc_tracker_sheet"]),
  workflow("T13", "Power BI Dashboard Monitoring", "external_monitor", "weekly", "P1", "manual", "BI dashboard registry, refresh-alert ingestion, and triage queue.", ["power_bi"], [], ["power_bi_dashboard_alerts"]),
  workflow("T14", "Power BI RLS / the BI vendor Coordination", "admin", "ad_hoc", "P2", "manual", "RLS/access matrix registry plus vendor coordination evidence.", ["power_bi", "google_sheets", "vendor"], [], ["power_bi_rls_matrix"]),
  workflow("T15", "Duplicate Candidate Check Agent", "automation_custody", "ad_hoc", "P2", "capture_required", "Duplicate candidate detection/review queue; n8n custody before rebuild.", ["greenhouse", "n8n", "mailgun"], [], ["duplicate_candidate_review_queue"]),
  workflow("T16", "n8n Workflow Setup", "automation_custody", "ad_hoc", "P2", "capture_required", "External workflow registry, credential checklist, and dry-run event log.", ["n8n", "mailgun"], [], ["n8n_custody_packet"]),
  workflow("T17", "Apps Script Development", "automation_custody", "ad_hoc", "P1", "capture_required", "Apps Script asset registry, extracted source, owners, triggers, scopes, and credential audit.", ["google_apps_script", "google_sheets"], [], ["apps_script_asset_registry"]),
  workflow("T18", "Recruiter Lead Slack Updates", "reporting", "weekly", "P1", "manual", "Slack draft renderer with human-send approval.", ["slack", "google_sheets"], [], ["recruiter_lead_slack_draft"]),
  workflow("T19", "Validation Coordination", "handoff", "daily", "P1", "manual", "Validation/signoff workflow with evidence capture and owner attestations.", ["slack", "google_sheets"], [], ["validation_signoff_log"]),
  workflow("T20/T21", "Jordan Handoff Preparation", "handoff", "transition", "P0", "capture_required", "Source package, SOP completeness ledger, human gate checklist, and readiness dashboard.", ["google_sheets", "google_docs"], [], ["handoff_readiness_dashboard"]),
  workflow("S01", "Open / Update Requisitions", "admin", "ad_hoc", "P0", "manual", "Requisition action proposal queue with evidence, risk class, human approval, and audit.", ["greenhouse"], [], ["requisition_action_queue"]),
  workflow("S02", "Approve / Update Offers", "admin", "ad_hoc", "P0", "manual", "Offer action queue; approval remains human-only.", ["greenhouse"], [], ["offer_action_queue"]),
  workflow("S03", "Greenhouse Clarifications", "admin", "ad_hoc", "P1", "manual", "Case log and FAQ/decision registry.", ["greenhouse", "slack"], [], ["greenhouse_clarification_log"]),
  workflow("S04", "Recruiting Inbox Responses", "admin", "daily", "P1", "manual", "Inbox triage, categorization, suggested drafts, and human send.", ["gmail"], [], ["recruiting_inbox_queue"]),
  workflow("S05", "Create / Modify Greenhouse Users", "admin", "ad_hoc", "P0", "manual", "Access provisioning proposal queue with role/scope evidence.", ["greenhouse"], [], ["greenhouse_user_action_queue"]),
  workflow("S06", "Update LinkedIn Users", "admin", "ad_hoc", "P0", "manual", "Manual action checklist/evidence queue; API automation not assumed.", ["linkedin"], [], ["linkedin_manual_action_queue"]),
  workflow("S07", "Update Google Groups TA Team", "admin", "ad_hoc", "P0", "manual", "Google Admin group membership proposal queue with human approval.", ["google_admin"], [], ["google_groups_action_queue"]),
  workflow("E01", "Exec State-of-Play", "reporting", "weekly", "P0", "partially_automated", "Org-wide open-req health/momentum facts (scorecard-truthed activity, governed stage resolution, org-wide hires) feeding the exec page, durable snapshot, and ELT facts.", ["greenhouse"], [], ["exec_state_of_play_snapshot"]),
] as const satisfies readonly WorkflowRegistryRow[]

export const queryRegistry = [
  query("Q01", "Weekly recruitment main query", ["T01"], "active req, headcount, pipeline", "weekly reporting window plus tracked req logic", ["week", "tracked_req_bundle"], ["weekly_recruitment_sheet"]),
  query("Q02", "Weekly recruitment not-included query", ["T01"], "excluded req/application review", "weekly exception review", ["week"], ["weekly_recruitment_sheet"]),
  query("Q03", "Weekly recruitment closed roles query", ["T01"], "closed role snapshot", "weekly closed-role window", ["week"], ["weekly_recruitment_sheet"]),
  query("Q04", "Req 890 pipeline incremental query", ["T02"], "application/stage event", "incremental watermark and req-specific stage rules", ["req_id", "last_successful_run_ts"], ["role_pipeline_sheets"]),
  query("Q05", "Req 907 pipeline incremental query", ["T02"], "application/stage event", "incremental watermark and req-specific stage rules", ["req_id", "last_successful_run_ts"], ["role_pipeline_sheets"]),
  query("Q06", "Req 1026 pipeline incremental query", ["T02"], "application/stage event", "incremental watermark and req-specific stage rules", ["req_id", "last_successful_run_ts"], ["role_pipeline_sheets"]),
  query("Q07", "Req 1027 pipeline incremental query", ["T02"], "application/stage event", "incremental watermark and req-specific stage rules", ["req_id", "last_successful_run_ts"], ["role_pipeline_sheets"]),
  query("Q08", "Req 1118 pipeline incremental query", ["T02"], "application/stage event", "incremental watermark and req-specific stage rules", ["req_id", "last_successful_run_ts"], ["role_pipeline_sheets"]),
  query("Q09", "Req 1119 pipeline incremental query", ["T02"], "application/stage event", "incremental watermark and req-specific stage rules", ["req_id", "last_successful_run_ts"], ["role_pipeline_sheets"]),
  query("Q10", "FDL graph query", ["T04"], "stage pass-rate chart", "week/date window updated manually in legacy flow", ["week"], ["pipeline_graph_sheet"]),
  query("Q11", "RPS tracking query", ["T05"], "scorecard / phone screen fact", "weekly scorecard window", ["week"], ["rps_tracking_sheet"]),
  query("Q12", "Final offer lifecycle query", ["T07"], "offer/application/candidate/job lifecycle", "quarter/month range", ["quarter", "month"], ["final_offer_sheet"]),
  query("Q13", "Role assignment by job query", ["T09"], "single row per job", "current open role snapshot", ["as_of"], ["role_assignment_sheet"]),
  query("Q14", "Role assignment by recruiter query", ["T09"], "single row per recruiter", "current recruiter workload snapshot", ["as_of"], ["role_assignment_sheet"]),
  query("Q15", "recruiter dormant daily report query", ["T10"], "dormant daily report template", "legacy LAST_RUN_DATE control", ["last_run_date"], ["recruiter_daily_sheet"]),
] as const satisfies readonly QueryRegistryRow[]

export const scriptAssetRegistry = [
  scriptAsset("weekly_recruitment_apps_script", "Weekly Recruitment Report Apps Script", "apps_script", ["T01"], ["google_apps_script", "google_sheets"], "export_required", "personal_or_departing_risk"),
  scriptAsset("role_pipeline_apps_script", "Role-Specific Pipeline Apps Script", "apps_script", ["T02"], ["google_apps_script", "google_sheets"], "export_required", "personal_or_departing_risk"),
  scriptAsset("all_hires_apps_script", "All Hires Tracker Apps Script", "apps_script", ["T08"], ["google_apps_script", "google_sheets", "greenhouse"], "export_required", "personal_or_departing_risk"),
  scriptAsset("recruiter_daily_apps_script", "Recruiter Daily Report Control Apps Script", "apps_script", ["T10"], ["google_apps_script", "google_sheets"], "reference_only", "not_secret_bearing"),
  scriptAsset("duplicate_candidate_n8n", "Duplicate Candidate n8n Workflow", "n8n", ["T15", "T16"], ["n8n", "greenhouse", "mailgun"], "custody_required", "external_workflow_risk"),
] as const satisfies readonly ScriptAssetRegistryRow[]

export const outputContractRegistry = [
  output("weekly_recruitment_sheet", "Weekly Recruitment Google Sheet", ["T01"], "google_sheet", ["google_sheets"], ["leadership fields", "comments"], ["stable columns", "manual field carry-forward"]),
  output("role_pipeline_sheets", "Role-Specific Pipeline Sheets", ["T02"], "google_sheet", ["google_sheets"], ["validation notes"], ["dedupe key", "stage counts"]),
  output("weekly_progress_sheet", "Weekly Progress Sheet", ["T03"], "google_sheet", ["google_sheets"], ["owner validation"], ["stage movement totals"]),
  output("pipeline_graph_sheet", "FDL Pipeline Graph Sheet", ["T04"], "google_sheet", ["google_sheets"], ["chart review"], ["chart data table checksum"]),
  output("rps_tracking_sheet", "RPS Tracking Sheet", ["T05"], "google_sheet", ["google_sheets"], ["pivot review"], ["scorecard taxonomy", "weekly filter"]),
  output("elt_recruiting_doc", "ELT Recruiting Update Doc", ["T06"], "google_doc", ["google_docs"], ["leadership narrative"], ["source fact traceability"]),
  output("final_offer_sheet", "Final Offer Report Sheet", ["T07"], "google_sheet", ["google_sheets"], ["mapping review"], ["offer status class", "month bucket"]),
  output("all_hires_sheet", "All Hires Tracker Sheet", ["T08"], "google_sheet", ["google_sheets"], ["run health review"], ["daily trigger evidence"]),
  output("role_assignment_sheet", "Role Assignment By Pod Sheet", ["T09"], "google_sheet", ["google_sheets"], ["pivot adjustment"], ["single-row-per-job", "single-row-per-recruiter"]),
  output("recruiter_daily_sheet", "Recruiter Daily Dormant Report", ["T10"], "google_sheet", ["google_sheets"], ["resume approval"], ["LAST_RUN_DATE preserved"]),
  output("rc_tracker_sheet", "RC Tracker Sheet", ["T12"], "google_sheet", ["google_sheets"], ["owner follow-up"], ["exception flags"]),
  output("power_bi_dashboard_alerts", "Power BI Dashboard Alert Queue", ["T13"], "power_bi", ["power_bi"], ["refresh triage"], ["dashboard registry"]),
  output("power_bi_rls_matrix", "Power BI RLS / the BI vendor Access Matrix", ["T14"], "google_sheet", ["power_bi", "google_sheets", "vendor"], ["vendor coordination"], ["access matrix coverage"]),
  output("duplicate_candidate_review_queue", "Duplicate Candidate Review Queue", ["T15"], "admin_queue", ["greenhouse", "n8n"], ["case review"], ["duplicate evidence ids"]),
  output("n8n_custody_packet", "n8n Custody Packet", ["T16"], "local_registry", ["n8n", "mailgun"], ["credential owner review"], ["workflow export status"]),
  output("apps_script_asset_registry", "Apps Script Asset Registry", ["T17"], "local_registry", ["google_apps_script"], ["source review"], ["export status", "scope inventory"]),
  output("recruiter_lead_slack_draft", "Recruiter Lead Slack Draft", ["T18"], "slack_draft", ["slack"], ["human send"], ["source run ids"]),
  output("validation_signoff_log", "Validation Signoff Log", ["T19"], "local_registry", ["slack", "google_sheets"], ["owner attestation"], ["evidence timestamp"]),
  output("handoff_readiness_dashboard", "Handoff Readiness Dashboard", ["T20/T21"], "local_registry", ["google_sheets", "google_docs"], ["the operator signoff"], ["SOP closure", "access coverage"]),
  output("requisition_action_queue", "Requisition Action Queue", ["S01"], "admin_queue", ["greenhouse"], ["human approval"], ["source evidence", "risk class"]),
  output("offer_action_queue", "Offer Action Queue", ["S02"], "admin_queue", ["greenhouse"], ["human approval"], ["approval evidence", "never-tier gate"]),
  output("greenhouse_clarification_log", "Greenhouse Clarification Log", ["S03"], "local_registry", ["greenhouse", "slack"], ["case owner"], ["decision log"]),
  output("recruiting_inbox_queue", "Recruiting Inbox Triage Queue", ["S04"], "inbox_queue", ["gmail"], ["human send"], ["draft traceability"]),
  output("greenhouse_user_action_queue", "Greenhouse User Action Queue", ["S05"], "admin_queue", ["greenhouse"], ["human approval"], ["role/scope evidence"]),
  output("linkedin_manual_action_queue", "LinkedIn Manual Action Queue", ["S06"], "admin_queue", ["linkedin"], ["manual completion"], ["evidence checklist"]),
  output("google_groups_action_queue", "Google Groups Action Queue", ["S07"], "admin_queue", ["google_admin"], ["human approval"], ["group membership evidence"]),
  output("exec_state_of_play_snapshot", "Exec State-of-Play Snapshot", ["E01"], "local_registry", ["greenhouse"], ["Operator reviews the page before exec rollout"], ["reason-bearing health on every row", "unclassified stages never finalists or advances", "org-wide offers window"]),
] as const satisfies readonly OutputContractRegistryRow[]

export const requiredWorkflowIds = [
  "T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10",
  "T12", "T13", "T14", "T15", "T16", "T17", "T18", "T19", "T20/T21",
  "S01", "S02", "S03", "S04", "S05", "S06", "S07", "E01",
] as const

export const requiredQueryIds = [
  "Q01", "Q02", "Q03", "Q04", "Q05", "Q06", "Q07", "Q08", "Q09", "Q10",
  "Q11", "Q12", "Q13", "Q14", "Q15",
] as const

export interface P0RegistryValidationResult {
  ok: true
  counts: {
    sources: number
    workflows: number
    queries: number
    scriptAssets: number
    outputContracts: number
  }
}

export function validateP0Registries(): P0RegistryValidationResult {
  assertUniqueIds(sourceRegistry, "source")
  assertUniqueIds(workflowRegistry, "workflow")
  assertUniqueIds(queryRegistry, "query")
  assertUniqueIds(scriptAssetRegistry, "script asset")
  assertUniqueIds(outputContractRegistry, "output contract")

  assertContainsIds(workflowRegistry, requiredWorkflowIds, "workflow")
  assertContainsIds(queryRegistry, requiredQueryIds, "query")

  for (const row of allRegistryRows()) assertRowEvidence(row)
  assertReferences()
  assertSafeP0Posture()

  return {
    ok: true,
    counts: {
      sources: sourceRegistry.length,
      workflows: workflowRegistry.length,
      queries: queryRegistry.length,
      scriptAssets: scriptAssetRegistry.length,
      outputContracts: outputContractRegistry.length,
    },
  }
}

export function getSource(id: string): SourceRegistryRow {
  return getById(sourceRegistry, id, "source")
}

export function getWorkflow(id: string): WorkflowRegistryRow {
  return getById(workflowRegistry, id, "workflow")
}

export function getQuery(id: string): QueryRegistryRow {
  return getById(queryRegistry, id, "query")
}

export function getOutputContract(id: string): OutputContractRegistryRow {
  return getById(outputContractRegistry, id, "output contract")
}

function source(
  id: string,
  title: string,
  kind: SourceRegistryRow["kind"],
  accessStatus: SourceRegistryRow["accessStatus"],
  credentialClass: SourceRegistryRow["credentialClass"],
  adapters: readonly SourceAdapter[],
  workflowIds: readonly string[],
  currentRole: string
): SourceRegistryRow {
  return {
    id,
    title,
    kind,
    accessStatus,
    credentialClass,
    adapters,
    workflowIds,
    currentRole,
    owner: "Jordan",
    provenance: [workbook(`Systems/source evidence for ${title}`), decision(currentRole)],
    blockers: ["P0 registry only; production adapter and credential custody are not configured here."],
    nextGate: "Confirm access owner, auth method, and safe evidence capture path before any production adapter.",
  }
}

function workflow(
  id: string,
  title: string,
  category: WorkflowRegistryRow["category"],
  cadence: WorkflowRegistryRow["cadence"],
  priority: WorkflowRegistryRow["priority"],
  status: WorkflowRegistryRow["status"],
  capability: string,
  sourceIds: readonly string[],
  queryIds: readonly string[],
  outputContractIds: readonly string[]
): WorkflowRegistryRow {
  return {
    id,
    title,
    category,
    cadence,
    priority,
    status,
    capability,
    sourceIds,
    queryIds,
    outputContractIds,
    owner: "Jordan",
    currentRole: capability,
    provenance: [workbook(`Master task inventory row ${id}`), decision("Registered as P0 evidence, not as implemented automation.")],
    blockers: ["Workflow has not yet been rebuilt as a Greenhouse-native module with classified discrepancies."],
    nextGate: "Capture source artifacts and confirm output contract before runner implementation.",
  }
}

function query(
  id: string,
  title: string,
  workflowIds: readonly string[],
  grain: string,
  dateLogic: string,
  requiredParams: readonly string[],
  outputConsumers: readonly string[]
): QueryRegistryRow {
  return {
    id,
    title,
    workflowIds,
    grain,
    dateLogic,
    requiredParams,
    outputConsumers,
    sourceId: "looker_sql_runner",
    legacyEvidence: true,
    canonicalTruth: false,
    freeFormSqlAllowed: false,
    defaultAdapter: "legacy_artifact",
    owner: "Jordan",
    currentRole: "Legacy semantic artifact for intent, mappings, grain, date logic, and output-shape review.",
    provenance: [workbook(`Queries repository tab ${id}`), decision("Legacy SQL is fallible evidence, not canonical metric truth.")],
    blockers: ["SQL source must be captured and reviewed for hard-coded reqs, stale mappings, date drift, and source gaps."],
    nextGate: "Extract business intent into versioned config and compare only when a legacy artifact is useful evidence.",
  }
}

function scriptAsset(
  id: string,
  title: string,
  platform: ScriptAssetRegistryRow["platform"],
  workflowIds: readonly string[],
  sourceIds: readonly string[],
  exportStatus: ScriptAssetRegistryRow["exportStatus"],
  credentialPosture: ScriptAssetRegistryRow["credentialPosture"]
): ScriptAssetRegistryRow {
  return {
    id,
    title,
    platform,
    workflowIds,
    sourceIds,
    exportStatus,
    credentialPosture,
    owner: "Jordan",
    currentRole: "Legacy automation artifact requiring custody before retirement or rewrite.",
    provenance: [workbook(`Automation/script evidence for ${title}`), open("Export/versioned source not yet present on this branch.")],
    blockers: ["Source export, trigger inventory, credential names, and secret redaction are not complete."],
    nextGate: "Capture source and run metadata without committing secrets.",
  }
}

function output(
  id: string,
  title: string,
  workflowIds: readonly string[],
  renderer: OutputContractRegistryRow["renderer"],
  sourceIds: readonly string[],
  manualFields: readonly string[],
  validationChecks: readonly string[]
): OutputContractRegistryRow {
  return {
    id,
    title,
    workflowIds,
    renderer,
    sourceIds,
    manualFields,
    validationChecks,
    productionWriteEnabled: false,
    owner: "Jordan",
    currentRole: "Production-visible contract or local replacement candidate.",
    provenance: [workbook(`Output contract evidence for ${title}`), decision("Local/shadow render first; production writes remain disabled.")],
    blockers: ["No production write path is enabled in P0."],
    nextGate: "Implement a local renderer or evidence capture before any production writer.",
  }
}

function allRegistryRows(): RegistryBase[] {
  return [
    ...sourceRegistry,
    ...workflowRegistry,
    ...queryRegistry,
    ...scriptAssetRegistry,
    ...outputContractRegistry,
  ]
}

function getById<T extends { id: string }>(
  rows: readonly T[],
  id: string,
  label: string
): T {
  const row = rows.find((item) => item.id === id)
  if (!row) throw new Error(`Unknown ${label}: ${id}`)
  return row
}

function assertUniqueIds(rows: readonly { id: string }[], label: string): void {
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`Duplicate ${label} id: ${row.id}`)
    seen.add(row.id)
  }
}

function assertContainsIds(
  rows: readonly { id: string }[],
  requiredIds: readonly string[],
  label: string
): void {
  const ids = new Set(rows.map((row) => row.id))
  const missing = requiredIds.filter((id) => !ids.has(id))
  if (missing.length > 0) throw new Error(`Missing ${label} ids: ${missing.join(", ")}`)
}

function assertRowEvidence(row: RegistryBase): void {
  if (row.provenance.length === 0) throw new Error(`${row.id} is missing provenance`)
  if (row.blockers.length === 0) throw new Error(`${row.id} is missing blockers`)
  if (!row.nextGate.trim()) throw new Error(`${row.id} is missing nextGate`)
}

function assertReferences(): void {
  const sourceIds = new Set(sourceRegistry.map((row) => row.id))
  const workflowIds = new Set(workflowRegistry.map((row) => row.id))
  const queryIds = new Set(queryRegistry.map((row) => row.id))
  const outputIds = new Set(outputContractRegistry.map((row) => row.id))

  for (const sourceRow of sourceRegistry) {
    assertAllKnown(sourceRow.workflowIds, workflowIds, `source ${sourceRow.id} workflow`)
  }
  for (const workflowRow of workflowRegistry) {
    assertAllKnown(workflowRow.sourceIds, sourceIds, `workflow ${workflowRow.id} source`)
    assertAllKnown(workflowRow.queryIds, queryIds, `workflow ${workflowRow.id} query`)
    assertAllKnown(workflowRow.outputContractIds, outputIds, `workflow ${workflowRow.id} output`)
  }
  for (const queryRow of queryRegistry) {
    assertAllKnown(queryRow.workflowIds, workflowIds, `query ${queryRow.id} workflow`)
    assertAllKnown(queryRow.outputConsumers, outputIds, `query ${queryRow.id} output`)
    assertAllKnown([queryRow.sourceId], sourceIds, `query ${queryRow.id} source`)
  }
  for (const asset of scriptAssetRegistry) {
    assertAllKnown(asset.workflowIds, workflowIds, `script ${asset.id} workflow`)
    assertAllKnown(asset.sourceIds, sourceIds, `script ${asset.id} source`)
  }
  for (const contract of outputContractRegistry) {
    assertAllKnown(contract.workflowIds, workflowIds, `output ${contract.id} workflow`)
    assertAllKnown(contract.sourceIds, sourceIds, `output ${contract.id} source`)
  }
}

function assertSafeP0Posture(): void {
  for (const queryRow of queryRegistry) {
    if (queryRow.freeFormSqlAllowed) {
      throw new Error(`free-form SQL is not allowed for query ${queryRow.id}`)
    }
    if (queryRow.canonicalTruth) {
      throw new Error(`query ${queryRow.id} cannot be canonical truth`)
    }
  }
  for (const contract of outputContractRegistry) {
    if (contract.productionWriteEnabled) {
      throw new Error(`production writes are not enabled for output ${contract.id}`)
    }
  }
}

function assertAllKnown(values: readonly string[], known: Set<string>, label: string): void {
  const missing = values.filter((value) => !known.has(value))
  if (missing.length > 0) throw new Error(`Unknown ${label} ids: ${missing.join(", ")}`)
}
