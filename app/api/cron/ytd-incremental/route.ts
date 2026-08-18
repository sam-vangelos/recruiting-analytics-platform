import { runYtdSync } from "@/lib/ytd-extract"
import {
  noStoreJson,
  noStoreServerErrorJson,
  parseYear,
  requireCronSecret,
} from "../../ytd/route-utils"

export const maxDuration = 300

export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  try {
    const url = new URL(request.url)
    const result = await runYtdSync({
      year: parseYear(url.searchParams.get("year")),
      channel: "all",
      dryRun: false,
      runType: "incremental",
    })
    return noStoreJson(result)
  } catch (err) {
    return noStoreServerErrorJson("cron/ytd-incremental", err)
  }
}
