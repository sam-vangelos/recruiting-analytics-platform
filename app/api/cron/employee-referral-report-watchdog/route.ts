import { runEmployeeReferralWatchdog } from "@/lib/recruiting-ops/employee-referral-report-runner"
import {
  INTERNAL_SERVER_ERROR_MESSAGE,
  noStoreJson,
} from "../../ytd/route-utils"
import { requireEmployeeReferralWatchdogSchedulerAuthorization } from "../employee-referral-scheduler-authorization"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

export async function GET(request: Request) {
  const unauthorized =
    await requireEmployeeReferralWatchdogSchedulerAuthorization(request)
  if (unauthorized) return unauthorized

  try {
    const result = await runEmployeeReferralWatchdog()
    return noStoreJson(result, { status: result.status === "healthy" ? 200 : 503 })
  } catch {
    console.error(
      "[cron/employee-referral-report-watchdog] Failed; private diagnostics suppressed."
    )
    return noStoreJson({ error: INTERNAL_SERVER_ERROR_MESSAGE }, { status: 500 })
  }
}
