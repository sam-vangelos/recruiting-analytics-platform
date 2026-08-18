import { runYtdSync } from "@/lib/ytd-extract"
import {
  noStoreJson,
  noStoreServerErrorJson,
  parseSyncBody,
  requireCronSecret,
} from "../route-utils"

export const maxDuration = 300

export async function POST(request: Request) {
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  try {
    const body = await parseSyncBody(request)
    const result = await runYtdSync({
      year: body.year,
      channel: body.channel,
      dryRun: body.dry_run,
      runType: "incremental",
    })
    return noStoreJson(result)
  } catch (err) {
    return noStoreServerErrorJson("api/ytd/incremental", err)
  }
}
