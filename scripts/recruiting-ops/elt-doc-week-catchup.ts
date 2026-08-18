/**
 * Inserts one ELT doc week that the scheduled job missed.
 *
 * The archive's newest-first order is preserved: the absent week is inserted
 * at its date-ordered position between two retained blocks, and a week that
 * already exists refuses ("refusing to rewrite history"). Every protection
 * over existing content holds — the outside-content fingerprint is proven
 * before and after the write, and a failed insert rolls itself back.
 *
 * The numbers are recomputed from dated Greenhouse events for the requested
 * week, exactly as the job would have written them on the day. The clock
 * never moves: the source cut's generatedAt is the live clock, which is what
 * keeps the write path's freshness fence honest, and only the declared week
 * selects which events the ELT block carries. `--reporting-week` is the ELT
 * week's FRIDAY (the week runs Fri–Thu) and must be complete and strictly
 * older than the current reporting week.
 *
 * Deliberately bypasses the hydration orchestration ledger, like
 * weekly-progress-week-catchup.ts: record pre/post Drive revisions in the
 * tracking issue as the compensating evidence.
 *
 * Usage:
 *   GCLOUD_ACCESS_TOKEN=... node node_modules/.bin/jiti \
 *     scripts/recruiting-ops/elt-doc-week-catchup.ts \
 *     --reporting-week=2026-07-24 [--execute]
 */
import { PII_FINGERPRINT_SALT_ENV } from "../../lib/recruiting-ops/checksums"
import { buildReportingSourceCut } from "../../lib/recruiting-ops/delivery-source/reporting-source-cut"
import { createGoogleWorkspaceStagingClientsFromAccessToken } from "../../lib/recruiting-ops/delivery/google-workspace-staging-client"
import { runStagingEltDocHydration } from "../../lib/recruiting-ops/delivery/staging-elt-doc-hydration-runner"
import { stagingHydrationSourceRequirementsForArtifacts } from "../../lib/recruiting-ops/delivery/staging-hydration-runner"
import { eltReportingFriday, fridayWeekLabels } from "../../lib/recruiting-ops/exec-definitions"
import { createLiveGreenhouseHarvestReadClient } from "../../lib/recruiting-ops/extractors/greenhouse-live-read-client"
import {
  loadGovernedRoster,
  loadInterviewStageTaxonomy,
} from "../../lib/recruiting-ops/governed-dimensions-client"

const DAY_MS = 24 * 60 * 60 * 1_000

function requiredArg(name: string): string {
  const hit = process.argv.find((argument) => argument.startsWith(`--${name}=`))
  const value = hit?.slice(`--${name}=`.length).trim()
  if (!value) throw new Error(`missing --${name}`)
  return value
}

/** The declared week must be one the honest clock can no longer produce. */
function validateDeclaredWeek(declared: string, nowMs: number): void {
  const declaredMs = Date.parse(`${declared}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(declared) || Number.isNaN(declaredMs)) {
    throw new Error("--reporting-week must be an ISO date")
  }
  if (new Date(declaredMs).getUTCDay() !== 5) {
    throw new Error("--reporting-week must be a Friday (the ELT week runs Fri-Thu)")
  }
  if (declaredMs + 7 * DAY_MS >= nowMs) {
    throw new Error("--reporting-week must be a week that has already finished")
  }
  const currentEltFriday = eltReportingFriday(new Date(nowMs))
  if (declaredMs >= Date.parse(`${currentEltFriday}T00:00:00.000Z`)) {
    throw new Error(
      `--reporting-week must be older than the current reporting week ${currentEltFriday}; ` +
      "the scheduled run owns the current week"
    )
  }
}

async function main(): Promise<void> {
  const token = process.env.GCLOUD_ACCESS_TOKEN?.trim()
  if (!token) throw new Error("GCLOUD_ACCESS_TOKEN is required")
  const fingerprintKey = process.env[PII_FINGERPRINT_SALT_ENV]?.trim()
  if (!fingerprintKey) throw new Error(`${PII_FINGERPRINT_SALT_ENV} is required`)
  const eltBackfillWeekFriday = requiredArg("reporting-week")
  validateDeclaredWeek(eltBackfillWeekFriday, Date.now())
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
      eltBackfillWeekFriday,
      requirements: stagingHydrationSourceRequirementsForArtifacts([]),
    }
  )
  const eltFacts = cut.payload.eltSnapshot.elt_facts as { weekShort?: string } | undefined
  const declaredLabels = fridayWeekLabels(eltBackfillWeekFriday)
  if (eltFacts?.weekShort !== declaredLabels.weekShort) {
    throw new Error(
      `source cut resolved "${eltFacts?.weekShort}", not the requested "${declaredLabels.weekShort}"`
    )
  }

  const outcome = await runStagingEltDocHydration({
    mode,
    nowMs: Date.now(),
    currentTimeMs: Date.now,
    env: process.env,
    clients: createGoogleWorkspaceStagingClientsFromAccessToken(token),
    snapshot: cut.payload.eltSnapshot,
    eltBackfillWeekFriday,
  })
  console.log(JSON.stringify({ mode, outcome }, null, 2))
  if (outcome.status === "blocked") process.exitCode = 2
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
