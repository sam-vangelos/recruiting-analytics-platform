import { getYtdAgencyFilterOptions } from "@/lib/ytd-dashboard"
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
    return noStoreJson(await getYtdAgencyFilterOptions(parseAgencyFilters(url)))
  } catch (err) {
    return noStoreServerErrorJson("api/ytd/agency/filter-options", err)
  }
}
