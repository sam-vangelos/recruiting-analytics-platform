import {
  createGreenhouseHarvestReadBoundary,
  type HarvestJobRecord,
} from "./extractors/greenhouse-harvest-read-adapter"
import { createLiveGreenhouseHarvestReadClient } from "./extractors/greenhouse-live-read-client"
import { loadGovernedRoster, loadInterviewStageTaxonomy } from "./governed-dimensions-client"
import { persistWorkflowRuns, type PersistedModuleRunSummary } from "./run-store"
import { createSupabaseRunStoreClient } from "./supabase-run-store-client"
import { runLocalCommandCenterWorkflow } from "./workflow-runner"

/**
 * The one live-workflow entrypoint (C0 runner extraction, folded into C3): the
 * bounded scoping + governed-dimension load + six-module run + durable persist
 * that both the operator CLI (scripts/recruiting-ops-live-run.ts) and the
 * scheduled shadow route share. Output is PUBLIC-SAFE ONLY — statuses, counts,
 * artifact paths; never row content.
 */

export const DEFAULT_FOCUS_REQ_IDS = ["890", "907", "1026", "1027", "1118", "1119"] as const

export interface RunLiveWorkflowOptions {
  /** Honest run mode: "local" for operator CLI runs, "shadow" for the scheduled lane. */
  mode: "local" | "shadow"
  rootDir: string
  reqIds?: readonly string[]
  maxJobs?: number
  maxRecordsPerEndpoint?: number
  /** Durable persistence on by default — shadow history is the point of the lane. */
  persist?: boolean
  log?: (message: string) => void
}

export interface LiveWorkflowModuleStatus {
  status: string
  rows: number
  sourceGaps: number
  blockingSourceGaps: number
  discrepancies: number
}

export interface LiveWorkflowOutcome {
  mode: "local" | "shadow"
  startedAt: string
  publicSummary: Record<string, unknown>
  moduleStatuses: Record<string, LiveWorkflowModuleStatus>
  artifactCount: number
  rootDir: string
  governedDimensions: { rosterRows: number; stageTaxonomyRows: number }
  persistence: readonly PersistedModuleRunSummary[] | "skipped"
}

export async function runLiveCommandCenterWorkflow(options: RunLiveWorkflowOptions): Promise<LiveWorkflowOutcome> {
  const log = options.log ?? (() => {})
  const reqIds = options.reqIds && options.reqIds.length > 0 ? options.reqIds : DEFAULT_FOCUS_REQ_IDS
  const maxJobs = options.maxJobs ?? 40
  const startedAt = new Date().toISOString()

  const client = createLiveGreenhouseHarvestReadClient({
    maxRecordsPerEndpoint: options.maxRecordsPerEndpoint ?? 5000,
    log,
  })

  log(`[recruiting-ops live-workflow] scoping jobs (target reqs: ${reqIds.join(", ")})`)
  const jobs = await client.list<HarvestJobRecord>("/jobs", { per_page: 500 })
  const byReq = jobs.filter((job) => job.requisition_id !== undefined && reqIds.includes(String(job.requisition_id)))
  const targetJobs = (byReq.length > 0 ? byReq : jobs).slice(0, maxJobs)
  const jobIds = targetJobs.map((job) => String(job.id)).filter(Boolean)
  log(
    `[recruiting-ops live-workflow] org jobs: ${jobs.length}; matched by req: ${byReq.length}; scoped to ${jobIds.length} job id(s)`
  )

  const scoped = { job_ids: jobIds.join(",") }
  const boundary = createGreenhouseHarvestReadBoundary(client, {
    params: {
      T07: { ...scoped, current_only: true },
      T05: scoped,
      T02: scoped,
      // T09 stays org-wide: ownership/workload is a whole-org view by design.
    },
  })

  // Governed dimensions (migration 018): live attribution runs on table rows,
  // never the compiled fixture config. Fails loudly if the roster is unseeded.
  const [roster, interviewStageTaxonomy] = await Promise.all([
    loadGovernedRoster(),
    loadInterviewStageTaxonomy(),
  ])
  log(
    `[recruiting-ops live-workflow] governed dimensions: roster=${roster.length} row(s), stage taxonomy=${interviewStageTaxonomy.length} row(s)`
  )

  const generatedAt = new Date().toISOString()
  const result = await runLocalCommandCenterWorkflow({
    rootDir: options.rootDir,
    startedAt,
    generatedAt,
    weekBucket: mostRecentFridayUtc(new Date()),
    greenhouse: boundary,
    mode: options.mode,
    roster,
    interviewStageTaxonomy,
  })

  const moduleStatuses: Record<string, LiveWorkflowModuleStatus> = {}
  for (const workflowId of result.moduleOrder) {
    const moduleResult = result.runs[workflowId]
    moduleStatuses[workflowId] = {
      status: moduleResult.run.status,
      rows: moduleResult.normalizedRows.length,
      sourceGaps: moduleResult.sourceGaps.length,
      blockingSourceGaps: moduleResult.sourceGaps.filter((gap) => gap.blocksCutover).length,
      discrepancies: moduleResult.discrepancies.length,
    }
  }

  let persistence: LiveWorkflowOutcome["persistence"] = "skipped"
  if (options.persist !== false) {
    // Loud failures by design: a swallowed persistence error reads as "no data" weeks later.
    persistence = await persistWorkflowRuns(result, createSupabaseRunStoreClient())
    for (const summary of persistence) {
      log(
        `[recruiting-ops run-store] ${summary.workflowId}: ${summary.outcome} (gaps=${summary.rowCounts.sourceGaps} discrepancies=${summary.rowCounts.discrepancies} artifacts=${summary.rowCounts.artifacts})`
      )
    }
  }

  return {
    mode: options.mode,
    startedAt,
    publicSummary: result.publicSummary,
    moduleStatuses,
    artifactCount: result.artifacts.length,
    rootDir: options.rootDir,
    governedDimensions: { rosterRows: roster.length, stageTaxonomyRows: interviewStageTaxonomy.length },
    persistence,
  }
}

export function mostRecentFridayUtc(now: Date): string {
  const day = now.getUTCDay()
  const sinceFriday = (day - 5 + 7) % 7
  const friday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - sinceFriday))
  return friday.toISOString().slice(0, 10)
}
