import { getYtdReferralApplications } from "@/lib/ytd-referral-dashboard"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireBroadCandidateSurfaceAccess,
} from "../../route-utils"
import { parseReferralFilters, parseReferralSort, parsePaging } from "../route-helpers"

export async function GET(request: Request) {
  try {
    const denied = requireBroadCandidateSurfaceAccess(request)
    if (denied) return denied

    const url = new URL(request.url)
    return noStoreJson(
      await getYtdReferralApplications(
        { ...parseReferralFilters(url), ...parsePaging(url) },
        parseReferralSort(url, "submitted_at")
      )
    )
  } catch (err) {
    return noStoreServerErrorJson("api/ytd/referral/applications", err)
  }
}
