import { getYtdDataQuality } from "@/lib/ytd-dashboard"
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
    const data = await getYtdDataQuality(parseYear(url.searchParams.get("year")))
    return noStoreJson(data)
  } catch (err) {
    return noStoreServerErrorJson("api/ytd/data-quality", err)
  }
}
