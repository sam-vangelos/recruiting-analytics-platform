import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { readEnv } from "@/lib/env"
import { runLiveCommandCenterWorkflow } from "@/lib/recruiting-ops/live-workflow"
import { noStoreJson, noStoreServerErrorJson, requireCronSecret } from "../../ytd/route-utils"

// The six-module workflow makes ~150-200 Harvest requests plus chunked joins;
// live runs finish in 2-4 minutes. Cloud Run's request timeout governs there;
// this bound applies wherever a platform honors it.
export const maxDuration = 300

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * recruiting-ops-shadow — the control plane's scheduled trigger (C3).
 *
 * DORMANT BY DEFAULT: without RECOPS_SHADOW_ENABLED=true this route answers
 * 200 {status:"disabled"} and touches nothing — no Greenhouse call, no
 * Supabase write. Flipping the env is gate G2 (the operator). The route exists on every
 * substrate the app deploys to (Cloud Run, and Vercel's frozen deployment if
 * ever redeployed); the flag is set nowhere until G2, so it stays dark
 * everywhere — the migration-gated-writeback rule applied to a compute lane.
 *
 * When enabled: the shared live workflow in SHADOW mode — live Harvest reads,
 * governed dimensions, durable run history. READ-ONLY toward Greenhouse; its
 * only writes are the plane's own run-history tables. Never sends anything.
 * Response body is public-safe (statuses and counts only).
 */
export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  if (readEnv("RECOPS_SHADOW_ENABLED")?.trim() !== "true") {
    return noStoreJson({
      route: "recruiting-ops-shadow",
      status: "disabled",
      detail: "RECOPS_SHADOW_ENABLED is not 'true'; the shadow lane is dormant by design (G2 is the operator's flip).",
    })
  }

  try {
    const rootDir = join(tmpdir(), "recruiting-ops-artifacts", "shadow", new Date().toISOString().replace(/[:.]/g, "-"))
    mkdirSync(rootDir, { recursive: true })
    const outcome = await runLiveCommandCenterWorkflow({
      mode: "shadow",
      rootDir,
      log: (message) => console.log(message),
    })
    return noStoreJson({
      route: "recruiting-ops-shadow",
      status: "ran",
      mode: outcome.mode,
      startedAt: outcome.startedAt,
      publicSummary: outcome.publicSummary,
      moduleStatuses: outcome.moduleStatuses,
      governedDimensions: outcome.governedDimensions,
      persistence:
        outcome.persistence === "skipped"
          ? "skipped"
          : outcome.persistence.map((summary) => ({
              workflowId: summary.workflowId,
              outcome: summary.outcome,
              sourceGaps: summary.rowCounts.sourceGaps,
              discrepancies: summary.rowCounts.discrepancies,
            })),
    })
  } catch (err) {
    return noStoreServerErrorJson("recruiting-ops-shadow", err)
  }
}
