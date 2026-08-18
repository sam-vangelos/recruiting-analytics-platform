import { supabase } from "@/lib/supabase"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireCronSecret,
} from "../../ytd/route-utils"

export const runtime = "nodejs"

// Read-only resolution-signal health (P1). CRON_SECRET-gated. Surfaces the metrics that
// (a) verify the backfill drove the false-resolution bug to zero and (b) give the Phase-2
// escalation interlock a trust signal for alert_ledger.resolved_at.
const SENTINEL_STAGES = new Set(["Unknown", "active", "in_process"])

export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  const { data, error } = await supabase
    .from("alert_ledger")
    .select(
      "sweep_type, first_alerted_at, resolved_at, resolution_type, greenhouse_stage_at_alert"
    )
    .range(0, 99999)
  if (error) return noStoreServerErrorJson("api/admin/resolution-health", error)

  const rows = (data ?? []) as Array<{
    sweep_type: string
    first_alerted_at: string | null
    resolved_at: string | null
    resolution_type: string | null
    greenhouse_stage_at_alert: string | null
  }>
  const unresolved = rows.filter((r) => !r.resolved_at)
  const resolved = rows.filter((r) => r.resolved_at)
  const now = new Date().toISOString()
  const nowMs = new Date(now).getTime()

  const oldestUnresolvedAgeHours = unresolved.reduce((max, r) => {
    if (!r.first_alerted_at) return max
    const h = (nowMs - new Date(r.first_alerted_at).getTime()) / 3_600_000
    return Number.isFinite(h) && h > max ? h : max
  }, 0)

  const byType: Record<string, number> = {}
  for (const r of resolved) {
    const k = r.resolution_type ?? "null"
    byType[k] = (byType[k] ?? 0) + 1
  }
  const lastResolutionAt = resolved.reduce(
    (m, r) => (r.resolved_at && r.resolved_at > m ? r.resolved_at : m),
    ""
  )
  // The bug population: rows RESOLVED via stage_change whose ALERT-time stage was a sentinel —
  // these can only be the false-resolutions the corrected classifier refuses. The backfill
  // drives this to 0.
  const misResolvedViaSentinel = resolved.filter(
    (r) =>
      r.resolution_type === "stage_change" &&
      SENTINEL_STAGES.has(r.greenhouse_stage_at_alert ?? "")
  ).length
  // Known-stuck class: unresolved alerts whose alert-time stage is a sentinel can never resolve
  // via stage_change (only via rejection/hire). Escalation should be aware of this population.
  const unresolvedWithSentinelAlertStage = unresolved.filter((r) =>
    SENTINEL_STAGES.has(r.greenhouse_stage_at_alert ?? "")
  ).length

  return noStoreJson({
    checked_at: now,
    total: rows.length,
    unresolved_total: unresolved.length,
    resolved_total: resolved.length,
    oldest_unresolved_age_hours: Math.round(oldestUnresolvedAgeHours * 10) / 10,
    last_resolution_at: lastResolutionAt || null,
    by_resolution_type: byType,
    mis_resolved_via_sentinel_stage: misResolvedViaSentinel,
    unresolved_with_sentinel_alert_stage: unresolvedWithSentinelAlertStage,
  })
}
