import { supabase } from "./supabase"
import { listUsers } from "./greenhouse-evidence"
import { lookupSlackUserByEmail } from "./slack-resolve"

// P3 — maintain the recruiter_id -> slack_id directory (migration 009). Runs daily inside the
// reconcile-identity cron (GH + Slack IO lives there, NOT in the enqueuer/drain — the W3
// failure-domain isolation contract). The drain reads it via loadSlackIdsForRecruiters at send
// time. resolution_status carries an honest defect when there is no slack id, never a fake one.

const STALE_DAYS = 7

export interface DirectoryRefreshResult {
  /** Distinct recruiter ids in the universe (fact owners). */
  scanned: number
  /** Ids actually looked up this run (skips fresh 'resolved'). */
  attempted: number
  resolved: number
  email_missing: number
  slack_not_found: number
  errors: number
  /** True if the bot token lacks users:read.email — the loop stopped early; add the scope. */
  scope_blocked: boolean
}

/** Distinct non-null primary_recruiter_id across ytd_application_facts (the owners who could
 *  receive a DM). Paginated past the 1000-row PostgREST cap. */
async function loadDistinctRecruiterIds(): Promise<number[]> {
  const ids = new Set<number>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("ytd_application_facts")
      .select("primary_recruiter_id")
      .not("primary_recruiter_id", "is", null)
      .range(from, from + 999)
    if (error) throw error
    const rows = (data ?? []) as Array<{ primary_recruiter_id: number | null }>
    for (const r of rows) if (typeof r.primary_recruiter_id === "number") ids.add(r.primary_recruiter_id)
    if (rows.length < 1000) break
  }
  return [...ids]
}

interface DirRow {
  greenhouse_user_id: number
  resolution_status: string
  last_verified_at: string
}

async function loadDirectory(): Promise<Map<number, DirRow>> {
  const map = new Map<number, DirRow>()
  const { data, error } = await supabase
    .from("recruiter_slack_directory")
    .select("greenhouse_user_id, resolution_status, last_verified_at")
    .range(0, 9999)
  if (error) throw error
  for (const r of (data ?? []) as DirRow[]) map.set(r.greenhouse_user_id, r)
  return map
}

export async function refreshRecruiterSlackDirectory(): Promise<DirectoryRefreshResult> {
  const recruiterIds = await loadDistinctRecruiterIds()
  const existing = await loadDirectory()
  const nowMs = Date.now()
  const staleMs = STALE_DAYS * 24 * 3600 * 1000

  // Re-resolve anything not already a FRESH 'resolved' row (so we don't hammer Slack daily for the
  // stable bulk, but do retry defects + refresh stale rows).
  const toResolve = recruiterIds.filter((id) => {
    const row = existing.get(id)
    if (!row) return true
    if (row.resolution_status !== "resolved") return true
    return nowMs - new Date(row.last_verified_at).getTime() > staleMs
  })

  const result: DirectoryRefreshResult = {
    scanned: recruiterIds.length,
    attempted: 0,
    resolved: 0,
    email_missing: 0,
    slack_not_found: 0,
    errors: 0,
    scope_blocked: false,
  }
  if (toResolve.length === 0) return result

  const users = await listUsers(toResolve)
  const emailById = new Map<number, string | null>()
  for (const u of users) emailById.set(u.id, u.primary_email ?? u.email ?? null)

  const nowIso = new Date().toISOString()
  const upserts: Array<Record<string, unknown>> = []
  for (const id of toResolve) {
    const email = emailById.get(id) ?? null
    if (!email) {
      upserts.push({
        greenhouse_user_id: id,
        primary_email: null,
        slack_user_id: null,
        resolution_status: "email_missing",
        last_verified_at: nowIso,
      })
      result.email_missing += 1
      continue
    }
    const lookup = await lookupSlackUserByEmail(email)
    result.attempted += 1
    if (lookup.status === "scope_blocked") {
      // The bot lacks users:read.email. Record this id, STOP (resolving more is pointless and
      // hammers Slack), and signal the caller. Remaining ids keep their current rows.
      upserts.push({
        greenhouse_user_id: id,
        primary_email: email,
        slack_user_id: null,
        resolution_status: "scope_blocked",
        last_verified_at: nowIso,
      })
      result.scope_blocked = true
      break
    }
    if (lookup.status === "resolved") {
      upserts.push({
        greenhouse_user_id: id,
        primary_email: email,
        slack_user_id: lookup.slack_user_id,
        resolution_status: "resolved",
        last_verified_at: nowIso,
      })
      result.resolved += 1
    } else if (lookup.status === "slack_not_found") {
      upserts.push({
        greenhouse_user_id: id,
        primary_email: email,
        slack_user_id: null,
        resolution_status: "slack_not_found",
        last_verified_at: nowIso,
      })
      result.slack_not_found += 1
    } else {
      // Transient error — leave the row untouched for the next run rather than persist a bad state.
      result.errors += 1
    }
  }

  if (upserts.length > 0) {
    const { error } = await supabase
      .from("recruiter_slack_directory")
      .upsert(upserts, { onConflict: "greenhouse_user_id" })
    if (error) throw error
  }
  return result
}

/** P4 read helper: slack ids for a set of recruiter ids (pure Supabase, called at drain time).
 *  A missing/null entry means "no resolved slack id" — the caller falls back to head-of-TA. */
export async function loadSlackIdsForRecruiters(
  ids: number[]
): Promise<Map<number, string | null>> {
  const map = new Map<number, string | null>()
  const unique = [...new Set(ids)]
  if (unique.length === 0) return map
  const { data, error } = await supabase
    .from("recruiter_slack_directory")
    .select("greenhouse_user_id, slack_user_id")
    .in("greenhouse_user_id", unique)
  if (error) throw error
  for (const row of (data ?? []) as Array<{ greenhouse_user_id: number; slack_user_id: string | null }>) {
    map.set(row.greenhouse_user_id, row.slack_user_id ?? null)
  }
  return map
}
