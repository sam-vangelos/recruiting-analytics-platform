import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { readEnv } from "@/lib/env"
import { runExecLiveWorkflow } from "@/lib/recruiting-ops/exec-live-workflow"
import { noStoreJson, noStoreServerErrorJson, requireCronSecret } from "../../ytd/route-utils"

// The org-wide exec pull makes ~40-60 Harvest requests (chunked joins over the
// open-job set plus windowed org-wide pulls); live runs finish in 1-3 minutes.
export const maxDuration = 300

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * recruiting-ops-exec — the scheduled trigger for the E01 exec state-of-play.
 *
 * DORMANT BY DEFAULT: without RECOPS_EXEC_ENABLED=true this route answers
 * 200 {status:"disabled"} and touches nothing — no Greenhouse call, no
 * Supabase write. The flag is set nowhere until the operator flips it (the
 * migration-gated-writeback rule applied to a compute lane).
 *
 * When enabled: the E01 live workflow in SHADOW mode — org-wide live Harvest
 * reads, governed dimensions, durable run history, and the exec snapshot that
 * /state-of-play reads. READ-ONLY toward Greenhouse. Response body is
 * public-safe (statuses and counts only).
 */
export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  if (readEnv("RECOPS_EXEC_ENABLED")?.trim() !== "true") {
    return noStoreJson({
      route: "recruiting-ops-exec",
      status: "disabled",
      detail: "RECOPS_EXEC_ENABLED is not 'true'; the exec lane is dormant by design (the flip is the operator's).",
    })
  }

  try {
    const rootDir = join(tmpdir(), "recruiting-ops-artifacts", "exec", new Date().toISOString().replace(/[:.]/g, "-"))
    mkdirSync(rootDir, { recursive: true })
    const outcome = await runExecLiveWorkflow({
      mode: "shadow",
      rootDir,
      log: (message) => console.log(message),
    })
    return noStoreJson({
      route: "recruiting-ops-exec",
      status: "ran",
      mode: outcome.mode,
      startedAt: outcome.startedAt,
      runStatus: outcome.moduleResult.run.status,
      publicSummary: outcome.moduleResult.run.publicSummary,
      governedDimensions: outcome.governedDimensions,
      persistence:
        outcome.persistence === "skipped"
          ? "skipped"
          : outcome.persistence.map((summary) => ({
              workflowId: summary.workflowId,
              outcome: summary.outcome,
              sourceGaps: summary.rowCounts.sourceGaps,
            })),
    })
  } catch (err) {
    return noStoreServerErrorJson("recruiting-ops-exec", err)
  }
}
