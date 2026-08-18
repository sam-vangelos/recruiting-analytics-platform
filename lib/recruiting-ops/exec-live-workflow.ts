import { buildGovernedFunnelMap, eltReportingFriday, OFFERS_TRAILING_DAYS, reportingQuarter } from "./exec-definitions"
import type { GreenhouseExecReadBoundary } from "./extractors/greenhouse-exec-read-boundary"
import { createGreenhouseHarvestExecReadBoundary } from "./extractors/greenhouse-harvest-read-adapter"
import { createLiveGreenhouseHarvestReadClient } from "./extractors/greenhouse-live-read-client"
import { loadGovernedRoster, loadInterviewStageTaxonomy } from "./governed-dimensions-client"
import {
  collectEngagedApplicationIds,
  collectExecCandidateIds,
  runExecStateOfPlayModule,
  type ExecStateOfPlayModuleResult,
} from "./modules/exec-state-of-play"
import { persistModuleRun, type PersistedModuleRunSummary } from "./run-store"
import { createSupabaseRunStoreClient } from "./supabase-run-store-client"
import { writeExecSnapshot, type ExecSnapshotDatabaseClient } from "./exec-snapshot-store"

/**
 * Live entrypoint for the E01 exec state-of-play module — the org-wide sibling
 * of live-workflow.ts (which stays focus-req-scoped for the six-module run).
 * Scoping → governed dimensions → boundary pull → module → durable persist.
 * Output to the console is PUBLIC-SAFE counts; row content lives in the run
 * artifacts and (via the caller) the exec snapshot store.
 */

// Sized above measured volumes: ~60k application_stages rows touched per 15
// days (measured 2026-07-06), so ~120k for the 31-day window; org-wide actives
// ~170k after prospect exclusion would exceed one cap-window, but the pull is
// chunked by job_ids so the cap applies per chunk. The stage/scorecard window
// pulls are the single-call pulls the cap actually bounds.
const DEFAULT_MAX_RECORDS_PER_ENDPOINT = 200_000
// 31, not 15: the tier model (content contract §1) needs a true 30-day
// conducted/advanced signal, and v3 /applications carries no stage-recency
// field to derive it from — the windowed pulls are the only source.
const MOVEMENT_WINDOW_MARGIN_DAYS = 31

export interface RunExecLiveWorkflowOptions {
  mode: "local" | "shadow"
  rootDir: string
  maxRecordsPerEndpoint?: number
  persist?: boolean
  log?: (message: string) => void
  /** Test seam: inject a boundary instead of the live client. */
  boundary?: GreenhouseExecReadBoundary
  /** Test seam: inject a snapshot client instead of Supabase. */
  snapshotClient?: ExecSnapshotDatabaseClient
  nowMs?: number
}

export interface ExecLiveWorkflowOutcome {
  mode: "local" | "shadow"
  startedAt: string
  moduleResult: ExecStateOfPlayModuleResult
  persistence: readonly PersistedModuleRunSummary[] | "skipped"
  governedDimensions: { rosterRows: number; stageTaxonomyRows: number; governedFunnelRows: number }
}

export async function runExecLiveWorkflow(options: RunExecLiveWorkflowOptions): Promise<ExecLiveWorkflowOutcome> {
  const log = options.log ?? (() => {})
  const startedAt = new Date().toISOString()
  const nowMs = options.nowMs ?? Date.now()

  const boundary =
    options.boundary ??
    createGreenhouseHarvestExecReadBoundary(
      createLiveGreenhouseHarvestReadClient({
        maxRecordsPerEndpoint: options.maxRecordsPerEndpoint ?? DEFAULT_MAX_RECORDS_PER_ENDPOINT,
        log,
      }),
      { recordCap: options.maxRecordsPerEndpoint ?? DEFAULT_MAX_RECORDS_PER_ENDPOINT }
    )

  const [roster, stageTaxonomy] = await Promise.all([loadGovernedRoster(), loadInterviewStageTaxonomy()])
  // funnelStage arrives with migration 021's taxonomy columns; older rows carry
  // only the 3-class stageClass and simply don't join the governed funnel map.
  const governedFunnel = buildGovernedFunnelMap(
    stageTaxonomy.map((entry) => ({
      stageLabel: entry.stageLabel,
      funnelStage: (entry as { funnelStage?: string | null }).funnelStage ?? null,
    }))
  )
  log(
    `[exec-live] governed dimensions: roster=${roster.length} taxonomy=${stageTaxonomy.length} funnel-mapped=${governedFunnel.size}`
  )

  // Offers window: the trailing-12-week hires strip, widened when the ELT
  // reporting week's quarter started earlier — QTD must not be truncated by
  // the 84-day window early in a quarter's reporting.
  const offersTrailingMs = nowMs - OFFERS_TRAILING_DAYS * 86_400_000
  const eltQuarterStartMs = Date.parse(`${reportingQuarter(eltReportingFriday(new Date(nowMs))).startIso}T00:00:00.000Z`)
  const windows = {
    movementSinceIso: new Date(nowMs - MOVEMENT_WINDOW_MARGIN_DAYS * 86_400_000).toISOString(),
    offersSinceIso: new Date(Math.min(offersTrailingMs, eltQuarterStartMs)).toISOString(),
  }
  const pulled = await boundary.fetchExecStateSources({ asOf: startedAt }, windows)
  log(
    `[exec-live] sources: jobs=${pulled.sources.jobs.length} apps=${pulled.sources.applications.length} stageRows=${pulled.sources.applicationStages.length} scorecards=${pulled.sources.scorecards.length} awaitingFeedback=${pulled.sources.awaitingFeedbackInterviews.length} offers=${pulled.sources.offers.length}`
  )
  for (const pull of pulled.pullDiagnostics) {
    log(`[exec-live] pull ${pull.source}: ${pull.records}${pull.truncationSuspected ? " TRUNCATION SUSPECTED" : ""}`)
  }

  const candidateIds = collectExecCandidateIds(pulled.sources, governedFunnel)
  const candidates = await boundary.fetchExecCandidateNames(candidateIds)
  const candidateNameById = new Map(
    candidates.map((candidate) => [
      String(candidate.id),
      [candidate.first_name, candidate.last_name].filter(Boolean).join(" ").trim(),
    ])
  )
  log(`[exec-live] candidate names resolved: ${candidateNameById.size}/${candidateIds.length}`)

  // Stage histories for engaged applications — true last-advance dates and
  // time-in-current-stage (tier + attention inputs, content contract §4.2).
  const engagedApplicationIds = collectEngagedApplicationIds(pulled.sources, governedFunnel)
  const engagedStageHistories = await boundary.fetchEngagedStageHistories(engagedApplicationIds)
  log(
    `[exec-live] engaged stage histories: ${engagedStageHistories.length} rows for ${engagedApplicationIds.length} applications`
  )

  const moduleResult = await runExecStateOfPlayModule({
    rootDir: options.rootDir,
    startedAt,
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    sources: pulled.sources,
    roster,
    governedFunnel,
    candidateNameById,
    engagedStageHistories,
    nowMs,
    pullDiagnostics: pulled.pullDiagnostics,
  })
  log(
    `[exec-live] module: status=${moduleResult.run.status} rows=${moduleResult.normalizedRows.length} gaps=${moduleResult.sourceGaps.length} (blocking=${moduleResult.sourceGaps.filter((gap) => gap.blocksCutover).length})`
  )

  let persistence: ExecLiveWorkflowOutcome["persistence"] = "skipped"
  if (options.persist !== false) {
    // Loud failures by design — a swallowed persistence error reads as "no data" weeks later.
    const summary = await persistModuleRun(moduleResult, createSupabaseRunStoreClient())
    persistence = [summary]
    log(
      `[exec-live run-store] ${summary.workflowId}: ${summary.outcome} (gaps=${summary.rowCounts.sourceGaps} artifacts=${summary.rowCounts.artifacts})`
    )
    // The page-readable snapshot: only for runs whose pulls were complete — a
    // truncation-blocked run must never become the surface execs read.
    if (moduleResult.run.status === "succeeded") {
      await writeExecSnapshot(
        {
          runId: moduleResult.run.runId,
          mode: options.mode,
          generatedAt: moduleResult.run.completedAt ?? moduleResult.execState.rollup.as_of,
          bundle: moduleResult.execState,
          eltFacts: moduleResult.execState.eltFacts,
        },
        options.snapshotClient
      )
      log(`[exec-live snapshot] wrote ${moduleResult.run.runId} (${moduleResult.execState.rows.length} req rows)`)
    } else {
      log(`[exec-live snapshot] SKIPPED — run status ${moduleResult.run.status}; the page keeps the last good snapshot`)
    }
  }

  return {
    mode: options.mode,
    startedAt,
    moduleResult,
    persistence,
    governedDimensions: {
      rosterRows: roster.length,
      stageTaxonomyRows: stageTaxonomy.length,
      governedFunnelRows: governedFunnel.size,
    },
  }
}
