/**
 * Writes one Weekly Progress week column that the scheduled job missed.
 *
 * Weekly Progress QTD is a formula spanning the quarter's week columns, so a
 * week the job never wrote makes every later QTD read low. The structural
 * planner fails closed on the gap rather than writing an understated total,
 * which is why a skipped week has to be filled before the current cycle can
 * run at all.
 *
 * The numbers are recomputed from dated Greenhouse events for the requested
 * week, exactly as the job would have written them on the day. Nothing is
 * carried over or invented. `--reporting-week` must be a Friday that is
 * already complete; the live clock still governs kill-switch and permit
 * freshness, so only the reporting calendar is moved.
 *
 * Usage:
 *   GCLOUD_ACCESS_TOKEN=... node node_modules/.bin/jiti \
 *     scripts/recruiting-ops/weekly-progress-week-catchup.ts \
 *     --reporting-week=2026-07-24 [--execute]
 */
import { buildReportingSourceCut } from "../../lib/recruiting-ops/delivery-source/reporting-source-cut"
import {
  loadGovernedRoster,
  loadInterviewStageTaxonomy,
} from "../../lib/recruiting-ops/governed-dimensions-client"
import { createLiveGreenhouseHarvestReadClient } from "../../lib/recruiting-ops/extractors/greenhouse-live-read-client"
import { createGoogleWorkspaceStagingClientsFromAccessToken } from "../../lib/recruiting-ops/delivery/google-workspace-staging-client"
import {
  runStagingHydration,
  stagingHydrationSourceRequirementsForArtifacts,
} from "../../lib/recruiting-ops/delivery/staging-hydration-runner"
import { runStagingRecurringSheetLifecycle } from "../../lib/recruiting-ops/delivery/staging-recurring-sheet-lifecycle-runner"
import {
  renderWeeklyProgressQuarterClosingOffsets,
  renderWeeklyProgressQuarterOpeningOffsets,
} from "../../lib/recruiting-ops/delivery/weekly-progress-renderer"
import { PII_FINGERPRINT_SALT_ENV } from "../../lib/recruiting-ops/checksums"

const DAY_MS = 24 * 60 * 60 * 1_000

function requiredArg(name: string): string {
  const hit = process.argv.find((argument) => argument.startsWith(`--${name}=`))
  const value = hit?.slice(`--${name}=`.length).trim()
  if (!value) throw new Error(`missing --${name}`)
  return value
}

/** Midday inside the requested week: the reporting calendar the job would have seen. */
function validationClockFor(reportingWeekFriday: string): number {
  const fridayMs = Date.parse(`${reportingWeekFriday}T00:00:00.000Z`)
  if (Number.isNaN(fridayMs)) throw new Error("--reporting-week must be an ISO date")
  if (new Date(fridayMs).getUTCDay() !== 5) throw new Error("--reporting-week must be a Friday")
  const weekEndMs = fridayMs + 6 * DAY_MS
  if (weekEndMs >= Date.now()) {
    throw new Error("--reporting-week must be a week that has already finished")
  }
  return fridayMs + 3 * DAY_MS + 12 * 60 * 60 * 1_000
}

async function main(): Promise<void> {
  const token = process.env.GCLOUD_ACCESS_TOKEN?.trim()
  if (!token) throw new Error("GCLOUD_ACCESS_TOKEN is required")
  const fingerprintKey = process.env[PII_FINGERPRINT_SALT_ENV]?.trim()
  if (!fingerprintKey) throw new Error(`${PII_FINGERPRINT_SALT_ENV} is required`)
  const reportingWeekFriday = requiredArg("reporting-week")
  const calendarValidationNowMs = validationClockFor(reportingWeekFriday)
  const execute = process.argv.includes("--execute")
  const mode = execute ? "write" : "dry_run"

  const cut = await buildReportingSourceCut(
    {
      createGreenhouseClient: () =>
        createLiveGreenhouseHarvestReadClient({ maxRecordsPerEndpoint: 200_000 }),
      loadRoster: loadGovernedRoster,
      loadStageTaxonomy: loadInterviewStageTaxonomy,
      fingerprintKey,
    },
    {
      nowMs: Date.now(),
      recordCap: 200_000,
      reportingWeekFriday,
      calendarValidationNowMs,
      requirements: stagingHydrationSourceRequirementsForArtifacts(["weekly_progress"]),
    }
  )
  const facts = cut.payload.facts
  if (facts.reportingWeekFriday !== reportingWeekFriday) {
    throw new Error(
      `source cut resolved ${facts.reportingWeekFriday}, not the requested ${reportingWeekFriday}`
    )
  }

  const clients = createGoogleWorkspaceStagingClientsFromAccessToken(token)
  const offsetInput = {
    reportingWeekFriday,
    candidateEvents: facts.candidateEvents,
    offers: facts.offers,
    scorecards: facts.scorecards,
  }
  const opening = renderWeeklyProgressQuarterOpeningOffsets(offsetInput)
  const closing = renderWeeklyProgressQuarterClosingOffsets(offsetInput)

  const structural = await runStagingRecurringSheetLifecycle({
    artifactKey: "weekly_progress",
    clients,
    reportingWeekFriday,
    mode,
    nowMs: calendarValidationNowMs,
    sourceGeneratedAt: facts.generatedAt,
    currentTimeMs: Date.now,
    weeklyProgressQuarterOpeningOffsets: [
      { sheetId: 0, rowOffsets: opening.code_rl },
      { sheetId: 242118538, rowOffsets: opening.fde_pe },
      { sheetId: 1450892249, rowOffsets: opening.brazil_colombia },
    ],
    weeklyProgressQuarterClosingOffsets: [
      { sheetId: 0, rowOffsets: closing.code_rl },
      { sheetId: 242118538, rowOffsets: closing.fde_pe },
      { sheetId: 1450892249, rowOffsets: closing.brazil_colombia },
    ],
  })
  console.log(JSON.stringify({ phase: "structural", mode, outcome: structural.outcome }, null, 2))
  if (structural.outcome.status === "blocked") {
    process.exitCode = 2
    return
  }

  const values = await runStagingHydration({
    artifactKeys: ["weekly_progress"],
    mode,
    clients,
    facts,
    roster: cut.payload.roster,
    reportingWeekFriday,
    runId: `weekly_progress_catchup_${reportingWeekFriday.replace(/-/g, "")}`,
    nowMs: Date.now(),
    currentTimeMs: Date.now,
  })
  console.log(JSON.stringify({ phase: "values", mode, outcome: values.artifactOutcomes }, null, 2))
  if (values.artifactOutcomes.some((outcome) => outcome.status === "blocked")) process.exitCode = 2
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[weekly-progress-catchup] blocked: ${message.replace(/[\r\n]+/g, " ").slice(0, 500)}`)
  process.exitCode = 1
})
