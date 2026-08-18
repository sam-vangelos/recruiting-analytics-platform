import type {
  AgencyResolutionStatus,
  ResolutionConfidence,
  ResolutionStatus,
} from "./resolution-types"

// ---------------------------------------------------------------------------
// Greenhouse API response shapes (raw v3)
// ---------------------------------------------------------------------------

export interface GHApplication {
  id: number
  candidate_id: number
  job_id: number
  status: string
  // Raw v3 may return nested object, flat field, or both
  current_stage: { id: number; name: string } | null
  stage_name?: string | null
  source: { id: number; name: string } | null
  credited_to: { id: number; first_name: string; last_name: string } | null
  referrer_id?: number | null
  applied_at?: string | null
  created_at?: string | null
  last_activity_at: string | null
  current_stage_at?: string | null
  current_stage_entered_at?: string | null
}

/** Extract stage name from whichever field the v3 API populated. */
export function ghStageName(app: GHApplication): string {
  return app.stage_name ?? app.current_stage?.name ?? "Unknown"
}

/** Best available timestamp for when the app entered the current stage. */
export function ghStageEnteredAt(app: GHApplication): string | null {
  return (
    app.current_stage_at ??
    app.current_stage_entered_at ??
    app.applied_at ??
    app.created_at ??
    app.last_activity_at ??
    null
  )
}

export interface GHJob {
  id: number
  name: string
}

export interface GHCandidate {
  id: number
  first_name: string
  last_name: string
  email_addresses: Array<{ value: string; type: string }> | null
}

export interface GHSource {
  id: number
  name: string
  type: { id: number; name: string } | null
}

// ---------------------------------------------------------------------------
// Sweep domain types
// ---------------------------------------------------------------------------

export type UrgencyTier = "breach" | "sla_risk" | "alerted" | "new" | "actioned"

/** Classify a referral by urgency based on stage, status, and hours. */
export function urgencyTier(
  stage: string,
  status: string,
  hoursInStage: number
): UrgencyTier {
  const isActive = status === "active" || status === "in_process"
  const inReview = stage === "Application Review"

  if (!isActive || !inReview) return "actioned"
  if (hoursInStage > 48) return "breach"
  if (hoursInStage > 36) return "sla_risk"
  if (hoursInStage > 24) return "alerted"
  return "new"
}

export interface ReferralSweepItem {
  application_id: number
  candidate_id: number
  job_id: number
  candidate_name: string
  job_title: string
  source_name: string
  current_stage: string
  application_status: string
  application_created_at: string
  current_stage_entered_at: string | null
  last_activity_at: string | null
  hours_in_current_stage: number
  urgency_tier: UrgencyTier
  referrer_name: string | null
  /** 015 — every recruiter-type owner on the requisition (Greenhouse user ids), for alert fan-out.
   *  Distinct from recruiter_name/recruiter_id, which carry the single elected primary. NULL only
   *  on a pre-015 row; an EMPTY array means the req genuinely has no recruiters. */
  recruiter_ids: number[] | null
  recruiter_name: string | null
  // 005 ownership writeback. recruiter_name is NULL unless ownership_resolution_status==='resolved'
  // (the sweep persists the defect contract); the live tracker gates display on these via
  // resolvedOrNull (lib/resolution-display.ts). Null when read against a pre-005 row.
  ownership_resolution_status: ResolutionStatus | null
  ownership_confidence: ResolutionConfidence | null
}

export interface PriorApplication {
  application_id: number
  job_title: string
  source_name: string
  status: string
  current_stage: string | null
  applied_at: string | null
}

export interface AgencyConflict {
  agency_application_id: number
  agency_source_name: string | null
  candidate_id: number
  candidate_name: string
  candidate_email: string | null
  job_id: number
  job_title: string
  prior_applications: PriorApplication[]
  conflict_type: "prior_history" | "dual_agency"
  risk_level: "high" | "medium" | "low"
}

export interface SweepRunSummary {
  id: string
  sweep_type: "referral" | "agency"
  started_at: string
  completed_at: string | null
  status: "running" | "completed" | "failed"
  applications_scanned: number
  items_found: number
  items_alerted: number
  // The failure reason recorded when status is "failed" (sweep-referral.ts:339,
  // sweep-agency writeback). Optional so the many places that build a summary for
  // a completed run need not thread a null through; the health surface reads it.
  error_message?: string | null
}

/** Health of a sweep lane, derived from its runs — separate from the tracker's
 *  displayed data so a failing or stalled sweep cannot hide behind the last
 *  successful run's figures. See lib/sweep-health.ts. */
export interface SweepHealth {
  /** The genuinely most recent run of ANY status. */
  latest_attempt: SweepRunSummary | null
  /** The most recent COMPLETED run — the source of the figures the tracker shows. */
  latest_success: SweepRunSummary | null
  status: "healthy" | "degraded" | "unknown"
  reason: "ok" | "last_run_failed" | "stalled" | "never_run"
}

export interface AlertLedgerEntry {
  id: string
  application_id: number
  sweep_type: "referral" | "agency"
  first_alerted_at: string
  last_alerted_at: string
  alert_count: number
  slack_ts: string | null
  resolved_at: string | null
  resolution_type:
    | "stage_change"
    | "rejection"
    | "hire"
    | "manual"
    | "expired"
    | null
  resolution_detail: string | null
  greenhouse_stage_at_alert: string
  greenhouse_stage_at_resolution: string | null
}

// ---------------------------------------------------------------------------
// Agency submission (stateful tracker)
// ---------------------------------------------------------------------------

export interface AgencySubmission {
  id: string
  application_id: number
  candidate_id: number
  candidate_email: string | null
  // 005:126-127 dropped the NOT NULL — agency_source_id/name are NULL on an unresolved source (the
  // defect contract), carried by source_resolution_status. Previously mis-typed as non-null.
  agency_source_id: number | null
  agency_source_name: string | null
  source_resolution_status: AgencyResolutionStatus | null
  job_id: number
  job_title: string | null
  submitted_at: string | null
  checked_at: string | null
  conflict_detected: boolean
  conflict_type: "prior_history" | "dual_agency" | null
  conflict_detail: Record<string, unknown> | null
  // 005 ownership writeback (the agency recruiter owner). NULL unless resolved.
  recruiter_id: number | null
  recruiter_name: string | null
  ownership_resolution_status: ResolutionStatus | null
}

// ---------------------------------------------------------------------------
// Dashboard data — v2 surfaces
// ---------------------------------------------------------------------------

export interface ReferralTrackerData {
  latest_run: SweepRunSummary | null
  health: SweepHealth
  items: ReferralSweepItem[]
  metrics: {
    total: number
    unactioned: number
    approaching_sla: number
    actioned: number
  }
}

export interface AgencyTrackerData {
  health: SweepHealth
  submissions_ytd: number
  conflicts_detected: number
  dual_agency_count: number
  cleared: number
  conflict_alerts: AgencySubmission[]
  all_submissions: AgencySubmission[]
  by_agency: Array<{
    // Keyed on source_id, not the raw name: unresolved-source rows collapse into ONE defect bucket
    // (source_id null, resolved false, agency_name = a defect label) instead of a phantom null key.
    source_id: number | null
    agency_name: string
    resolved: boolean
    submissions: number
    conflicts: number
    has_dual_agency: boolean
  }>
}

export interface OperationsHubData {
  referral_sla: {
    total: number
    past_sla: number
    at_risk: number
    watch: number
    items: ReferralSweepItem[]
  }
  agency_conflicts: {
    total: number
    fee_risk: number
    dupe_pipeline: number
    new_count: number
    items: AgencySubmission[]
  }
  scorecard_backlog: {
    total: number
    over_5d: number
    over_2d: number
    interviewers: number
  }
  team_load: {
    total_recruiters: number
    over_capacity: number
    near_capacity: number
    healthy: number
  }
}

// Legacy types kept for API route compatibility
export interface ReferralSweepDashboardData {
  latest_run: SweepRunSummary | null
  active_referrals: ReferralSweepItem[]
  sla_compliance: {
    total: number
    within_24h: number
    rate: number
  }
  unresolved_count: number
}

export interface AgencySweepDashboardData {
  latest_run: SweepRunSummary | null
  active_conflicts: AgencyConflict[]
  unresolved_count: number
}

export interface SweepDashboardData {
  referral: ReferralSweepDashboardData | null
  agency: AgencySweepDashboardData | null
}
