import { createGoogleWorkspaceStagingClients } from "@/lib/recruiting-ops/delivery/google-workspace-staging-client"
import {
  ALL_HYDRATION_ARTIFACTS,
  runStagingHydrationOrchestration,
} from "@/lib/recruiting-ops/delivery/staging-hydration-orchestrator"
import type { HydrationArtifactKey } from "@/lib/recruiting-ops/delivery/hydration-orchestration-store"
import { stagingArtifactRegistry } from "@/lib/recruiting-ops/delivery/staging-artifact-registry"
import { resolveScheduledHydrationCycle } from "@/lib/recruiting-ops/delivery/staging-maintenance-cadence"
import { runWeeklyRecruitmentStagingRollover } from "@/lib/recruiting-ops/delivery/weekly-recruitment-rollover-runner"
import { weeklyRecruitmentCycle } from "@/lib/recruiting-ops/delivery/weekly-recruitment-rollover"
import { GoogleAuth } from "google-auth-library"
import { INTERNAL_SERVER_ERROR_MESSAGE, noStoreJson } from "../../ytd/route-utils"
import {
  requirePrivateHydratorAuthorization,
  requireSchedulerHydratorAuthorization,
  schedulerJobNameMatches,
} from "./authorization"

export const maxDuration = 900
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SCHEDULED_ARTIFACTS = stagingArtifactRegistry
  .filter((artifact) => artifact.maintenanceLane !== null)
  .map((artifact) => artifact.key) as readonly HydrationArtifactKey[]
const SHEET_ARTIFACTS = new Set<HydrationArtifactKey>(
  stagingArtifactRegistry
    .filter((artifact) => artifact.kind === "google_sheet")
    .map((artifact) => artifact.key)
)
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
const cloudRunAuth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] })

const STAGING_HYDRATION_JOB_RESOURCE_ENV =
  "RECOPS_STAGING_HYDRATION_JOB_RESOURCE"
const STAGING_ORCHESTRATION_SCHEDULER_JOB_NAME_ENV =
  "RECOPS_STAGING_ORCHESTRATION_SCHEDULER_JOB_NAME"
const RECRUITING_OPS_STAGING_HYDRATION_JOB_RESOURCE =
  "projects/example-project/locations/us-central1/jobs/ta-ops-staging-hydration"
const RECRUITING_OPS_STAGING_ORCHESTRATION_SCHEDULER_JOB_NAME =
  "projects/example-project/locations/us-central1/jobs/recops-staging-orchestration-weekday"
const SCHEDULER_LAUNCH_WINDOW_MS = 2 * 60 * 1000
// Caller-minted 128-bit opaque token: fixed grammar keeps correlation evidence
// free of names, arbitrary text, and log-control characters.
const ACCEPTANCE_RUN_ID_LENGTH = 36
const ACCEPTANCE_RUN_ID_PATTERN = /^acc_[0-9a-f]{32}$/

export async function GET(request: Request) {
  const unauthorized = await requirePrivateHydratorAuthorization(request)
  if (unauthorized) return unauthorized
  const url = new URL(request.url)
  const requestedMode = url.searchParams.get("mode") ?? "dry_run"
  if (
    requestedMode !== "dry_run" &&
    requestedMode !== "write" &&
    requestedMode !== "acceptance" &&
    requestedMode !== "rollover_dry_run" &&
    requestedMode !== "rollover_write"
  ) {
    return noStoreJson({ error: "Unsupported staging hydration mode" }, { status: 400 })
  }
  const mode = requestedMode
  const artifact = url.searchParams.get("artifact")
  const reportingWeekValues = url.searchParams.getAll("reporting_week_friday")
  const reportingWeekFriday = reportingWeekValues.length === 1
    ? reportingWeekValues[0]
    : undefined
  if (
    artifact &&
    artifact !== "all" &&
    artifact !== "elt_doc" &&
    !SHEET_ARTIFACTS.has(artifact as HydrationArtifactKey)
  ) {
    return noStoreJson({ error: "Unsupported staging artifact" }, { status: 400 })
  }
  if (mode === "write" && (!artifact || artifact === "all")) {
    return noStoreJson(
      { error: "Staging writes require one explicitly registered copied artifact" },
      { status: 400 }
    )
  }
  if (mode === "acceptance" && (!artifact || artifact === "all" || artifact === "elt_doc")) {
    return noStoreJson(
      { error: "Copy acceptance requires one explicitly registered Sheet artifact" },
      { status: 400 }
    )
  }
  if (reportingWeekValues.length > 1 || (reportingWeekFriday && !isValidReportingWeekFriday(reportingWeekFriday))) {
    return noStoreJson(
      { error: "Reporting week must be one valid ISO Friday" },
      { status: 400 }
    )
  }
  if (reportingWeekFriday && artifact !== "weekly_recruitment") {
    return noStoreJson(
      { error: "A reporting-week override is restricted to Weekly Recruitment" },
      { status: 400 }
    )
  }
  const rolloverRequest = mode === "rollover_dry_run" || mode === "rollover_write"
  if (rolloverRequest && (artifact !== "weekly_recruitment" || !reportingWeekFriday)) {
    return noStoreJson(
      { error: "Weekly Recruitment rollover requires one explicit reporting week" },
      { status: 400 }
    )
  }
  if (!rolloverRequest && reportingWeekFriday) {
    return noStoreJson(
      { error: "Pinned reporting weeks are retired; the durable source cut selects the current period" },
      { status: 400 }
    )
  }
  const acceptanceRunIds = url.searchParams.getAll("acceptance_run_id")
  const acceptanceRunId = acceptanceRunIds.length === 1 ? acceptanceRunIds[0] : undefined
  if (mode === "acceptance" && !isAcceptanceRunId(acceptanceRunId)) {
    return noStoreJson(
      { error: "Copy acceptance requires one valid opaque acceptance_run_id" },
      { status: 400 }
    )
  }
  if (mode === "rollover_write") {
    return noStoreJson({
      route: "recruiting-ops-staging-hydration",
      routeMode: mode,
      error: "Direct rollover writes are retired; use the durable orchestration",
    }, { status: 410 })
  }

  try {
    if (mode === "rollover_dry_run") {
      const clients = await createGoogleWorkspaceStagingClients()
      const outcome = await runWeeklyRecruitmentStagingRollover({
        clients,
        reportingWeekFriday: reportingWeekFriday as string,
        mode: "dry_run",
      })
      console.log(`[recruiting-ops-staging-rollover] ${JSON.stringify(outcome)}`)
      return noStoreJson({
        route: "recruiting-ops-staging-hydration",
        routeMode: mode,
        comparisonMode: "fresh_period_operational",
        provisionalWeekToDate: true,
        ...outcome,
      })
    }
    if (mode === "acceptance") {
      return noStoreJson({
        route: "recruiting-ops-staging-hydration",
        mode,
        acceptance_run_id: acceptanceRunId,
        error: "Direct live acceptance is retired; use the durable orchestration evidence",
      }, { status: 410 })
    }

    const artifactKeys: readonly HydrationArtifactKey[] = !artifact || artifact === "all"
      ? ALL_HYDRATION_ARTIFACTS
      : [artifact as HydrationArtifactKey]
    const outcome = await runStagingHydrationOrchestration({
      artifactKeys,
      mode: mode === "write" ? "write" : "dry_run",
    })
    console.log(`[recruiting-ops-staging-orchestration] ${JSON.stringify(outcome)}`)
    return noStoreJson({ route: "recruiting-ops-staging-hydration", ...outcome })
  } catch {
    // Google/Greenhouse client errors can carry request configuration or
    // row-level context. Keep deployed logs and the HTTP response PII/secret
    // free; detailed source diagnostics are emitted separately as counts.
    console.error("[recruiting-ops-staging-hydration] Failed; private diagnostics suppressed.")
    return noStoreJson({ error: INTERNAL_SERVER_ERROR_MESSAGE }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const unauthorized = await requireSchedulerHydratorAuthorization(request)
  if (unauthorized) return unauthorized

  const jobResource = process.env[STAGING_HYDRATION_JOB_RESOURCE_ENV]?.trim()
  const schedulerJobName = process.env[STAGING_ORCHESTRATION_SCHEDULER_JOB_NAME_ENV]?.trim()
  if (
    jobResource !== RECRUITING_OPS_STAGING_HYDRATION_JOB_RESOURCE ||
    schedulerJobName !== RECRUITING_OPS_STAGING_ORCHESTRATION_SCHEDULER_JOB_NAME
  ) {
    console.error("[recruiting-ops-staging-hydration-launch] Invalid fixed service configuration.")
    return noStoreJson({ error: INTERNAL_SERVER_ERROR_MESSAGE }, { status: 500 })
  }

  if (
    request.headers.get("x-cloudscheduler") !== "true" ||
    !schedulerJobNameMatches(request.headers.get("x-cloudscheduler-jobname"), schedulerJobName) ||
    new URL(request.url).search !== ""
  ) {
    // This branch rejected the only scheduled fire this route ever received
    // (2026-07-21T06:30Z), because Cloud Scheduler sends the short job id and
    // this compared it against the full resource path. Say what was refused so
    // the next mismatch is one log line rather than an archaeology exercise.
    console.warn("[recruiting-ops-staging-hydration-launch] refused Scheduler request:", JSON.stringify({
      cloudscheduler: request.headers.get("x-cloudscheduler"),
      jobname: request.headers.get("x-cloudscheduler-jobname")?.replace(/[\r\n]+/g, " ").slice(0, 200) ?? null,
      hasQuery: new URL(request.url).search !== "",
    }))
    return noStoreJson({ error: "Invalid Scheduler request" }, { status: 400 })
  }

  let body: string
  try {
    body = await request.text()
  } catch {
    return noStoreJson({ error: "Invalid Scheduler request" }, { status: 400 })
  }
  if (body !== "") {
    return noStoreJson({ error: "Invalid Scheduler request" }, { status: 400 })
  }

  let scheduledAt: string
  try {
    scheduledAt = resolveScheduledHydrationCycle({
      scheduledAt: request.headers.get("x-cloudscheduler-scheduletime") ?? "",
      eligibleArtifacts: SCHEDULED_ARTIFACTS,
    }).scheduledAt
  } catch {
    return noStoreJson({ error: "Invalid Scheduler request" }, { status: 400 })
  }
  const launchDelayMs = Date.now() - Date.parse(scheduledAt)
  if (launchDelayMs < 0 || launchDelayMs >= SCHEDULER_LAUNCH_WINDOW_MS) {
    return noStoreJson({ error: "Invalid Scheduler request" }, { status: 400 })
  }

  try {
    await cloudRunAuth.request({
      url: `https://run.googleapis.com/v2/${jobResource}:run`,
      method: "POST",
      data: {
        overrides: {
          containerOverrides: [{
            env: [{ name: "RECOPS_SCHEDULED_AT", value: scheduledAt }],
          }],
        },
      },
    })
    return noStoreJson({ status: "accepted" }, { status: 202 })
  } catch {
    console.error("[recruiting-ops-staging-hydration-launch] Failed; private diagnostics suppressed.")
    return noStoreJson({ error: INTERNAL_SERVER_ERROR_MESSAGE }, { status: 500 })
  }
}

function isValidReportingWeekFriday(value: string): boolean {
  try {
    weeklyRecruitmentCycle(value)
    return true
  } catch {
    return false
  }
}

function isAcceptanceRunId(value: string | undefined): value is string {
  return (
    value?.length === ACCEPTANCE_RUN_ID_LENGTH &&
    ACCEPTANCE_RUN_ID_PATTERN.test(value)
  )
}
