/**
 * Operator CLI for the E01 exec state-of-play workflow (mode "local").
 *
 * Thin wrapper over lib/recruiting-ops/exec-live-workflow.ts. Console output is
 * PUBLIC-SAFE ONLY: statuses, counts, gap tallies, artifact paths. Row-level
 * detail lands in the run artifacts under --root and in the durable snapshot
 * (recruiting_ops_exec_snapshot) that /state-of-play reads.
 *
 * Usage (tsx required):
 *   set -a; source ../ta-ops-analytics/.env.local; set +a
 *   npx tsx scripts/recruiting-ops-exec-run.ts \
 *     [--max-records=200000] [--root=.recruiting-ops-artifacts/live] [--no-persist]
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { runExecLiveWorkflow } from "../lib/recruiting-ops/exec-live-workflow"

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.split("=").slice(1).join("=") : fallback
}

async function main() {
  if (!process.env.GREENHOUSE_CLIENT_ID || !process.env.GREENHOUSE_CLIENT_SECRET) {
    console.error("GREENHOUSE_CLIENT_ID / GREENHOUSE_CLIENT_SECRET are not set — source the env file first.")
    process.exit(1)
  }

  const rootDir = join(process.cwd(), arg("root", ".recruiting-ops-artifacts/live"))
  mkdirSync(rootDir, { recursive: true })

  const outcome = await runExecLiveWorkflow({
    mode: "local",
    rootDir,
    maxRecordsPerEndpoint: Number(arg("max-records", "200000")),
    persist: !process.argv.includes("--no-persist"),
    log: (message) => console.log(message),
  })

  const { moduleResult } = outcome
  // ELT facts artifact next to the run's other artifacts — the input for
  // scripts/build-elt-update.py <elt-data.json> <out.docx> <out.html>.
  const artifactDir = moduleResult.artifacts[0] ? dirname(moduleResult.artifacts[0].path) : rootDir
  const eltPath = join(artifactDir, "elt-data.json")
  writeFileSync(eltPath, JSON.stringify(moduleResult.execState.eltFacts, null, 2))

  console.log("\n[exec-run] PUBLIC-SAFE SUMMARY")
  console.log(`  status=${moduleResult.run.status} rows=${moduleResult.normalizedRows.length}`)
  console.log(`  publicSummary=${JSON.stringify(moduleResult.run.publicSummary)}`)
  console.log(
    `  gaps=${moduleResult.sourceGaps.length} (blocking=${moduleResult.sourceGaps.filter((gap) => gap.blocksCutover).length})`
  )
  console.log(`  artifacts=${moduleResult.artifacts.map((artifact) => artifact.path).join(", ")}`)
  console.log(`  elt-data=${eltPath} (week ${moduleResult.execState.eltFacts.weekShort})`)
  console.log(`  persistence=${outcome.persistence === "skipped" ? "skipped" : "durable run store + snapshot"}`)
  if (moduleResult.run.status !== "succeeded") {
    console.error("[exec-run] run did not succeed — snapshot NOT written; inspect blocking gaps above")
    process.exitCode = 2
  }
}

main().catch((error) => {
  console.error(`[exec-run] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
