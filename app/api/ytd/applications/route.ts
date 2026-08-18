import { getYtdApplications } from "@/lib/ytd-dashboard"
import {
  noStoreJson,
  noStoreServerErrorJson,
  parseBoolean,
  parseYear,
  requireBroadCandidateSurfaceAccess,
} from "../route-utils"
import type { YtdChannel } from "@/lib/ytd-types"

function numberParam(value: string | null): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function channelParam(value: string | null): YtdChannel | undefined {
  return value === "referral" || value === "agency" ? value : undefined
}

export async function GET(request: Request) {
  try {
    const denied = requireBroadCandidateSurfaceAccess(request)
    if (denied) return denied

    const url = new URL(request.url)
    const page = numberParam(url.searchParams.get("page"))
    const pageSize = numberParam(url.searchParams.get("page_size"))
    const applications = await getYtdApplications({
      year: parseYear(url.searchParams.get("year")),
      channel: channelParam(url.searchParams.get("channel")),
      job_id: numberParam(url.searchParams.get("job_id")),
      agency_source_id: numberParam(url.searchParams.get("agency_source_id")),
      recruiter_id: numberParam(url.searchParams.get("recruiter_id")),
      current_stage_name: url.searchParams.get("current_stage_name") ?? undefined,
      never_actioned: parseBoolean(url.searchParams.get("never_actioned")),
      conflict_detected: parseBoolean(url.searchParams.get("conflict_detected")),
      page,
      page_size: pageSize,
    })
    return noStoreJson(applications)
  } catch (err) {
    return noStoreServerErrorJson("api/ytd/applications", err)
  }
}
