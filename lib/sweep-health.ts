import type { SweepHealth, SweepRunSummary } from "./sweep-types"

/** A non-fatal banner the tracker shows above its figures when the sweep lane's
 *  health contradicts the data. Same shape as the YTD NoticeBanner tone contract
 *  (lib/ytd-page-load.ts) so the two workbench families read identically. */
export interface SweepHealthNotice {
  tone: "warning" | "danger"
  headline: string
  detail: string
}

/** Cadence per sweep lane: referral runs hourly, agency every four hours
 *  (vercel.json crons / the us-central1 Cloud Scheduler jobs). Used only to decide
 *  when a *gap* in runs means the scheduler stopped, not that a run is pending. */
export const SWEEP_CADENCE_HOURS: Record<SweepRunSummary["sweep_type"], number> = {
  referral: 1,
  agency: 4,
}

/** How many cadences may elapse with no run before the lane is "stalled" rather
 *  than merely between runs. Three tolerates one missed tick plus clock skew. */
const STALL_CADENCE_MULTIPLE = 3

const HOUR_MS = 3_600_000

/**
 * Derive a sweep lane's health from its most recent attempt and most recent
 * success. The tracker's figures come from the last *completed* run; this exists
 * so a lane that has since started failing — the June 2026 Greenhouse-401 outage
 * ran unnoticed for eleven days — cannot present as healthy behind a stale-but-
 * plausible timestamp.
 *
 * `latestSuccess` is passed in (the tracker already holds it as `latest_run`) so
 * this stays a pure function of its inputs and `nowMs`.
 */
export function computeSweepHealth(input: {
  sweepType: SweepRunSummary["sweep_type"]
  latestAttempt: SweepRunSummary | null
  latestSuccess: SweepRunSummary | null
  nowMs: number
}): SweepHealth {
  const { sweepType, latestAttempt, latestSuccess, nowMs } = input

  if (!latestAttempt) {
    return { latest_attempt: null, latest_success: latestSuccess, status: "unknown", reason: "never_run" }
  }

  if (latestAttempt.status === "failed") {
    return { latest_attempt: latestAttempt, latest_success: latestSuccess, status: "degraded", reason: "last_run_failed" }
  }

  // A run that started but never finished is fine while young (in-flight) and a
  // problem once old (the scheduler stopped, or a run wedged). Age is measured
  // from the newest attempt of any status, so a healthy tick resets it.
  const startedMs = Date.parse(latestAttempt.started_at)
  const stallMs = SWEEP_CADENCE_HOURS[sweepType] * STALL_CADENCE_MULTIPLE * HOUR_MS
  if (Number.isFinite(startedMs) && nowMs - startedMs > stallMs) {
    return { latest_attempt: latestAttempt, latest_success: latestSuccess, status: "degraded", reason: "stalled" }
  }

  return { latest_attempt: latestAttempt, latest_success: latestSuccess, status: "healthy", reason: "ok" }
}

/** Turn a degraded/unknown health into a banner, or null when the lane is
 *  healthy. Danger for an active failure or a stalled scheduler; warning only
 *  for the benign never-run state. */
export function buildSweepHealthNotice(health: SweepHealth): SweepHealthNotice | null {
  if (health.reason === "last_run_failed") {
    const error = health.latest_attempt?.error_message?.trim()
    return {
      tone: "danger",
      headline: "Most recent sweep failed",
      detail: error
        ? `The last sweep did not complete: ${error}. The figures below are from the last successful run and may be stale.`
        : "The last sweep did not complete. The figures below are from the last successful run and may be stale.",
    }
  }

  if (health.reason === "stalled") {
    return {
      tone: "danger",
      headline: "Sweeps have stopped running",
      detail:
        "No sweep has run within its expected window — the scheduler may be paused or failing. The figures below are stale.",
    }
  }

  if (health.reason === "never_run") {
    return {
      tone: "warning",
      headline: "No sweep has run yet",
      detail:
        "No sweep run exists for this lane, so this view may be incomplete rather than genuinely empty.",
    }
  }

  return null
}
