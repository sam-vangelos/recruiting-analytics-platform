/**
 * Operator CLI for the live command-center workflow (mode "local").
 *
 * Thin wrapper over lib/recruiting-ops/live-workflow.ts — the same entrypoint
 * the scheduled shadow route runs in mode "shadow". Console output is
 * PUBLIC-SAFE ONLY: statuses, counts, gap/discrepancy tallies, artifact paths.
 * Row-level detail lands in local artifacts under --root for review.
 *
 * Usage (tsx required — node type-stripping can't resolve extensionless imports):
 *   set -a; source ../ta-ops-analytics/.env.local; set +a
 *   npx tsx scripts/recruiting-ops-live-run.ts [--reqs=890,907,...] \
 *     [--max-jobs=40] [--max-records=5000] [--root=.recruiting-ops-artifacts/live] [--no-persist]
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { runLiveCommandCenterWorkflow } from "../lib/recruiting-ops/live-workflow"

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.split("=").slice(1).join("=") : fallback
}

async function main() {
  if (!process.env.GREENHOUSE_CLIENT_ID || !process.env.GREENHOUSE_CLIENT_SECRET) {
    console.error("GREENHOUSE_CLIENT_ID / GREENHOUSE_CLIENT_SECRET are not set — source the env file first.")
    process.exit(1)
  }

  const reqIds = arg("reqs", "").split(",").map((value) => value.trim()).filter(Boolean)
  const rootDir = join(
    process.cwd(),
    arg("root", ".recruiting-ops-artifacts/live"),
    new Date().toISOString().replace(/[:.]/g, "-")
  )
  mkdirSync(rootDir, { recursive: true })

  const outcome = await runLiveCommandCenterWorkflow({
    mode: "local",
    rootDir,
    reqIds,
    maxJobs: Number(arg("max-jobs", "40")),
    maxRecordsPerEndpoint: Number(arg("max-records", "5000")),
    persist: !process.argv.includes("--no-persist"),
    log: (message) => console.log(message),
  })

  console.log("\n=== LIVE RUN — public-safe summary ===")
  console.log(JSON.stringify(outcome.publicSummary, null, 2))
  for (const [workflowId, status] of Object.entries(outcome.moduleStatuses)) {
    console.log(
      `${workflowId}: status=${status.status} rows=${status.rows} sourceGaps=${status.sourceGaps} (blocking=${status.blockingSourceGaps}) discrepancies=${status.discrepancies}`
    )
  }
  console.log(`\nartifacts: ${outcome.artifactCount} file(s) under ${outcome.rootDir}`)
  if (outcome.persistence === "skipped") {
    console.log("[recruiting-ops live-run] --no-persist: run history NOT written to Supabase")
  }
}

main().catch((error) => {
  console.error(`[recruiting-ops live-run] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
