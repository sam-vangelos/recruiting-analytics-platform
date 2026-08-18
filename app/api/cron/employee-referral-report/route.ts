import { syncEmployeeReferralMasterSheet } from "@/lib/recruiting-ops/employee-referral-report-runner"
import {
  INTERNAL_SERVER_ERROR_MESSAGE,
  noStoreJson,
} from "../../ytd/route-utils"
import { requireEmployeeReferralReportSchedulerAuthorization } from "../employee-referral-scheduler-authorization"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 900

export async function GET(request: Request) {
  const unauthorized =
    await requireEmployeeReferralReportSchedulerAuthorization(request)
  if (unauthorized) return unauthorized

  try {
    const result = await syncEmployeeReferralMasterSheet()
    return noStoreJson(
      {
        status: result.status,
        correlation_id: result.correlationId,
        period_start_local: result.periodStartLocal,
        period_end_local_exclusive: result.periodEndLocalExclusive,
        counts: result.counts,
        updated_tabs: result.updatedTabs,
        current_cohort_row_count: result.currentCohortRowCount,
      }
    )
  } catch {
    console.error("[cron/employee-referral-report] Failed; private diagnostics suppressed.")
    return noStoreJson({ error: INTERNAL_SERVER_ERROR_MESSAGE }, { status: 500 })
  }
}
