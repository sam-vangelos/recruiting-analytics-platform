import { getYtdAgencyApplications } from "@/lib/ytd-dashboard"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireBroadCandidateSurfaceAccess,
} from "../../route-utils"
import { parseAgencyFilters, parseAgencySort, parsePaging } from "../route-helpers"

export async function GET(request: Request) {
  try {
    const denied = requireBroadCandidateSurfaceAccess(request)
    if (denied) return denied

    const url = new URL(request.url)
    return noStoreJson(
      await getYtdAgencyApplications(
        { ...parseAgencyFilters(url), ...parsePaging(url) },
        parseAgencySort(url, "submitted_at")
      )
    )
  } catch (err) {
    return noStoreServerErrorJson("api/ytd/agency/applications", err)
  }
}
