import { getYtdReferralFilterOptions } from "@/lib/ytd-referral-dashboard"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireBroadCandidateSurfaceAccess,
} from "../../route-utils"
import { parseReferralFilters } from "../route-helpers"

export async function GET(request: Request) {
  try {
    const denied = requireBroadCandidateSurfaceAccess(request)
    if (denied) return denied

    const url = new URL(request.url)
    return noStoreJson(await getYtdReferralFilterOptions(parseReferralFilters(url)))
  } catch (err) {
    return noStoreServerErrorJson("api/ytd/referral/filter-options", err)
  }
}
