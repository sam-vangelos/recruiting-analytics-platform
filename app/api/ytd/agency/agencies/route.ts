import { getYtdAgencyAgencies } from "@/lib/ytd-dashboard"
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
      await getYtdAgencyAgencies(parseAgencyFilters(url), parseAgencySort(url, "submissions"))
    )
  } catch (err) {
    return noStoreServerErrorJson("api/ytd/agency/agencies", err)
  }
}
