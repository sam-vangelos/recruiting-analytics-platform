/**
 * One-time idempotent setup for the two source-authoritative RPS output tabs.
 * Plan is the default; apply requires the exact Drive version from that plan.
 */
import {
  createGoogleWorkspaceRpsAutomatedSurfaceAdapter,
  createGoogleWorkspaceStagingClients,
} from "../../lib/recruiting-ops/delivery/google-workspace-staging-client"
import {
  runRpsAutomatedSurfaceSetup,
} from "../../lib/recruiting-ops/delivery/rps-automated-surfaces"

function argumentValue(prefix: string): string | undefined {
  const matches = process.argv.slice(2).filter((argument) => argument.startsWith(prefix))
  if (matches.length > 1) throw new Error(`Duplicate ${prefix.slice(0, -1)} argument.`)
  return matches[0]?.slice(prefix.length)
}

function assertKnownArguments(): void {
  const unknown = process.argv.slice(2).filter(
    (argument) =>
      argument !== "--apply" &&
      !argument.startsWith("--expected-drive-version=")
  )
  if (unknown.length > 0) {
    throw new Error(`Unknown RPS setup argument: ${unknown[0]}`)
  }
}

async function main(): Promise<void> {
  assertKnownArguments()
  const apply = process.argv.includes("--apply")
  const expectedDriveVersion = argumentValue("--expected-drive-version=")
  if (!apply && expectedDriveVersion !== undefined) {
    throw new Error("--expected-drive-version is accepted only with --apply.")
  }
  const clients = await createGoogleWorkspaceStagingClients()
  const result = await runRpsAutomatedSurfaceSetup({
    adapter: createGoogleWorkspaceRpsAutomatedSurfaceAdapter(clients),
    mode: apply ? "apply" : "plan",
    ...(expectedDriveVersion === undefined ? {} : { expectedDriveVersion }),
  })
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[rps-automated-surfaces] blocked: ${message.replace(/[\r\n]+/g, " ").slice(0, 500)}`)
  process.exitCode = 1
})
