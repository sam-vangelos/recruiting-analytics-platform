/**
 * Read-only live preflight for the registered copied Google Sheets.
 *
 * This script uses the same durable source-cut/orchestration path as the
 * private Job. It never enables hydration flags or exposes a mutation mode.
 * Output is counts and HMAC fingerprints only; row-level recruiting data
 * stays in the service-role protected source snapshot.
 */
import { runStagingHydrationOrchestration } from "../../lib/recruiting-ops/delivery/staging-hydration-orchestrator"
import type { StagingSheetArtifactKey } from "../../lib/recruiting-ops/delivery/staging-artifact-value-planner"

const ALLOWED_ARTIFACTS = new Set<StagingSheetArtifactKey>([
  "weekly_recruitment",
  "weekly_progress",
  "all_hires",
  "pipeline_890",
  "pipeline_907",
  "pipeline_1026_1027",
  "pipeline_1118_1119",
  "final_offer",
  "rps_tracking",
  "delivery_roles_rps",
])

function requestedArtifacts(): StagingSheetArtifactKey[] | undefined {
  const value = process.argv.find((argument) => argument.startsWith("--artifacts="))
  if (!value) return undefined
  const keys = value.slice("--artifacts=".length).split(",").map((key) => key.trim()).filter(Boolean)
  if (keys.length === 0 || keys.some((key) => !ALLOWED_ARTIFACTS.has(key as StagingSheetArtifactKey))) {
    throw new Error("--artifacts must contain only registered copied sheet keys")
  }
  return keys as StagingSheetArtifactKey[]
}

async function main(): Promise<void> {
  const outcome = await runStagingHydrationOrchestration({
    artifactKeys: requestedArtifacts(),
    mode: "dry_run",
  })
  console.log(JSON.stringify(outcome, null, 2))
  if (outcome.status === "failed" || outcome.status === "partial" || outcome.status === "timed_out") {
    process.exitCode = 2
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[staging-hydration-dry-run] blocked: ${message.replace(/[\r\n]+/g, " ").slice(0, 500)}`)
  process.exitCode = 1
})
