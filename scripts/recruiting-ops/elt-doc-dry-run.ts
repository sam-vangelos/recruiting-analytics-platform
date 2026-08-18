/**
 * Offline P1 ELT document dry-run.
 *
 * Reads an E01 snapshot export and a read-only Google Docs JSON export, then
 * emits only the PUBLIC-SAFE summary. It contains no Google client and no
 * mutation method. The private rendered block remains in memory and is never
 * printed or written.
 *
 * Usage (tsx runner required, matching the repository's existing TS CLIs):
 *   npx tsx scripts/recruiting-ops/elt-doc-dry-run.ts \
 *     --snapshot=/secure/path/e01-snapshot.json \
 *     --document=/secure/path/elt-doc-read.json \
 *     [--now=2026-07-11T03:00:00.000Z] \
 *     [--out=/secure/path/public-summary.json]
 *
 * Synthetic fixture data additionally requires --allow-fixture. That switch
 * is rejected unless snapshot.mode is exactly "fixture".
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  runEltDocDryRun,
  type GoogleDocsDocumentSnapshot,
} from "../../lib/recruiting-ops/delivery/elt-doc-dry-run"
import { P1_ELT_DOC_TARGET } from "../../lib/recruiting-ops/delivery/p1-artifacts"
import type { ExecSnapshotRow } from "../../lib/recruiting-ops/exec-snapshot-store"

function arg(name: string): string | undefined {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`))
  return hit?.split("=").slice(1).join("=")
}

function requiredArg(name: string): string {
  const value = arg(name)?.trim()
  if (!value) throw new Error(`missing --${name}`)
  return value
}

async function main(): Promise<void> {
  const snapshotPath = resolve(requiredArg("snapshot"))
  const documentPath = resolve(requiredArg("document"))
  const outputPath = arg("out")?.trim()
  const allowFixture = process.argv.includes("--allow-fixture")
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as ExecSnapshotRow

  if (allowFixture && snapshot.mode !== "fixture") {
    throw new Error("fixture provenance requested for a non-fixture snapshot")
  }

  const result = await runEltDocDryRun(
    {
      snapshot,
      evaluatedAt: arg("now")?.trim() || new Date().toISOString(),
      allowedSnapshotModes: allowFixture ? ["fixture"] : ["shadow"],
      dataProvenance: allowFixture ? "fixture" : "live",
      liveFlagValue: process.env[P1_ELT_DOC_TARGET.liveFlag],
      targetDocumentId: P1_ELT_DOC_TARGET.stagingDocumentId,
    },
    {
      async getDocument() {
        return JSON.parse(readFileSync(documentPath, "utf8")) as GoogleDocsDocumentSnapshot
      },
    }
  )

  const output = `${JSON.stringify(result.publicSummary, null, 2)}\n`
  if (outputPath) writeFileSync(resolve(outputPath), output, { encoding: "utf8", mode: 0o600 })
  process.stdout.write(output)
  if (result.publicSummary.status === "blocked") process.exitCode = 2
}

main().catch(() => {
  // Never echo an exception that may contain a source path or private payload.
  console.error("[elt-doc-dry-run] failed before a public-safe result was available")
  process.exitCode = 1
})
