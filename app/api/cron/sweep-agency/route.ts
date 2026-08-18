import { NextResponse } from "next/server"
import { runAgencySweep } from "@/lib/sweep-agency"
import { checkResolutions } from "@/lib/sweep-action-tracker"
import { supabase } from "@/lib/supabase"
import { noStoreServerErrorJson, requireCronSecret } from "../../ytd/route-utils"

export const maxDuration = 120

// ---------------------------------------------------------------------------
// C6 — concurrency guard for the agency sweep cron.
//
// Two layers, owned in two places:
//   1. The advisory lock (lib/sweep-agency.ts:327-333,771) keeps two overlapping ticks from
//      both walking the same window. runAgencySweep takes a session-scoped pg lock BEFORE it
//      creates the sweep_runs row; when a concurrent run already holds it, runAgencySweep
//      returns `{ run: null, skipped: true }` having created/mutated NOTHING. This route only
//      has to RESPECT that shape — exit cleanly without dereferencing the null run.
//   2. This reaper is the backstop the lock can't be (sweep-agency.ts:103-110): a session-pinned
//      advisory lock lives on one backend connection, so under a transaction-mode pooler the
//      acquire/work/release can land on different backends and the lock evaporates mid-run. A run
//      that dies that way (or on a hard crash / function timeout) leaves its sweep_runs row stuck
//      in 'running' forever, which poisons every "latest run" surface and any future
//      lock-vs-row reasoning. Before starting, reclaim any 'running' agency row whose started_at
//      predates the TTL by flipping it to 'failed'.
//
// The TTL must exceed the longest a healthy run can take, or the reaper would kill a live run.
// maxDuration caps a single invocation at 120s; the grace below sits an order of magnitude
// above that (same posture as ytd-extract.ts:600-607's OWNER_STALE_GRACE_MS — "comfortably
// exceeds maxDuration so an in-flight run is never treated as stale"). A run still 'running'
// past this window is, by construction, abandoned.
//
// This is a plain table UPDATE against sweep_runs (migration 001) — no RPC, no new schema — so
// it is correct independent of the advisory-lock SQL functions the Verify-stage cron+migration
// cluster wires downstream. Scoped to sweep_type='agency': this cron owns only the agency sweep,
// and the sibling crons (referral / ytd-incremental / reconcile) reap their own kind.
// ---------------------------------------------------------------------------

const STALE_RUNNING_TTL_MS = 30 * 60 * 1000 // 30m » 120s maxDuration

interface ReapedRun {
  id: string
  started_at: string
}

/** Reclaim agency sweep_runs stuck in 'running' past the TTL: flip to 'failed' with a diagnostic
 *  reason and a completion stamp. Returns the reaped rows (for the cron's response). Best-effort —
 *  a reaper failure is logged and the sweep still runs, since the advisory lock is the primary
 *  concurrency guard and a leaked 'running' row is a reporting defect, not a correctness one. */
async function reapStaleAgencyRuns(): Promise<ReapedRun[]> {
  const staleBefore = new Date(Date.now() - STALE_RUNNING_TTL_MS).toISOString()
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from("sweep_runs")
    .update({
      status: "failed",
      completed_at: now,
      error_message: `Reaped by cron: stuck in 'running' past ${STALE_RUNNING_TTL_MS}ms TTL (likely an abandoned run — crash, timeout, or a pooled advisory lock lost mid-run).`,
    })
    .eq("sweep_type", "agency")
    .eq("status", "running")
    .lt("started_at", staleBefore)
    .select("id, started_at")

  if (error) {
    // Don't let a reaper failure block the sweep — it's a backstop, not a gate.
    console.error("[cron/sweep-agency] Stale-run reaper failed:", error.message)
    return []
  }
  const reaped = (data ?? []) as ReapedRun[]
  if (reaped.length > 0) {
    console.warn(
      `[cron/sweep-agency] Reaped ${reaped.length} stale 'running' agency run(s):`,
      reaped.map((r) => r.id).join(", ")
    )
  }
  return reaped
}

export async function GET(request: Request) {
  // Fail-closed cron auth via the shared helper — an unset/blank CRON_SECRET rejects (this route
  // runs the sweep through the service-role client; an unconfigured deploy must not expose it).
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  try {
    // Reap abandoned 'running' rows BEFORE starting so the run set is clean (and a row whose
    // advisory lock was lost to pooling can't wedge "latest run" forever).
    const reaped = await reapStaleAgencyRuns()

    const result = await runAgencySweep({ lookbackHours: 72 })

    // Advisory-lock aware: a concurrent run held the lock, so this tick did nothing and `run` is
    // null (sweep-agency.ts:332). Exit cleanly WITHOUT touching result.run — skip the resolution
    // pass too (the run that owns the lock is already doing the work).
    if (result.skipped || !result.run) {
      return NextResponse.json({
        skipped: true,
        reason: "A concurrent agency sweep holds the advisory lock; nothing to do.",
        reaped_stale_runs: reaped.length,
      })
    }

    // Slack notifications disabled — surface in dashboard only for now
    const resolutions = await checkResolutions("agency")

    return NextResponse.json({
      sweep: {
        applications_scanned: result.run.applications_scanned,
        conflicts_found: result.run.items_found,
        new_alerts: result.newAlerts,
      },
      resolutions,
      reaped_stale_runs: reaped.length,
      run_id: result.run.id,
    })
  } catch (err) {
    return noStoreServerErrorJson("cron/sweep-agency", err)
  }
}
