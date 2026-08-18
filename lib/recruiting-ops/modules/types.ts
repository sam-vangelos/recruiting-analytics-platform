import type { CommandCenterRun, RunArtifact, SourceGap } from "../runs"
import type { Discrepancy } from "../discrepancies"

export interface RecruitingOpsModuleDefinition {
  moduleId: string
  /** Capability-first product binding. Every runnable module owns exactly one capability. */
  capabilityId: string
  /** Legacy coverage/provenance only — not the product abstraction. */
  workflowId: string
  title: string
  sourceIds: readonly string[]
  queryIds: readonly string[]
  legacyArtifactIds: readonly string[]
  outputContractIds: readonly string[]
}

export interface RecruitingOpsModuleResult<Row> {
  definition: RecruitingOpsModuleDefinition
  normalizedRows: readonly Row[]
  artifacts: readonly RunArtifact[]
  discrepancies: readonly Discrepancy[]
  sourceGaps: readonly SourceGap[]
  run: CommandCenterRun
}

/**
 * Stamp the module's `capabilityId` onto every record it produces (run, source
 * gaps, discrepancies, artifacts). `capabilityId` is optional at the substrate
 * type level so callers keep compiling; this helper is what makes it non-optional
 * in practice — the producer test asserts every module-produced record carries it.
 * Every module's run function must return through this helper.
 */
export function finalizeModuleResult<Row>(input: {
  definition: RecruitingOpsModuleDefinition
  normalizedRows: readonly Row[]
  artifacts: readonly RunArtifact[]
  discrepancies: readonly Discrepancy[]
  sourceGaps: readonly SourceGap[]
  run: CommandCenterRun
}): RecruitingOpsModuleResult<Row> {
  const { capabilityId } = input.definition
  return {
    definition: input.definition,
    normalizedRows: input.normalizedRows,
    artifacts: input.artifacts.map((artifact) => ({ ...artifact, capabilityId })),
    discrepancies: input.discrepancies.map((discrepancy) => ({ ...discrepancy, capabilityId })),
    sourceGaps: input.sourceGaps.map((gap) => ({ ...gap, capabilityId })),
    run: { ...input.run, capabilityId },
  }
}
