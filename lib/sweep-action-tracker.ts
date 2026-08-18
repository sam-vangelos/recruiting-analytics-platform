/**
 * Action tracking: re-scans Greenhouse to detect resolutions on alerted items.
 * Called after each sweep to auto-resolve alerts when stage changes, rejections,
 * or hires occur.
 */

import { supabase } from "./supabase"
import { greenhouseGetAll } from "./greenhouse-client"
import { ghStageName, type GHApplication } from "./sweep-types"

interface ResolutionResult {
  resolved: number
  still_pending: number
  /** Unresolved alerts whose application could NOT be re-fetched from Greenhouse this tick
   *  (projection gap or — the dangerous case — an auth outage). A bare `continue` made an
   *  outage look like a clean "nothing to resolve" tick; this counter + the warn make it
   *  visible, and it is the health signal the escalation interlock reads. */
  unfetched: number
}

// Alert-time / resolution-time stage values that are NOT real pipeline stage names: the
// 'Unknown' projection-gap sentinel (ghStageName when stage_name/current_stage.name are absent,
// sweep-types.ts) and the agency status literals stored as greenhouse_stage_at_alert
// (sweep-agency.ts stores 'active'). A stage_change resolution must compare two REAL stages.
const SENTINEL_STAGES = new Set(["Unknown", "active", "in_process"])

/** True when `stage` is a real pipeline stage name, not a sentinel/empty. */
export function isRealStage(stage: string | null | undefined): boolean {
  return typeof stage === "string" && stage.trim() !== "" && !SENTINEL_STAGES.has(stage)
}

export interface ResolutionVerdict {
  resolution_type: "rejection" | "hire" | "stage_change"
  resolution_detail: string
  greenhouse_stage_at_resolution: string | null
}

/**
 * Decide whether an alerted application has been ACTIONED (and how), or stays unresolved.
 * PURE — no Greenhouse, no Supabase — so it is unit-testable in isolation, which is the whole
 * point of the extraction.
 *
 * The load-bearing fix vs the old inline logic (this file pre-extraction, the stage-change
 * branch): a stage change resolves ONLY when BOTH the alert-time stage AND the current stage are
 * REAL stage names that differ. The old code guarded only the current side against 'Unknown', so
 * an alert that captured the 'Unknown' projection sentinel (or agency's 'active' literal) at
 * alert time would false-resolve the instant the real stage name became readable — even though
 * the candidate never moved. That was ~29% of prod resolutions (7/24). Resolving a strict
 * subset of what the old code did, this can only ever REFUSE a wrong resolution, never invent one.
 */
export function classifyResolution(
  alert: { greenhouse_stage_at_alert: string | null },
  app: GHApplication
): ResolutionVerdict | null {
  if (app.status === "rejected") {
    return {
      resolution_type: "rejection",
      resolution_detail: "Application rejected in Greenhouse",
      greenhouse_stage_at_resolution: ghStageName(app) ?? null,
    }
  }
  if (app.status === "hired") {
    return {
      resolution_type: "hire",
      resolution_detail: "Candidate hired",
      greenhouse_stage_at_resolution: ghStageName(app) ?? null,
    }
  }
  const current = ghStageName(app)
  if (
    isRealStage(alert.greenhouse_stage_at_alert) &&
    isRealStage(current) &&
    current !== alert.greenhouse_stage_at_alert
  ) {
    return {
      resolution_type: "stage_change",
      resolution_detail: `Stage changed: ${alert.greenhouse_stage_at_alert} → ${current}`,
      greenhouse_stage_at_resolution: current,
    }
  }
  return null
}

export async function checkResolutions(
  sweepType: "referral" | "agency"
): Promise<ResolutionResult> {
  // Fetch unresolved entries from the alert ledger
  const { data: pendingAlerts, error } = await supabase
    .from("alert_ledger")
    .select("id, application_id, greenhouse_stage_at_alert")
    .eq("sweep_type", sweepType)
    .is("resolved_at", null)

  if (error || !pendingAlerts || pendingAlerts.length === 0) {
    return { resolved: 0, still_pending: pendingAlerts?.length ?? 0, unfetched: 0 }
  }

  // Batch-fetch current state from Greenhouse
  const appIds = pendingAlerts.map(
    (a: { application_id: number }) => a.application_id
  )

  // Greenhouse limits ids param, batch in groups of 50
  const currentApps = new Map<number, GHApplication>()
  for (let i = 0; i < appIds.length; i += 50) {
    const batch = appIds.slice(i, i + 50)
    const apps = await greenhouseGetAll<GHApplication>("/applications", {
      ids: batch.join(","),
    })
    for (const app of apps) {
      currentApps.set(app.id, app)
    }
  }

  let resolved = 0
  let unfetched = 0
  const now = new Date().toISOString()

  for (const alert of pendingAlerts) {
    const app = currentApps.get(alert.application_id)
    if (!app) {
      // Could not re-fetch this application from Greenhouse — leave it unresolved (correct),
      // but COUNT it so a silent Greenhouse-auth outage (which would otherwise look like a
      // clean "everything still pending" tick) is observable.
      unfetched++
      continue
    }

    const verdict = classifyResolution(alert, app)
    if (verdict) {
      await supabase
        .from("alert_ledger")
        .update({
          resolved_at: now,
          resolution_type: verdict.resolution_type,
          resolution_detail: verdict.resolution_detail,
          greenhouse_stage_at_resolution: verdict.greenhouse_stage_at_resolution,
        })
        .eq("id", alert.id)
      resolved++
    }
  }

  if (unfetched > 0) {
    console.warn(
      `[action-tracker] ${sweepType}: ${unfetched} of ${pendingAlerts.length} unresolved alerts could not be re-fetched from Greenhouse this tick (projection gap or auth outage) — left unresolved`
    )
  }

  return {
    resolved,
    still_pending: pendingAlerts.length - resolved,
    unfetched,
  }
}
