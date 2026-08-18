import { timingSafeEqual } from "node:crypto"

import {
  ALL_HYDRATION_ARTIFACTS,
  runStagingHydrationOrchestration,
} from "@/lib/recruiting-ops/delivery/staging-hydration-orchestrator"
import type { HydrationArtifactKey, HydrationRunMode } from "@/lib/recruiting-ops/delivery/hydration-orchestration-store"
import { stagingArtifactRegistry } from "@/lib/recruiting-ops/delivery/staging-artifact-registry"
import { renderHydrationRunAlert } from "@/lib/recruiting-ops/delivery/staging-hydration-alert"
import { resolveScheduledHydrationCycle } from "@/lib/recruiting-ops/delivery/staging-maintenance-cadence"
import { postSlackDm } from "@/lib/notification-delivery"
import { SWEEP_CONFIG } from "@/lib/sweep-config"
import { INTERNAL_SERVER_ERROR_MESSAGE, noStoreJson } from "../../ytd/route-utils"

export const maxDuration = 10800
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SCHEDULED_ARTIFACTS = stagingArtifactRegistry
  .filter((artifact) => artifact.maintenanceLane !== null)
  .map((artifact) => artifact.key) as readonly HydrationArtifactKey[]

export async function POST(request: Request) {
  if (!isAuthorizedJobRequest(request)) {
    return noStoreJson({ error: "Not found" }, { status: 404 })
  }
  try {
    const mode = jobMode(process.env.RECOPS_JOB_MODE)
    const scheduledAt = process.env.RECOPS_SCHEDULED_AT
    const scheduled = scheduledAt !== undefined
    const eligibleArtifacts = jobArtifacts(process.env.RECOPS_JOB_ARTIFACTS, scheduled)
    const cycle = scheduled
      ? resolveScheduledHydrationCycle({ scheduledAt, eligibleArtifacts })
      : null
    if (cycle && cycle.dueArtifacts.length === 0) {
      const result = {
        status: "no_change" as const,
        disposition: "not_due" as const,
        runId: null,
        scheduledAt: cycle.scheduledAt,
        lane: cycle.lane,
        businessDate: cycle.businessDate,
        reportingWeekFriday: cycle.reportingWeekFriday,
        quarterStart: cycle.quarterStart,
        dueArtifacts: [] as const,
        sourceExecutionId: null,
        sourceFingerprint: null,
        completedArtifacts: [] as const,
        failedArtifacts: [] as const,
        replayed: false,
      }
      console.log(`[recruiting-ops-staging-orchestration] ${JSON.stringify(result)}`)
      return noStoreJson(result)
    }
    const artifactKeys = cycle?.dueArtifacts ?? eligibleArtifacts
    const result = await runStagingHydrationOrchestration({
      mode,
      artifactKeys,
      ...(cycle ? { scheduledCycle: cycle } : {}),
    })
    console.log(`[recruiting-ops-staging-orchestration] ${JSON.stringify({
      ...result,
      ...(cycle
        ? {
            scheduledAt: cycle.scheduledAt,
            lane: cycle.lane,
            dueArtifacts: cycle.dueArtifacts,
            dueCount: cycle.dueArtifacts.length,
          }
        : {}),
    })}`)
    await reportRun({
      status: result.status,
      runId: result.runId,
      businessDate: result.businessDate,
      artifactOutcomes: result.artifactOutcomes,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(cycle ? { scheduledAt: cycle.scheduledAt, lane: cycle.lane } : {}),
    })
    return noStoreJson(result)
  } catch {
    console.error("[recruiting-ops-staging-orchestration] Failed; private diagnostics suppressed.")
    // A route-level throw leaves no run summary and no ledger entry to read, so
    // this is the only signal that the cycle happened at all.
    await reportRun({
      status: "failed",
      runId: "unknown",
      businessDate: "unknown",
      artifactOutcomes: [],
    })
    return noStoreJson({ error: INTERNAL_SERVER_ERROR_MESSAGE }, { status: 500 })
  }
}

/**
 * Send is best-effort and deliberately isolated. The job's exit code is the
 * orchestration's own outcome; a Slack outage must not turn a clean run into a
 * failed one, nor a failed run into a retry storm.
 */
async function reportRun(input: Parameters<typeof renderHydrationRunAlert>[0]): Promise<void> {
  try {
    const alert = renderHydrationRunAlert(input)
    await postSlackDm(SWEEP_CONFIG.slack.recruitingOpsAlertUserId, alert.text)
  } catch (alertError) {
    console.error(
      "[recruiting-ops-staging-orchestration] run report could not be delivered:",
      alertError instanceof Error ? alertError.message : String(alertError)
    )
  }
}

function isAuthorizedJobRequest(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  const hostname = new URL(request.url).hostname
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") return false
  const expected = env.RECOPS_JOB_BEARER_TOKEN?.trim()
  const header = request.headers.get("authorization")
  const actual = header?.startsWith("Bearer ") ? header.slice(7) : ""
  if (!expected || !actual) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}

function jobMode(value: string | undefined): HydrationRunMode {
  const mode = value?.trim() || "dry_run"
  if (mode !== "dry_run" && mode !== "write") throw new Error("RECOPS_JOB_MODE is invalid.")
  return mode
}

function jobArtifacts(value: string | undefined, scheduled: boolean): HydrationArtifactKey[] {
  if (!value?.trim()) {
    if (scheduled) throw new Error("Scheduled hydration requires RECOPS_JOB_ARTIFACTS.")
    return [...ALL_HYDRATION_ARTIFACTS]
  }
  const selected = value.split(",").map((artifact) => artifact.trim())
  if (selected.some((artifact) => artifact.length === 0)) {
    throw new Error("RECOPS_JOB_ARTIFACTS contains an empty artifact.")
  }
  const requested = new Set(selected)
  if (requested.size !== selected.length) throw new Error("RECOPS_JOB_ARTIFACTS contains a duplicate.")
  const allowed = scheduled ? SCHEDULED_ARTIFACTS : ALL_HYDRATION_ARTIFACTS
  const artifacts = allowed.filter((artifact) => requested.has(artifact))
  if (artifacts.length !== requested.size) throw new Error("RECOPS_JOB_ARTIFACTS contains an unknown artifact.")
  if (artifacts.length === 0) throw new Error("RECOPS_JOB_ARTIFACTS is empty.")
  return artifacts
}
