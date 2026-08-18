/**
 * Shared Supabase queries for sweep dashboard data.
 * Used by both the server component (page.tsx) and the API route.
 */

import { supabase } from "./supabase"
import { resolvedOrNull, agencySourceDefectLabel } from "./resolution-display"
import { computeSweepHealth } from "./sweep-health"
import type {
  AgencyResolutionStatus,
  ResolutionConfidence,
  ResolutionStatus,
} from "./resolution-types"
import type {
  ReferralSweepDashboardData,
  AgencySweepDashboardData,
  SweepRunSummary,
  SweepHealth,
  ReferralSweepItem,
  ReferralTrackerData,
  AgencyTrackerData,
  AgencySubmission,
  AgencyConflict,
  SweepDashboardData,
  UrgencyTier,
} from "./sweep-types"

// Pure aggregation for AgencyTrackerData.by_agency, extracted so the source_id re-keying + the
// unresolved-source bucketing are unit-testable (test/agency-aggregation.test.ts). Resolved rows key
// on source_id and show the gated name; every non-resolved source collapses into ONE defect bucket
// (key 'unresolved') labelled by agencySourceDefectLabel — NOT a phantom null-name key, which is the
// bug the old name-keyed Map had (every unresolved row landed under one `undefined`/null name).
export function aggregateAgenciesBySource(
  rows: Array<Record<string, unknown>>
): AgencyTrackerData["by_agency"] {
  const UNRESOLVED_KEY = "unresolved"
  const map = new Map<string, AgencyTrackerData["by_agency"][number]>()
  for (const r of rows) {
    const status = (r.source_resolution_status as AgencyResolutionStatus | null) ?? null
    const sourceId = (r.agency_source_id as number | null) ?? null
    const resolved = status === "resolved" && sourceId != null
    const key = resolved ? `id:${sourceId}` : UNRESOLVED_KEY
    const name = resolved
      ? resolvedOrNull(r.agency_source_name as string | null, status) ??
        agencySourceDefectLabel(status)
      : agencySourceDefectLabel(status)
    const entry =
      map.get(key) ??
      {
        source_id: resolved ? sourceId : null,
        agency_name: name,
        resolved,
        submissions: 0,
        conflicts: 0,
        has_dual_agency: false,
      }
    entry.submissions++
    if (r.conflict_detected) entry.conflicts++
    if (r.conflict_type === "dual_agency") entry.has_dual_agency = true
    map.set(key, entry)
  }
  return [...map.values()].sort((a, b) => b.conflicts - a.conflicts)
}

export async function fetchSweepDashboardData(): Promise<SweepDashboardData> {
  const [referral, agency] = await Promise.all([
    getReferralDashboardData(),
    getAgencyDashboardData(),
  ])
  return { referral, agency }
}

export async function getReferralDashboardData(): Promise<ReferralSweepDashboardData> {
  const { data: runRow, error: runError } = await supabase
    .from("sweep_runs")
    .select("*")
    .eq("sweep_type", "referral")
    .eq("status", "completed")
    .order("started_at", { ascending: false })
    .limit(1)
    .single()
  assertSupabaseReadOk(runError, "sweep_runs referral latest run", { allowNoRows: true })

  const latestRun: SweepRunSummary | null = runRow
    ? {
        id: runRow.id,
        sweep_type: "referral",
        started_at: runRow.started_at,
        completed_at: runRow.completed_at,
        status: runRow.status,
        applications_scanned: runRow.applications_scanned,
        items_found: runRow.items_found,
        items_alerted: runRow.items_alerted,
      }
    : null

  let activeReferrals: ReferralSweepItem[] = []
  if (runRow) {
    const { data: items, error: itemsError } = await supabase
      .from("sweep_items")
      .select("*")
      .eq("sweep_run_id", runRow.id)
      .eq("sweep_type", "referral")
    assertSupabaseReadOk(itemsError, "sweep_items referral active items")

    activeReferrals = (items ?? []).map(
      (item: Record<string, unknown>) => ({
        application_id: item.application_id as number,
        candidate_id: item.candidate_id as number,
        job_id: item.job_id as number,
        candidate_name: (item.candidate_name as string) ?? "",
        job_title: (item.job_title as string) ?? "",
        // 015 owner list. Pre-015 rows have no column value -> null, meaning "not recorded",
        // which is distinct from an empty array ("no recruiters on the req").
        recruiter_ids: (item.recruiter_ids as number[] | null) ?? null,
        source_name: (item.source_name as string) ?? "Referral",
        current_stage: (item.current_stage as string) ?? "Unknown",
        application_status: (item.application_status as string) ?? "active",
        application_created_at: item.application_created_at as string,
        current_stage_entered_at:
          (item.current_stage_entered_at as string) ?? null,
        last_activity_at: (item.last_activity_at as string) ?? null,
        hours_in_current_stage:
          (item.hours_in_current_stage as number) ?? 0,
        sla_violated: (item.sla_violated as boolean) ?? false,
        urgency_tier: (item.urgency_tier as UrgencyTier) ?? "new",
        referrer_name: null,
        recruiter_name: null,
        ownership_resolution_status: null,
        ownership_confidence: null,
      })
    )
  }

  const { data: allAlerts, error: alertError } = await supabase
    .from("alert_ledger")
    .select("first_alerted_at, resolved_at")
    .eq("sweep_type", "referral")
  assertSupabaseReadOk(alertError, "alert_ledger referral SLA rows")

  const total = allAlerts?.length ?? 0
  const within24h = (allAlerts ?? []).filter(
    (a: Record<string, unknown>) => {
      if (!a.resolved_at) return false
      const alertTime = new Date(a.first_alerted_at as string).getTime()
      const resolveTime = new Date(a.resolved_at as string).getTime()
      return resolveTime - alertTime < 24 * 60 * 60 * 1000
    }
  ).length

  const { count: unresolvedCount, error: unresolvedError } = await supabase
    .from("alert_ledger")
    .select("id", { count: "exact", head: true })
    .eq("sweep_type", "referral")
    .is("resolved_at", null)
  assertSupabaseReadOk(unresolvedError, "alert_ledger referral unresolved count")

  return {
    latest_run: latestRun,
    active_referrals: activeReferrals,
    sla_compliance: {
      total,
      within_24h: within24h,
      rate: total > 0 ? Math.round((within24h / total) * 100) : 0,
    },
    unresolved_count: unresolvedCount ?? 0,
  }
}

export async function getAgencyDashboardData(): Promise<AgencySweepDashboardData> {
  const { data: runRow, error: runError } = await supabase
    .from("sweep_runs")
    .select("*")
    .eq("sweep_type", "agency")
    .eq("status", "completed")
    .order("started_at", { ascending: false })
    .limit(1)
    .single()
  assertSupabaseReadOk(runError, "sweep_runs agency latest run", { allowNoRows: true })

  const latestRun: SweepRunSummary | null = runRow
    ? {
        id: runRow.id,
        sweep_type: "agency",
        started_at: runRow.started_at,
        completed_at: runRow.completed_at,
        status: runRow.status,
        applications_scanned: runRow.applications_scanned,
        items_found: runRow.items_found,
        items_alerted: runRow.items_alerted,
      }
    : null

  let activeConflicts: AgencyConflict[] = []
  if (runRow) {
    const { data: items, error: itemsError } = await supabase
      .from("sweep_items")
      .select("*")
      .eq("sweep_run_id", runRow.id)
      .eq("sweep_type", "agency")
    assertSupabaseReadOk(itemsError, "sweep_items agency active conflicts")

    activeConflicts = (items ?? []).map(
      (item: Record<string, unknown>) => {
        const detail =
          (item.conflict_detail as Record<string, unknown>) ?? {}
        return {
          agency_application_id: item.application_id as number,
          // Legacy dashboard shape: preserve unresolved source as null, not an invented
          // "Unknown" agency label. The defect is absence, never a sentinel string.
          agency_source_name: (item.source_name as string | null) ?? null,
          candidate_id: (item.candidate_id as number) ?? 0,
          candidate_name: (item.candidate_name as string) ?? "",
          // Legacy compatibility shape; do not ship raw candidate contact PII from broad dashboards.
          candidate_email: null,
          job_id: (item.job_id as number) ?? 0,
          job_title: (item.job_title as string) ?? "",
          prior_applications:
            (detail.prior_applications as AgencyConflict["prior_applications"]) ??
            [],
          conflict_type:
            (detail.conflict_type as AgencyConflict["conflict_type"]) ??
            "prior_history",
          risk_level:
            (detail.risk_level as AgencyConflict["risk_level"]) ?? "low",
        }
      }
    )
  }

  const { count: unresolvedCount, error: unresolvedError } = await supabase
    .from("alert_ledger")
    .select("id", { count: "exact", head: true })
    .eq("sweep_type", "agency")
    .is("resolved_at", null)
  assertSupabaseReadOk(unresolvedError, "alert_ledger agency unresolved count")

  return {
    latest_run: latestRun,
    active_conflicts: activeConflicts,
    unresolved_count: unresolvedCount ?? 0,
  }
}

function assertSupabaseReadOk(
  error: { code?: string; message?: string } | null | undefined,
  queryName: string,
  options: { allowNoRows?: boolean } = {}
) {
  if (!error) return
  if (options.allowNoRows && error.code === "PGRST116") return
  throw new Error(`${queryName} query failed: ${error.message ?? "unknown Supabase error"}`)
}

// ---------------------------------------------------------------------------
// v2 tracker queries
// ---------------------------------------------------------------------------

export async function getReferralTrackerData(): Promise<ReferralTrackerData> {
  const { data: runRow, error: runError } = await supabase
    .from("sweep_runs")
    .select("*")
    .eq("sweep_type", "referral")
    .eq("status", "completed")
    .order("started_at", { ascending: false })
    .limit(1)
    .single()
  // PGRST116 = "no rows" (no sweep has completed yet) — an expected empty state, not a failure. Any
  // other error (e.g. a rejected key) must surface, not render as a phantom empty tracker.
  if (runError && runError.code !== "PGRST116") {
    throw new Error(`sweep_runs query failed: ${runError.message}`)
  }

  const latestRun = toSweepRunSummary(runRow, "referral")
  const health = await loadSweepHealth("referral", latestRun)

  let items: ReferralSweepItem[] = []
  if (runRow) {
    const { data: rows, error: itemsError } = await supabase
      .from("sweep_items")
      .select("*")
      .eq("sweep_run_id", runRow.id)
      .eq("sweep_type", "referral")
      .order("hours_in_current_stage", { ascending: false })
    if (itemsError) throw new Error(`sweep_items query failed: ${itemsError.message}`)

    items = (rows ?? []).map((r: Record<string, unknown>) => ({
      application_id: r.application_id as number,
      candidate_id: r.candidate_id as number,
      job_id: r.job_id as number,
      candidate_name: (r.candidate_name as string) ?? "",
      job_title: (r.job_title as string) ?? "",
      recruiter_ids: (r.recruiter_ids as number[] | null) ?? null,
      source_name: (r.source_name as string) ?? "Referral",
      current_stage: (r.current_stage as string) ?? "Unknown",
      application_status: (r.application_status as string) ?? "",
      application_created_at: (r.application_created_at as string) ?? "",
      current_stage_entered_at: (r.current_stage_entered_at as string) ?? null,
      last_activity_at: (r.last_activity_at as string) ?? null,
      hours_in_current_stage: (r.hours_in_current_stage as number) ?? 0,
      urgency_tier: ((r.urgency_tier as UrgencyTier) ?? "new"),
      referrer_name: (r.referrer_name as string) ?? null,
      recruiter_name: (r.recruiter_name as string) ?? null,
      // select("*") above returns these post-005; pre-005 they are simply absent (-> null), so the
      // tracker degrades to honest defect chips rather than 500ing on a named-column select.
      ownership_resolution_status:
        (r.ownership_resolution_status as ResolutionStatus | null) ?? null,
      ownership_confidence: (r.ownership_confidence as ResolutionConfidence | null) ?? null,
    }))
  }

  const total = items.length
  const actioned = items.filter((i) => i.urgency_tier === "actioned").length
  const approachingSla = items.filter(
    (i) => i.urgency_tier === "sla_risk" || i.urgency_tier === "breach"
  ).length
  const unactioned = total - actioned

  return {
    latest_run: latestRun,
    health,
    items,
    metrics: { total, unactioned, approaching_sla: approachingSla, actioned },
  }
}

/** Build a run summary from a raw sweep_runs row, or null. One shape for both the
 *  displayed "last completed" run and the health probe's "last attempt" run. */
function toSweepRunSummary(
  row: Record<string, unknown> | null | undefined,
  sweepType: SweepRunSummary["sweep_type"]
): SweepRunSummary | null {
  if (!row) return null
  return {
    id: row.id as string,
    sweep_type: sweepType,
    started_at: row.started_at as string,
    completed_at: (row.completed_at as string | null) ?? null,
    status: row.status as SweepRunSummary["status"],
    applications_scanned: (row.applications_scanned as number) ?? 0,
    items_found: (row.items_found as number) ?? 0,
    items_alerted: (row.items_alerted as number) ?? 0,
    error_message: (row.error_message as string | null) ?? null,
  }
}

/** Probe the lane's true most-recent run (any status) and fold it with the
 *  already-loaded last-completed run into a health verdict. Kept separate from
 *  the tracker's displayed data so a failing lane cannot hide behind it. */
async function loadSweepHealth(
  sweepType: SweepRunSummary["sweep_type"],
  latestSuccess: SweepRunSummary | null
): Promise<SweepHealth> {
  const { data: attemptRow, error: attemptError } = await supabase
    .from("sweep_runs")
    .select("*")
    .eq("sweep_type", sweepType)
    .order("started_at", { ascending: false })
    .limit(1)
    .single()
  if (attemptError && attemptError.code !== "PGRST116") {
    throw new Error(`sweep_runs health query failed: ${attemptError.message}`)
  }
  return computeSweepHealth({
    sweepType,
    latestAttempt: toSweepRunSummary(attemptRow, sweepType),
    latestSuccess,
    nowMs: Date.now(),
  })
}

function stripSubmissionPII(rows: Array<Record<string, unknown>>): AgencySubmission[] {
  return rows.map((r) => {
    const row = { ...r }
    delete row.candidate_email
    if (row.conflict_detail && typeof row.conflict_detail === "object") {
      const detail = { ...(row.conflict_detail as Record<string, unknown>) }
      delete detail.candidate_email
      row.conflict_detail = detail
    }
    return row
  }) as unknown as AgencySubmission[]
}

export async function getAgencyTrackerData(): Promise<AgencyTrackerData> {
  // YTD total from agency_submissions. Surface query errors (e.g. a rejected key) instead of letting
  // supabase-js's in-band error fall through to a phantom 0 — the 2026-05-31 incident where a rotated
  // key rendered as a calm empty dashboard. page.tsx's try/catch turns this into the honest "unavailable".
  const { count: submissionsYtd, error: ytdError } = await supabase
    .from("agency_submissions")
    .select("id", { count: "exact", head: true })
    .gte("submitted_at", "2026-01-01T00:00:00Z")
  if (ytdError) throw new Error(`agency_submissions YTD count failed: ${ytdError.message}`)

  // Conflicts
  const { data: conflictRows, error: conflictError } = await supabase
    .from("agency_submissions")
    .select("*")
    .eq("conflict_detected", true)
    .order("created_at", { ascending: false })
  if (conflictError) throw new Error(`agency_submissions conflicts query failed: ${conflictError.message}`)

  const conflicts = stripSubmissionPII(
    (conflictRows ?? []) as Array<Record<string, unknown>>
  )
  const dualAgencyCount = conflicts.filter(
    (c) => c.conflict_type === "dual_agency"
  ).length
  const conflictsDetected = conflicts.length
  const cleared = (submissionsYtd ?? 0) - conflictsDetected

  const { data: agencyRows, error: agencyError } = await supabase
    .from("agency_submissions")
    .select("*")
    .gte("submitted_at", "2026-01-01T00:00:00Z")
    .order("submitted_at", { ascending: false })
  if (agencyError) throw new Error(`agency_submissions query failed: ${agencyError.message}`)

  const allSubmissions = stripSubmissionPII(
    (agencyRows ?? []) as Array<Record<string, unknown>>
  )
  const byAgency = aggregateAgenciesBySource(
    (agencyRows ?? []) as Array<Record<string, unknown>>
  )

  // The agency tracker's figures come from agency_submissions, but its liveness
  // depends on the agency sweep_run lane — so its health is probed the same way
  // the referral tracker's is, from the last completed run and the last attempt.
  const { data: completedRow, error: completedError } = await supabase
    .from("sweep_runs")
    .select("*")
    .eq("sweep_type", "agency")
    .eq("status", "completed")
    .order("started_at", { ascending: false })
    .limit(1)
    .single()
  if (completedError && completedError.code !== "PGRST116") {
    throw new Error(`sweep_runs agency query failed: ${completedError.message}`)
  }
  const health = await loadSweepHealth("agency", toSweepRunSummary(completedRow, "agency"))

  return {
    health,
    submissions_ytd: submissionsYtd ?? 0,
    conflicts_detected: conflictsDetected,
    dual_agency_count: dualAgencyCount,
    cleared: Math.max(0, cleared),
    conflict_alerts: conflicts,
    all_submissions: allSubmissions,
    by_agency: byAgency,
  }
}
