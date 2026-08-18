import { getYtdAgencyRecruiters } from "@/lib/ytd-dashboard"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireBroadCandidateSurfaceAccess,
} from "../../route-utils"
import { parseAgencyFilters, parseAgencySort } from "../route-helpers"

export async function GET(request: Request) {
  try {
    const denied = requireBroadCandidateSurfaceAccess(request)
    if (denied) return denied

    const url = new URL(request.url)
    return noStoreJson(
      await getYtdAgencyRecruiters(parseAgencyFilters(url), parseAgencySort(url, "p75_action_hours"))
    )
  } catch (err) {
    return noStoreServerErrorJson("api/ytd/agency/recruiters", err)
  }
}
