import { NextResponse } from "next/server"
import { runReferralSweep } from "@/lib/sweep-referral"
import { checkResolutions } from "@/lib/sweep-action-tracker"
import { noStoreServerErrorJson, requireCronSecret } from "../../ytd/route-utils"

export const maxDuration = 60

export async function GET(request: Request) {
  // Fail-closed cron auth via the shared helper — an unset/blank CRON_SECRET rejects (this route
  // runs the sweep through the service-role client; an unconfigured deploy must not expose it).
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  try {
    const result = await runReferralSweep({ lookbackHours: 48 })

    // Slack notifications disabled — surface in dashboard only for now
    const resolutions = await checkResolutions("referral")

    return NextResponse.json({
      sweep: {
        applications_scanned: result.run.applications_scanned,
        items_found: result.run.items_found,
        new_alerts: result.newAlerts,
        sla_violations: result.slaViolations,
      },
      resolutions,
      run_id: result.run.id,
    })
  } catch (err) {
    return noStoreServerErrorJson("cron/sweep-referral", err)
  }
}
