import type { GHApplication } from "./sweep-types"

export type YtdChannel = "referral" | "agency"
export type YtdChannelInput = YtdChannel | "all"
export type YtdRunType = "backfill" | "incremental" | "preflight"
export type YtdRunStatus = "running" | "completed" | "failed"
export type ActionTimeQuality = "exact" | "approximate" | "unknown"
export type TerminalOutcome = "active" | "rejected" | "hired" | "converted" | "unknown"
export type AgencyActionBucket =
  | "lt_24h"
  | "h24_48"
  | "d2_7"
  | "gt_7d"
  | "unactioned_lt_7d"
  | "unactioned_gt_7d"
  | "unknown"
export type DuplicateConfidence =
  | "confirmed"
  | "high"
  | "possible"
  | "none"
  | "insufficient_data"
export type DuplicateEvidenceType =
  | "email_exact"
  | "phone_exact"
  | "profile_url_exact"
  | "candidate_id"
  | "name_company_title"
export type FeeRiskState =
  | "not_duplicate"
  | "cleared_in_window"
  | "pending_in_window"
  | "at_risk"
  | "exposed"
  | "insufficient_data"

export type YtdDataQualityFlag =
  | "missing_candidate_email"
  | "missing_referrer"
  | "missing_recruiter_owner"
  | "missing_stage_history"
  | "missing_stage_definition"
  | "approximate_action_time"
  | "cannot_check_conflict_missing_email"

export type YtdConflictType = "prior_history" | "dual_agency"

export interface YtdSyncRun {
  id: string
  scan_year: number
  run_type: YtdRunType
  channel: YtdChannelInput
  status: YtdRunStatus
  started_at: string
  completed_at: string | null
  applications_scanned: number
  facts_upserted: number
  stage_events_upserted: number
  error_message: string | null
  metadata: Record<string, unknown> | null
}

export interface YtdGHApplication extends GHApplication {
  source_id?: number | null
  recruiter_id?: number | null
  referrer_id?: number | null
  stage_id?: number | null
  updated_at?: string | null
}

export interface YtdGHCandidate {
  id: number
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  title?: string | null
  email_addresses?: Array<{ value?: string | null; type?: string | null }> | null
  phone_numbers?: Array<{ value?: string | null; type?: string | null }> | null
  website_addresses?: Array<{ value?: string | null; type?: string | null }> | null
  social_media_addresses?: Array<{ value?: string | null; type?: string | null }> | null
}

export interface YtdGHJob {
  id: number
  name?: string | null
  department_id?: number | null
}

export interface YtdGHDepartment {
  id: number
  name?: string | null
}

export interface YtdGHApplicationStage {
  id: number
  application_id: number
  job_interview_stage_id: number | null
  entered_at: string | null
  exited_at: string | null
  days_in_stage: number | null
  current: boolean
}

export interface YtdGHJobInterviewStage {
  id: number
  job_id: number
  name?: string | null
  stage_name?: string | null
  active?: boolean | null
  order?: number | null
  priority?: number | null
  sort_order?: number | null
}

export interface YtdGHJobOwner {
  id?: number | null
  job_id: number
  user_id: number
  type: "sourcer" | "recruiter" | "coordinator" | string
}

export interface YtdGHUser {
  id: number
  first_name?: string | null
  last_name?: string | null
  name?: string | null
  primary_email?: string | null
  email?: string | null
  emails?: Array<{ value?: string | null; type?: string | null }> | null
  deactivated?: boolean | null
}

export interface YtdCandidateSummary {
  id: number
  name: string | null
  email: string | null
  first_name: string | null
  last_name: string | null
  company: string | null
  title: string | null
  phones: string[]
  profile_urls: string[]
}

export interface YtdJobSummary {
  id: number
  title: string | null
  department_id: number | null
  department_name: string | null
}

export interface YtdStageDefinition {
  job_interview_stage_id: number
  job_id: number
  stage_name: string | null
  stage_rank: number
  active: boolean | null
  last_synced_at?: string
}

export interface YtdStageEvent {
  id: number
  application_id: number
  job_interview_stage_id: number | null
  stage_name: string | null
  stage_rank: number | null
  entered_at: string | null
  exited_at: string | null
  days_in_stage: number | null
  current: boolean
  sync_run_id?: string | null
}

export interface YtdJobOwnerSnapshot {
  job_id: number
  user_id: number
  owner_type: string
  user_name: string | null
  user_email: string | null
  active: boolean
  last_seen_run_id?: string | null
  last_seen_at?: string
}

export interface YtdApplicationFact {
  application_id: number
  scan_year: number
  channel: YtdChannel
  candidate_id: number
  candidate_name: string | null
  candidate_email: string | null
  job_id: number
  job_title: string | null
  source_id: number | null
  source_name: string | null
  department_id: number | null
  department_name: string | null
  application_status: string | null
  applied_at: string | null
  submitted_at: string | null
  last_activity_at: string | null
  referrer_id: number | null
  referrer_name: string | null
  agency_source_id: number | null
  agency_source_name: string | null
  primary_recruiter_id: number | null
  primary_recruiter_name: string | null
  recruiter_ids: number[]
  recruiter_names: string[]
  current_stage_id: number | null
  current_stage_name: string | null
  current_stage_entered_at: string | null
  application_review_entered_at: string | null
  application_review_exited_at: string | null
  actioned_at: string | null
  first_action_at: string | null
  action_time_hours: number | null
  first_action_time_hours: number | null
  never_actioned: boolean
  action_time_quality: ActionTimeQuality
  action_bucket: AgencyActionBucket
  max_stage_id: number | null
  max_stage_name: string | null
  max_stage_rank: number | null
  terminal_outcome: TerminalOutcome
  conflict_detected: boolean
  conflict_types: YtdConflictType[]
  dual_agency_group_key: string | null
  prior_internal_application_ids: number[]
  duplicate_confidence: DuplicateConfidence
  duplicate_evidence_types: DuplicateEvidenceType[]
  duplicate_candidate_ids: number[]
  fee_risk_state: FeeRiskState
  fee_risk_reason: string | null
  conflict_detail: Record<string, unknown> | null
  data_quality_flags: YtdDataQualityFlag[]
  last_synced_at: string
  sync_run_id?: string | null
}

export interface YtdBuildContext {
  scanYear: number
  syncRunId: string | null
  nowIso: string
  channel: YtdChannel
  applications: YtdGHApplication[]
  candidatesById: Map<number, YtdCandidateSummary>
  jobsById: Map<number, YtdJobSummary>
  stageEventsByApplicationId: Map<number, YtdStageEvent[]>
  ownersByJobId: Map<number, YtdJobOwnerSnapshot[]>
  usersById: Map<number, YtdGHUser>
  // GH `/referrers` registry, keyed by referrer id. An application's top-level `referrer_id`
  // is a `/referrers.id` (NOT a user id), so this is the only join that yields a referrer name.
  referrersById: Map<number, YtdGHReferrer>
}

// A Greenhouse `/referrers` record: the referral registry. `id` is what an application's
// `referrer_id` points at; `user_id` is the referrer's GH user; `name` is the display name.
export interface YtdGHReferrer {
  id: number
  user_id?: number | null
  name?: string | null
}

export interface YtdRunOptions {
  year?: number
  channel?: YtdChannelInput
  dryRun?: boolean
  runType: YtdRunType
}

export interface YtdRunResult {
  run_id: string | null
  dry_run: boolean
  scan_year: number
  channel: YtdChannelInput
  applications_scanned: number
  facts_upserted: number
  stage_events_upserted: number
  /** Applications fetched but skipped because they carry no job_id (not req-attributable). */
  applications_skipped_no_job: number
  data_quality: Record<YtdDataQualityFlag, number>
}

export interface YtdPriorApplication {
  application_id: number
  candidate_id: number
  job_id: number
  job_title: string | null
  source_id: number | null
  source_name: string | null
  status: string | null
  current_stage_name: string | null
  applied_at: string | null
}

export interface YtdApplicationsPage {
  items: YtdApplicationFact[]
  page: number
  page_size: number
  total: number
}

export interface YtdAgencyFilters {
  year: number
  department_id?: number
  recruiter_id?: number
  agency_source_id?: number
  action_bucket?: AgencyActionBucket
  duplicate_confidence?: DuplicateConfidence
  fee_risk_state?: FeeRiskState
  current_stage_name?: string
  terminal_outcome?: TerminalOutcome
}

export interface YtdAgencySort {
  sort_by?: string
  sort_dir?: "asc" | "desc"
}
