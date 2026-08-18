import { getSupabase } from "@/lib/supabase"
import { renderHydrationSlotAlert } from "@/lib/recruiting-ops/delivery/staging-hydration-alert"
import {
  RECRUITING_OPS_HYDRATION_WATCHDOG_SCHEDULER_JOB_NAME,
  runStagingHydrationWatchdog,
} from "@/lib/recruiting-ops/delivery/staging-hydration-watchdog"
import { postSlackDm } from "@/lib/notification-delivery"
import { SWEEP_CONFIG } from "@/lib/sweep-config"
import { INTERNAL_SERVER_ERROR_MESSAGE, noStoreJson } from "../../ytd/route-utils"
import {
  requirePrivateHydratorAuthorization,
  schedulerJobNameMatches,
} from "../recruiting-ops-staging-hydration/authorization"

export const maxDuration = 60
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The only check that can see a cycle which never started. Everything else in
 * this system is written BY a run, so a scheduler that never fired or a launch
 * that failed produces no evidence at all — just reports quietly going stale.
 */
export async function GET(request: Request) {
  const unauthorized = await requirePrivateHydratorAuthorization(request)
  if (unauthorized) return unauthorized
  // Scheduler calls must come from this watchdog's own job. An operator asking
  // the same question by hand carries no scheduler headers and is welcome to —
  // "did Thursday run?" is exactly the question this answers, and the check is
  // read-only.
  const schedulerJobName = request.headers.get("x-cloudscheduler-jobname")
  if (
    schedulerJobName !== null
    && !schedulerJobNameMatches(
      schedulerJobName,
      RECRUITING_OPS_HYDRATION_WATCHDOG_SCHEDULER_JOB_NAME
    )
  ) {
    // Name the value that was refused. An unexplained 400 here is what let the
    // orchestration launcher sit broken from 2026-07-21 until it was found by
    // reading Scheduler's own logs. A job id is not a secret.
    console.warn(
      "[recruiting-ops-staging-hydration-watchdog] refused scheduler job name:",
      schedulerJobName.replace(/[\r\n]+/g, " ").slice(0, 200)
    )
    return noStoreJson({ error: "Invalid Scheduler request" }, { status: 400 })
  }

  try {
    const result = await runStagingHydrationWatchdog({
      claimedDedupeKeys: readClaimedDedupeKeys,
      nowMs: Date.now,
    })
    console.log(`[recruiting-ops-staging-hydration-watchdog] ${JSON.stringify(result)}`)

    if (result.missingSlots.length > 0) {
      try {
        const alert = renderHydrationSlotAlert({ missingSlots: result.missingSlots })
        await postSlackDm(SWEEP_CONFIG.slack.recruitingOpsAlertUserId, alert.text)
      } catch (alertError) {
        console.error(
          "[recruiting-ops-staging-hydration-watchdog] missing-run alert could not be delivered:",
          alertError instanceof Error ? alertError.message : String(alertError)
        )
      }
    }

    // 503 on a missing run so the Scheduler's own failure count is a second,
    // transport-independent record that a cycle went missing.
    return noStoreJson(result, { status: result.status === "healthy" ? 200 : 503 })
  } catch {
    console.error(
      "[recruiting-ops-staging-hydration-watchdog] Failed; private diagnostics suppressed."
    )
    return noStoreJson({ error: INTERNAL_SERVER_ERROR_MESSAGE }, { status: 500 })
  }
}

/** Read-only: which of these scheduled cycles have a run row, in any state. */
async function readClaimedDedupeKeys(
  keys: readonly string[]
): Promise<ReadonlySet<string>> {
  const { data, error } = await getSupabase()
    .from("recruiting_ops_hydration_runs")
    .select("dedupe_key")
    .in("dedupe_key", [...keys])
  if (error) throw new Error(`hydration watchdog run read failed: ${error.message}`)
  return new Set((data ?? []).map((row) => String(row.dedupe_key)))
}
