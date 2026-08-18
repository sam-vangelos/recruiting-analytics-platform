import { supabase } from "./supabase"
import type { YtdChannelInput } from "./ytd-types"

// Honest load contract for the YTD page servers (app/{referrals,agency}/ytd/page.tsx).
//
// The loaders return a populated ZERO object on an empty table — they do not throw — so a
// page whose facts table was never written (e.g. referral, which has never been backfilled)
// renders a complete dashboard of zeros that is indistinguishable from a truthful "zero YTD"
// answer. That is exactly how an 18-day writer outage hid behind a plausible UI. This module
// gives the pages two missing signals: (1) a classifier so a thrown loader error reads as a
// credentials/auth problem vs. some other failure, and (2) a sync-health read of ytd_sync_runs
// (the table nothing else reads) so the page can tell "no completed sync yet" apart from
// "genuinely zero". Both pages are near-identical, so the logic lives here once.

/** A thrown loader error classified for display. "auth" means the message looks like a Supabase
 *  credential/permission failure (rotated/blank key, expired JWT, 401) — the operator should
 *  check env, not assume an empty table. Everything else is "other". */
export function classifyLoaderError(err: unknown): "auth" | "other" {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  // PostgREST / supabase-js auth + permission surfaces. Kept deliberately small; the point is
  // one extra bit ("this smells like credentials"), not an exhaustive taxonomy.
  if (
    message.includes("jwt") ||
    message.includes("jws") ||
    message.includes("invalid api key") ||
    message.includes("no api key") ||
    message.includes("api key found") ||
    message.includes("401") ||
    message.includes("unauthorized") ||
    message.includes("permission denied") ||
    message.includes("not authorized")
  ) {
    return "auth"
  }
  return "other"
}

export interface SyncStatus {
  /** completed_at of the most recent COMPLETED run touching this channel; null ⇒ never synced. */
  lastCompletedAt: string | null
  /** status of the most recent run touching this channel (any status), or null if none exist. */
  lastStatus: "completed" | "failed" | "running" | null
  /** error_message of that most recent run when it failed; null otherwise. */
  lastError: string | null
}

/** Read the latest sync health for a channel from ytd_sync_runs. Mirrors incrementalSinceIso's
 *  scoping (channel IN (channel,'all'), newest first). Best-effort: a read failure returns the
 *  unknown state ({nulls}) rather than throwing — sync health is a hint layered on top of the
 *  real data load, never a reason to fail the page. */
export async function getLatestSyncStatus(
  year: number,
  channel: YtdChannelInput
): Promise<SyncStatus> {
  const unknown: SyncStatus = { lastCompletedAt: null, lastStatus: null, lastError: null }
  try {
    const { data, error } = await supabase
      .from("ytd_sync_runs")
      .select("status, completed_at, error_message, channel")
      .eq("scan_year", year)
      .in("channel", channel === "all" ? ["all"] : [channel, "all"])
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(50)
    if (error || !data) return unknown

    const rows = data as Array<{
      status: string | null
      completed_at: string | null
      error_message: string | null
    }>
    if (rows.length === 0) return unknown

    const latest = rows[0]
    const firstCompleted = rows.find((row) => row.status === "completed" && row.completed_at)
    return {
      lastCompletedAt: firstCompleted?.completed_at ?? null,
      lastStatus:
        latest.status === "completed" || latest.status === "failed" || latest.status === "running"
          ? latest.status
          : null,
      lastError: latest.status === "failed" ? latest.error_message ?? null : null,
    }
  } catch {
    return unknown
  }
}

/** A non-fatal banner the page shows ABOVE a (possibly zero) workbench when the pipeline health
 *  contradicts the data — e.g. zero rows but no completed sync. Distinct from a hard load error
 *  (which replaces the workbench entirely). */
export interface YtdNotice {
  tone: "warning" | "danger"
  headline: string
  detail: string
}

/** Build the unsynced/empty notice, or null when the data can be trusted as-is. Call only on a
 *  successful load. `submissions` is the channel's headline count (0 ⇒ empty). When the table is
 *  empty AND no completed sync exists, the zeros are NOT a real answer — surface that, escalating
 *  to danger if the most recent run actually failed. A non-empty table, or an empty one with a
 *  completed sync behind it (a genuine zero), returns null. */
export function buildSyncNotice(submissions: number, sync: SyncStatus): YtdNotice | null {
  if (submissions > 0) return null
  if (sync.lastCompletedAt) return null // genuinely zero — a completed sync stands behind it

  if (sync.lastStatus === "failed") {
    return {
      tone: "danger",
      headline: "No completed sync — the last run failed",
      detail: sync.lastError
        ? `Latest sync error: ${sync.lastError}`
        : "The most recent sync run failed; this view may be incomplete.",
    }
  }
  return {
    tone: "warning",
    headline: "No completed sync yet",
    detail:
      "No sync run has completed for this channel and year, so this view may be incomplete rather than genuinely empty.",
  }
}
