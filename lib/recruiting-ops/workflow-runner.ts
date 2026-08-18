import type { LegacyPipelineEvidenceRow } from "./modules/t02-pipeline"
import { runPipelineModule } from "./modules/t02-pipeline"
import { runProgressModule } from "./modules/t03-progress"
import type { LegacyRpsEvidenceRow } from "./modules/t05-rps"
import { runRpsModule } from "./modules/t05-rps"
import type { LegacyFinalOfferEvidenceRow } from "./modules/t07-final-offer"
import { runFinalOfferModule } from "./modules/t07-final-offer"
import type { LegacyOwnershipEvidenceRow } from "./modules/t09-ownership"
import { runOwnershipModule } from "./modules/t09-ownership"
import type { LegacyWeeklyLeadershipEvidenceRow } from "./modules/t01-weekly-leadership"
import { runWeeklyLeadershipModule } from "./modules/t01-weekly-leadership"
import type { RecruiterTeamHodEntry } from "./dimensions/config/recruiter-team-hod.v1"
import type { InterviewStageTaxonomyEntry } from "./dimensions/types"
import type { RunArtifact } from "./runs"
import { assertPublicSafe } from "./safe-public-output"
import type { CommandCenterMode } from "./substrate"
import type { GreenhouseReadBoundary, GreenhouseReadContext } from "./extractors/greenhouse-read-boundary"

export interface LocalWorkflowLegacyEvidence {
  finalOfferRows?: readonly LegacyFinalOfferEvidenceRow[]
  rpsRows?: readonly LegacyRpsEvidenceRow[]
  pipelineRows?: readonly LegacyPipelineEvidenceRow[]
  ownershipRows?: readonly LegacyOwnershipEvidenceRow[]
  weeklyLeadershipRows?: readonly LegacyWeeklyLeadershipEvidenceRow[]
}

export interface RunLocalCommandCenterWorkflowInput {
  rootDir: string
  startedAt: string
  generatedAt: string
  weekBucket: string
  greenhouse: GreenhouseReadBoundary
  /**
   * Honest run mode: "fixture" for fixture boundaries (default), "local" for a
   * live-read run from a workstation, "shadow" for the scheduled shadow lane.
   * A live run must never stamp its history as fixture data.
   */
  mode?: CommandCenterMode
  /** Governed recruiter→team/HOD roster (migration 018); compiled fixture config when absent. */
  roster?: readonly RecruiterTeamHodEntry[]
  /** Governed interview-stage classification (migration 018); heuristics when absent. */
  interviewStageTaxonomy?: readonly InterviewStageTaxonomyEntry[]
  legacyEvidence?: LocalWorkflowLegacyEvidence
}

export interface LocalCommandCenterWorkflowResult {
  moduleOrder: readonly ["T07", "T05", "T02", "T03", "T09", "T01"]
  runs: {
    T07: Awaited<ReturnType<typeof runFinalOfferModule>>
    T05: Awaited<ReturnType<typeof runRpsModule>>
    T02: Awaited<ReturnType<typeof runPipelineModule>>
    T03: Awaited<ReturnType<typeof runProgressModule>>
    T09: Awaited<ReturnType<typeof runOwnershipModule>>
    T01: Awaited<ReturnType<typeof runWeeklyLeadershipModule>>
  }
  artifacts: readonly RunArtifact[]
  publicSummary: Record<string, unknown>
}

export async function runLocalCommandCenterWorkflow(
  input: RunLocalCommandCenterWorkflowInput
): Promise<LocalCommandCenterWorkflowResult> {
  const context: GreenhouseReadContext = {
    asOf: input.startedAt,
    fixtureLabel: "local-command-center-runner",
  }
  // Each fetch carries facts + adapter-level source gaps; the gaps are threaded
  // into the modules so records the adapter could not map surface in run status,
  // artifacts, and discrepancies instead of vanishing at the boundary.
  const [finalOfferFetch, rpsFetch, pipelineFetch, ownershipFetch] = await Promise.all([
    input.greenhouse.fetchFinalOfferFacts(context),
    input.greenhouse.fetchRpsFacts(context),
    input.greenhouse.fetchPipelineStageFacts(context),
    input.greenhouse.fetchOwnershipFacts(context),
  ])

  const t07 = await runFinalOfferModule({
    rootDir: input.rootDir,
    startedAt: input.startedAt,
    generatedAt: input.generatedAt,
    mode: input.mode,
    greenhouseFacts: finalOfferFetch.facts,
    adapterSourceGaps: finalOfferFetch.sourceGaps,
    roster: input.roster,
    legacyRows: input.legacyEvidence?.finalOfferRows,
  })
  const t05 = await runRpsModule({
    rootDir: input.rootDir,
    startedAt: input.startedAt,
    generatedAt: input.generatedAt,
    mode: input.mode,
    greenhouseFacts: rpsFetch.facts,
    adapterSourceGaps: rpsFetch.sourceGaps,
    roster: input.roster,
    interviewStageTaxonomy: input.interviewStageTaxonomy,
    legacyRows: input.legacyEvidence?.rpsRows,
  })
  const t02 = await runPipelineModule({
    rootDir: input.rootDir,
    startedAt: input.startedAt,
    generatedAt: input.generatedAt,
    mode: input.mode,
    greenhouseFacts: pipelineFetch.facts,
    adapterSourceGaps: pipelineFetch.sourceGaps,
    legacyRows: input.legacyEvidence?.pipelineRows,
  })
  const t03 = await runProgressModule({
    rootDir: input.rootDir,
    startedAt: input.startedAt,
    generatedAt: input.generatedAt,
    mode: input.mode,
    pipelineRows: t02.normalizedRows,
  })
  const t09 = await runOwnershipModule({
    rootDir: input.rootDir,
    startedAt: input.startedAt,
    generatedAt: input.generatedAt,
    mode: input.mode,
    greenhouseFacts: ownershipFetch.facts,
    adapterSourceGaps: ownershipFetch.sourceGaps,
    roster: input.roster,
    legacyRows: input.legacyEvidence?.ownershipRows,
  })
  const t01 = await runWeeklyLeadershipModule({
    rootDir: input.rootDir,
    startedAt: input.startedAt,
    generatedAt: input.generatedAt,
    mode: input.mode,
    weekBucket: input.weekBucket,
    finalOfferRows: t07.normalizedRows,
    rpsRows: t05.normalizedRows,
    pipelineRows: t02.normalizedRows,
    ownershipRows: t09.normalizedRows,
    legacyRows: input.legacyEvidence?.weeklyLeadershipRows,
  })
  const artifacts = [
    ...t07.artifacts,
    ...t05.artifacts,
    ...t02.artifacts,
    ...t03.artifacts,
    ...t09.artifacts,
    ...t01.artifacts,
  ]
  const publicSummary = {
    moduleCount: 6,
    artifactCount: artifacts.length,
    runStatuses: {
      T07: t07.run.status,
      T05: t05.run.status,
      T02: t02.run.status,
      T03: t03.run.status,
      T09: t09.run.status,
      T01: t01.run.status,
    },
    totalDiscrepancies:
      t07.discrepancies.length +
      t05.discrepancies.length +
      t02.discrepancies.length +
      t03.discrepancies.length +
      t09.discrepancies.length +
      t01.discrepancies.length,
  }
  assertPublicSafe(publicSummary, "localWorkflow.publicSummary")

  return {
    moduleOrder: ["T07", "T05", "T02", "T03", "T09", "T01"],
    runs: {
      T07: t07,
      T05: t05,
      T02: t02,
      T03: t03,
      T09: t09,
      T01: t01,
    },
    artifacts,
    publicSummary,
  }
}
