import { getYtdAgencySummary } from "@/lib/ytd-dashboard"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireBroadCandidateSurfaceAccess,
} from "../../route-utils"
import { parseAgencyFilters } from "../route-helpers"

export async function GET(request: Request) {
  try {
    const denied = requireBroadCandidateSurfaceAccess(request)
    if (denied) return denied

    const url = new URL(request.url)
    return noStoreJson(await getYtdAgencySummary(parseAgencyFilters(url)))
  } catch (err) {
    return noStoreServerErrorJson("api/ytd/agency/summary", err)
  }
}
