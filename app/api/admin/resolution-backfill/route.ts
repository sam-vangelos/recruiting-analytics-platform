import { supabase } from "@/lib/supabase"
import { greenhouseGetAll } from "@/lib/greenhouse-client"
import { classifyResolution } from "@/lib/sweep-action-tracker"
import type { GHApplication } from "@/lib/sweep-types"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireCronSecret,
} from "../../ytd/route-utils"

export const runtime = "nodejs"
export const maxDuration = 120

// One-shot corrective backfill for the P1 false-resolution bug (CRON_SECRET-gated).
// DRY-RUN BY DEFAULT — writes only on ?apply=true. Must run against the DEPLOYED app (prod
// Greenhouse creds; local creds are broken, which would reopen-without-re-verifying).
//
// The mis-resolved set: rows RESOLVED via stage_change whose ALERT-time stage was a sentinel
// (Unknown/active/in_process). For each, re-fetch the application and re-run the CORRECTED
// classifyResolution: if it still resolves (the candidate has since been rejected/hired, or —
// not possible for a sentinel alert-stage — genuinely moved), KEEP it resolved with the correct
// verdict; otherwise REOPEN it (clear the resolution fields) so it rejoins the unresolved set
// and is re-evaluated honestly going forward. An application we cannot re-fetch is left as-is
// (conservative — never reopen blind).
const SENTINEL_STAGES = ["Unknown", "active", "in_process"]

export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized
  const apply = new URL(request.url).searchParams.get("apply") === "true"

  const { data, error } = await supabase
    .from("alert_ledger")
    .select("id, application_id, sweep_type, greenhouse_stage_at_alert, resolution_type")
    .not("resolved_at", "is", null)
    .eq("resolution_type", "stage_change")
    .in("greenhouse_stage_at_alert", SENTINEL_STAGES)
  if (error) return noStoreServerErrorJson("api/admin/resolution-backfill", error)

  const candidates = (data ?? []) as Array<{
    id: string
    application_id: number
    greenhouse_stage_at_alert: string | null
  }>
  if (candidates.length === 0) {
    return noStoreJson({
      apply,
      candidates: 0,
      note: "no mis-resolved sentinel-stage rows — nothing to backfill",
    })
  }

  // Re-fetch each application from Greenhouse (batched <=50).
  const appIds = [...new Set(candidates.map((c) => c.application_id))]
  const currentApps = new Map<number, GHApplication>()
  for (let i = 0; i < appIds.length; i += 50) {
    const apps = await greenhouseGetAll<GHApplication>("/applications", {
      ids: appIds.slice(i, i + 50).join(","),
    })
    for (const a of apps) currentApps.set(a.id, a)
  }

  const toReopen: string[] = []
  const toKeep: Array<{ id: string; verdict: ReturnType<typeof classifyResolution> }> = []
  const unfetched: string[] = []
  for (const c of candidates) {
    const app = currentApps.get(c.application_id)
    if (!app) {
      unfetched.push(c.id)
      continue
    }
    const verdict = classifyResolution(
      { greenhouse_stage_at_alert: c.greenhouse_stage_at_alert },
      app
    )
    if (verdict) toKeep.push({ id: c.id, verdict })
    else toReopen.push(c.id)
  }

  let reopened = 0
  let keptResolved = 0
  if (apply) {
    for (const id of toReopen) {
      const { error: e } = await supabase
        .from("alert_ledger")
        .update({
          resolved_at: null,
          resolution_type: null,
          resolution_detail: null,
          greenhouse_stage_at_resolution: null,
        })
        .eq("id", id)
      if (e) return noStoreServerErrorJson("api/admin/resolution-backfill", e)
      reopened++
    }
    for (const k of toKeep) {
      if (!k.verdict) continue
      const { error: e } = await supabase
        .from("alert_ledger")
        .update({
          resolution_type: k.verdict.resolution_type,
          resolution_detail: k.verdict.resolution_detail,
          greenhouse_stage_at_resolution: k.verdict.greenhouse_stage_at_resolution,
        })
        .eq("id", k.id)
      if (e) return noStoreServerErrorJson("api/admin/resolution-backfill", e)
      keptResolved++
    }
  }

  return noStoreJson({
    apply,
    candidates: candidates.length,
    would_reopen: toReopen.length,
    would_keep_resolved: toKeep.length,
    unfetched: unfetched.length,
    reopened: apply ? reopened : 0,
    kept_resolved: apply ? keptResolved : 0,
  })
}
