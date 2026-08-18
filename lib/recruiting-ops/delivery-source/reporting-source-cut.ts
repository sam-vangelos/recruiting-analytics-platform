import { createPseudonymousFingerprint } from "../checksums"
import type { RecruiterTeamHodEntry } from "../dimensions/config/recruiter-team-hod.v1"
import type { InterviewStageTaxonomyEntry } from "../dimensions/types"
import { buildGovernedFunnelMap, reportingQuarter } from "../exec-definitions"
import type { ExecSnapshotRow } from "../exec-snapshot-store"
import {
  createGreenhouseHarvestExecReadBoundary,
  type GreenhouseHarvestReadClient,
} from "../extractors/greenhouse-harvest-read-adapter"
import {
  collectEngagedApplicationIds,
  collectExecCandidateIds,
  deriveExecState,
} from "../modules/exec-state-of-play"
import { buildRunId } from "../runs"
import {
  deriveStagingHydrationFacts,
  loadStagingHydrationSourceCollections,
  type StagingHydrationFacts,
  type StagingHydrationSourceRequirements,
} from "./staging-hydration-source-loader"

export const REPORTING_SOURCE_CUT_SCHEMA_VERSION = "1.0.0"
const FINGERPRINT_CONTEXT = "recruiting-ops-reporting-source-cut:v1"

export interface ReportingSourceCutPayload {
  readonly schemaVersion: typeof REPORTING_SOURCE_CUT_SCHEMA_VERSION
  readonly facts: StagingHydrationFacts
  readonly roster: readonly RecruiterTeamHodEntry[]
  readonly eltSnapshot: ExecSnapshotRow
}

export interface ReportingSourceCut {
  readonly payload: ReportingSourceCutPayload
  readonly payloadFingerprint: string
}

export interface ReportingSourceCutPorts {
  createGreenhouseClient(): GreenhouseHarvestReadClient
  loadRoster(): Promise<readonly RecruiterTeamHodEntry[]>
  loadStageTaxonomy(): Promise<readonly InterviewStageTaxonomyEntry[]>
  fingerprintKey: string
}

export interface ReportingSourceCutOptions {
  nowMs?: number
  recordCap?: number
  reportingWeekFriday?: string
  quarterStart?: string
  calendarValidationNowMs?: number
  requirements?: StagingHydrationSourceRequirements
  /**
   * Declares a past Fri–Thu week for the ELT block. Deliberately separate from
   * `reportingWeekFriday`, which routes through the weekly-recruitment calendar
   * validator and would force a validation-clock rewind; this option moves only
   * the ELT facts' event windows, and the cut's generatedAt stays the live
   * clock.
   */
  eltBackfillWeekFriday?: string
}

interface ReportingSourceCutDependencies {
  loadCollections: typeof loadStagingHydrationSourceCollections
  createExecBoundary: typeof createGreenhouseHarvestExecReadBoundary
}

const DEFAULT_DEPENDENCIES: ReportingSourceCutDependencies = {
  loadCollections: loadStagingHydrationSourceCollections,
  createExecBoundary: createGreenhouseHarvestExecReadBoundary,
}

/** Build the one immutable, replayable payload shared by a reporting run. */
export async function buildReportingSourceCut(
  ports: ReportingSourceCutPorts,
  options: ReportingSourceCutOptions = {},
  dependencies: ReportingSourceCutDependencies = DEFAULT_DEPENDENCIES
): Promise<ReportingSourceCut> {
  const client = ports.createGreenhouseClient()
  const collections = await dependencies.loadCollections({
    client,
    nowMs: options.nowMs,
    recordCap: options.recordCap,
    reportingWeekFriday: options.reportingWeekFriday,
    // A declared backfill week must sit inside the pull windows. Anchoring the
    // quarter to the declared week guarantees that, since a quarter start
    // always precedes its weeks' Fridays; for a same-quarter backfill this is
    // the value the loader would have derived anyway.
    quarterStart: options.quarterStart
      ?? (options.eltBackfillWeekFriday
        ? reportingQuarter(options.eltBackfillWeekFriday).startIso
        : undefined),
    calendarValidationNowMs: options.calendarValidationNowMs,
    requirements: options.requirements ?? {
      includeLegacyRpsHistory: true,
      includeDeliveryRpsCurrentWeek: true,
    },
  })

  const truncated = collections.diagnostics.filter((diagnostic) => diagnostic.truncationSuspected)
  if (truncated.length > 0) {
    throw new Error(
      `Reporting source cut rejected: suspected truncation in ${truncated
        .map((diagnostic) => `${diagnostic.source} (${diagnostic.records})`)
        .join(", ")}`
    )
  }
  if (!collections.execSources) {
    throw new Error("Reporting source cut rejected: hydration loader returned no reusable E01 source base")
  }
  const blockingSourceGaps = (collections.execSourceGaps ?? []).filter((gap) => gap.blocksCutover)
  if (blockingSourceGaps.length > 0) {
    throw new Error(`Reporting source cut rejected: ${blockingSourceGaps.length} blocking source gap(s)`)
  }

  const [roster, stageTaxonomy] = await Promise.all([
    ports.loadRoster(),
    ports.loadStageTaxonomy(),
  ])
  const governedFunnel = buildGovernedFunnelMap(stageTaxonomy)
  const boundary = dependencies.createExecBoundary(client, { recordCap: options.recordCap })
  const [candidates, engagedStageHistories] = await Promise.all([
    boundary.fetchExecCandidateNames(collectExecCandidateIds(collections.execSources, governedFunnel)),
    boundary.fetchEngagedStageHistories(collectEngagedApplicationIds(collections.execSources, governedFunnel)),
  ])
  const candidateNameById = new Map(
    candidates.map((candidate) => [
      String(candidate.id),
      [candidate.first_name, candidate.last_name].filter(Boolean).join(" ").trim(),
    ])
  )
  const generatedAtMs = Date.parse(collections.generatedAt)
  if (!Number.isFinite(generatedAtMs)) {
    throw new Error("Reporting source cut rejected: hydration loader returned an invalid generatedAt")
  }

  const facts = deriveStagingHydrationFacts({ collections, roster, stageTaxonomy })
  const execState = deriveExecState({
    sources: collections.execSources,
    roster,
    governedFunnel,
    candidateNameById,
    engagedStageHistories,
    nowMs: generatedAtMs,
    pullDiagnostics: collections.diagnostics,
    ...(options.eltBackfillWeekFriday
      ? { eltBackfillWeekFriday: options.eltBackfillWeekFriday }
      : {}),
  }).bundle
  const payload: ReportingSourceCutPayload = {
    schemaVersion: REPORTING_SOURCE_CUT_SCHEMA_VERSION,
    facts,
    roster,
    eltSnapshot: {
      run_id: buildRunId("E01", collections.generatedAt),
      workflow_id: "E01",
      mode: "shadow",
      generated_at: collections.generatedAt,
      org_rollup: execState.rollup,
      req_rows: execState.rows,
      hires: execState.hires,
      elt_facts: execState.eltFacts,
    },
  }
  const payloadFingerprint = createPseudonymousFingerprint(payload, {
    key: ports.fingerprintKey,
    context: FINGERPRINT_CONTEXT,
  })

  return Object.freeze({ payload: deepFreeze(payload), payloadFingerprint })
}

/** Validate and freeze a persisted cut before any artifact can consume it. */
export function replayReportingSourceCut(input: {
  payload: unknown
  payloadFingerprint: string
  fingerprintKey: string
}): ReportingSourceCut {
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new Error("Reporting source cut replay rejected: payload is not an object")
  }
  const payload = input.payload as Partial<ReportingSourceCutPayload>
  if (
    payload.schemaVersion !== REPORTING_SOURCE_CUT_SCHEMA_VERSION ||
    !payload.facts ||
    !Array.isArray(payload.roster) ||
    !payload.eltSnapshot ||
    payload.facts.generatedAt !== payload.eltSnapshot.generated_at ||
    payload.eltSnapshot.workflow_id !== "E01" ||
    payload.eltSnapshot.mode !== "shadow"
  ) {
    throw new Error("Reporting source cut replay rejected: payload contract mismatch")
  }
  const fingerprint = createPseudonymousFingerprint(payload, {
    key: input.fingerprintKey,
    context: FINGERPRINT_CONTEXT,
  })
  if (fingerprint !== input.payloadFingerprint) {
    throw new Error("Reporting source cut replay rejected: HMAC fingerprint mismatch")
  }
  return Object.freeze({
    payload: deepFreeze(payload as ReportingSourceCutPayload),
    payloadFingerprint: fingerprint,
  })
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
