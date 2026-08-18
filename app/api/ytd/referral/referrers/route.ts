import { getYtdReferralReferrers } from "@/lib/ytd-referral-dashboard"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireBroadCandidateSurfaceAccess,
} from "../../route-utils"
import { parseReferralFilters, parseReferralSort } from "../route-helpers"

export async function GET(request: Request) {
  try {
    const denied = requireBroadCandidateSurfaceAccess(request)
    if (denied) return denied

    const url = new URL(request.url)
    return noStoreJson(
      await getYtdReferralReferrers(parseReferralFilters(url), parseReferralSort(url, "submissions"))
    )
  } catch (err) {
    return noStoreServerErrorJson("api/ytd/referral/referrers", err)
  }
}
