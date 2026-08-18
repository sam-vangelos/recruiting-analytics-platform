/**
 * One-time current-cycle copied-sheet structural preflight/executor.
 * Dry-run is the default. Copy writes require the explicit CLI acknowledgement
 * in addition to repository flags, the durable kill switch, and fresh permits.
 */
import {
  createGoogleWorkspaceStagingClientsFromAccessToken,
} from "../../lib/recruiting-ops/delivery/google-workspace-staging-client"
import {
  currentCycleStructuralSpecsForArtifacts,
  runCurrentCycleStagingStructuralNormalizations,
  type CurrentCycleStructuralArtifactKey,
} from "../../lib/recruiting-ops/delivery/staging-current-cycle-normalization-runner"

function requestedArtifacts(): CurrentCycleStructuralArtifactKey[] | undefined {
  const value = process.argv.find((argument) => argument.startsWith("--artifacts="))
  if (!value) return undefined
  const keys = value.slice("--artifacts=".length).split(",").map((key) => key.trim()).filter(Boolean)
  const typed = keys as CurrentCycleStructuralArtifactKey[]
  currentCycleStructuralSpecsForArtifacts(typed)
  return typed
}

async function main(): Promise<void> {
  const token = process.env.GCLOUD_ACCESS_TOKEN?.trim()
  if (!token) throw new Error("GCLOUD_ACCESS_TOKEN is required")
  const execute = process.argv.includes("--execute-copy-writes")
  if (process.argv.some((argument) => argument.startsWith("--mode="))) {
    throw new Error("Use --execute-copy-writes for write mode; --mode is not accepted")
  }
  const clients = createGoogleWorkspaceStagingClientsFromAccessToken(token)
  const outcome = await runCurrentCycleStagingStructuralNormalizations({
    clients,
    artifactKeys: requestedArtifacts(),
    mode: execute ? "write" : "dry_run",
  })
  console.log(JSON.stringify(outcome, null, 2))
  if (outcome.outcomes.some((item) => item.status === "blocked")) process.exitCode = 2
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[staging-structure] blocked: ${message.replace(/[\r\n]+/g, " ").slice(0, 500)}`)
  process.exitCode = 1
})
