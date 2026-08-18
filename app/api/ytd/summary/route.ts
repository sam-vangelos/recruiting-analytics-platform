import { getYtdSummary } from "@/lib/ytd-dashboard"
import {
  noStoreJson,
  noStoreServerErrorJson,
  parseYear,
  requireBroadCandidateSurfaceAccess,
} from "../route-utils"

export async function GET(request: Request) {
  try {
    const denied = requireBroadCandidateSurfaceAccess(request)
    if (denied) return denied

    const url = new URL(request.url)
    const summary = await getYtdSummary(parseYear(url.searchParams.get("year")))
    return noStoreJson(summary)
  } catch (err) {
    return noStoreServerErrorJson("api/ytd/summary", err)
  }
}
