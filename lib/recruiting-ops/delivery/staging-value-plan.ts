import {
  createPiiFingerprint,
  stableSerialize,
  type PiiFingerprintProvenance,
} from "../checksums"
import type { StagingArtifactKey } from "./staging-artifact-registry"
import type { StagingSheetContractId } from "./staging-sheet-contracts"

export type SheetCellValue = string | number | boolean | null

export function normalizeStagingSheetScalar(value: SheetCellValue): SheetCellValue {
  if (value === null || value === "") return null
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Staging value plan contains a non-finite number.")
    }
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value === "string" || typeof value === "boolean") return value
  throw new Error("Staging value plan contains an unsupported scalar.")
}

export interface PlannedSheetRangeWrite {
  rangeId: StagingSheetContractId
  a1Range: string
  values: readonly (readonly SheetCellValue[])[]
  preimageFingerprint: string
  desiredFingerprint: string
  changed: boolean
}

export interface StagingSheetValuePlan {
  artifactKey: Exclude<StagingArtifactKey, "elt_doc">
  runId: string
  sourceGeneratedAt: string
  structureHash: string
  payloadFingerprint: string
  approvedRangeIds: readonly StagingSheetContractId[]
  noOp: boolean
  writes: readonly PlannedSheetRangeWrite[]
}

export interface ProjectedStagingStructureBasis {
  kind: "projected_post_normalization"
  normalizationId: string
  normalizationFingerprint: string
  observedDriveVersion: string
  observedStructureFingerprint: string
  expectedAfterStateFingerprint: string
  forwardRequestsFingerprint: string
  rollbackRequestsFingerprint: string
}

/** Dry-run evidence only. Deliberately lacks structureHash and cannot mint a write permit. */
export interface ProjectedDeliveryRpsValuePlan {
  kind: "projected_dry_run"
  artifactKey: "delivery_roles_rps"
  runId: string
  sourceGeneratedAt: string
  structure: ProjectedStagingStructureBasis
  projectedPreimageFingerprint: string
  desiredPayloadFingerprint: string
  planFingerprint: string
  noOp: boolean
  writes: readonly PlannedSheetRangeWrite[]
}

export interface BuildStagingSheetValuePlanInput {
  artifactKey: Exclude<StagingArtifactKey, "elt_doc">
  runId: string
  sourceGeneratedAt: string
  structureHash: string
  dataProvenance: PiiFingerprintProvenance
  ranges: readonly {
    rangeId: StagingSheetContractId
    a1Range: string
    currentValues: readonly (readonly SheetCellValue[])[]
    desiredValues: readonly (readonly SheetCellValue[])[]
  }[]
}

export interface BuildProjectedDeliveryRpsValuePlanInput {
  runId: string
  sourceGeneratedAt: string
  structure: ProjectedStagingStructureBasis
  dataProvenance: PiiFingerprintProvenance
  ranges: BuildStagingSheetValuePlanInput["ranges"]
}

/**
 * Produces a private, PII-bearing write plan plus only HMAC fingerprints for
 * replay/race evidence. Callers must keep `writes[].values` in memory and log
 * only counts/fingerprints.
 */
export function buildStagingSheetValuePlan(input: BuildStagingSheetValuePlanInput): StagingSheetValuePlan {
  if (!input.runId.trim()) throw new Error("Staging sheet plan run id is required.")
  if (Number.isNaN(Date.parse(input.sourceGeneratedAt))) {
    throw new Error("Staging sheet plan sourceGeneratedAt must be a valid timestamp.")
  }
  if (!input.structureHash.startsWith("sha256:")) {
    throw new Error("Staging sheet plan requires a SHA-256 structure hash.")
  }
  const writes = buildPlannedRangeWrites(input)
  const payloadFingerprint = desiredPayloadFingerprint(input.artifactKey, writes, input.dataProvenance)
  return {
    artifactKey: input.artifactKey,
    runId: input.runId,
    sourceGeneratedAt: new Date(input.sourceGeneratedAt).toISOString(),
    structureHash: input.structureHash,
    payloadFingerprint,
    approvedRangeIds: writes.map((write) => write.rangeId),
    noOp: writes.every((write) => !write.changed),
    writes,
  }
}

export function buildProjectedDeliveryRpsValuePlan(
  input: BuildProjectedDeliveryRpsValuePlanInput
): ProjectedDeliveryRpsValuePlan {
  if (!input.runId.trim()) throw new Error("Projected Delivery RPS plan run id is required.")
  if (Number.isNaN(Date.parse(input.sourceGeneratedAt))) {
    throw new Error("Projected Delivery RPS sourceGeneratedAt must be a valid timestamp.")
  }
  assertProjectedStructureBasis(input.structure)
  const artifactKey = "delivery_roles_rps" as const
  const requiredRangeIds = [
    "delivery_rps_raw",
    "delivery_rps_clean",
    "delivery_rps_dated",
  ] as const
  if (
    input.ranges.length !== requiredRangeIds.length ||
    input.ranges.some((range, index) => range.rangeId !== requiredRangeIds[index])
  ) {
    throw new Error("Projected Delivery RPS plan requires exact Raw, Clean, and dated ranges.")
  }
  const writes = buildPlannedRangeWrites({
    artifactKey,
    dataProvenance: input.dataProvenance,
    ranges: input.ranges,
  })
  const desiredFingerprint = desiredPayloadFingerprint(artifactKey, writes, input.dataProvenance)
  const projectedPreimageFingerprint = createPiiFingerprint(
    writes.map(({ rangeId, a1Range, preimageFingerprint }) => ({
      rangeId,
      a1Range,
      preimageFingerprint,
    })),
    {
      context: "recops:staging:delivery_roles_rps:projected-preimage",
      dataProvenance: input.dataProvenance,
    }
  )
  const sourceGeneratedAt = new Date(input.sourceGeneratedAt).toISOString()
  const planFingerprint = createPiiFingerprint({
    schemaVersion: 1,
    artifactKey,
    runId: input.runId,
    sourceGeneratedAt,
    structure: input.structure,
    projectedPreimageFingerprint,
    desiredPayloadFingerprint: desiredFingerprint,
    mutationCallCount: 0,
  }, {
    context: "recops:staging:delivery_roles_rps:projected-plan",
    dataProvenance: input.dataProvenance,
  })
  return {
    kind: "projected_dry_run",
    artifactKey,
    runId: input.runId,
    sourceGeneratedAt,
    structure: input.structure,
    projectedPreimageFingerprint,
    desiredPayloadFingerprint: desiredFingerprint,
    planFingerprint,
    noOp: writes.every((write) => !write.changed),
    writes,
  }
}

function buildPlannedRangeWrites(input: {
  artifactKey: Exclude<StagingArtifactKey, "elt_doc">
  dataProvenance: PiiFingerprintProvenance
  ranges: BuildStagingSheetValuePlanInput["ranges"]
}): PlannedSheetRangeWrite[] {
  if (input.ranges.length === 0) throw new Error("Staging sheet plan requires at least one range.")
  const seenRangeIds = new Set<string>()
  const seenA1Ranges = new Set<string>()
  return input.ranges.map((range): PlannedSheetRangeWrite => {
    if (seenRangeIds.has(range.rangeId)) throw new Error(`Duplicate staging range contract: ${range.rangeId}`)
    if (seenA1Ranges.has(range.a1Range)) throw new Error(`Duplicate staging A1 range: ${range.a1Range}`)
    seenRangeIds.add(range.rangeId)
    seenA1Ranges.add(range.a1Range)
    assertRectangular(range.currentValues, `${range.rangeId}.currentValues`)
    assertRectangular(range.desiredValues, `${range.rangeId}.desiredValues`)
    const currentValues = normalizeMatrix(range.currentValues)
    const desiredValues = normalizeMatrix(range.desiredValues)
    const context = `recops:staging:${input.artifactKey}:${range.rangeId}`
    return {
      rangeId: range.rangeId,
      a1Range: requireA1Range(range.a1Range),
      values: desiredValues,
      preimageFingerprint: createPiiFingerprint(currentValues, {
        context: `${context}:preimage`,
        dataProvenance: input.dataProvenance,
      }),
      desiredFingerprint: createPiiFingerprint(desiredValues, {
        context: `${context}:desired`,
        dataProvenance: input.dataProvenance,
      }),
      changed: stableSerialize(currentValues) !== stableSerialize(desiredValues),
    }
  })
}

function desiredPayloadFingerprint(
  artifactKey: Exclude<StagingArtifactKey, "elt_doc">,
  writes: readonly PlannedSheetRangeWrite[],
  dataProvenance: PiiFingerprintProvenance
): string {
  return createPiiFingerprint(
    writes.map(({ rangeId, a1Range, desiredFingerprint }) => ({ rangeId, a1Range, desiredFingerprint })),
    { context: `recops:staging:${artifactKey}:payload`, dataProvenance }
  )
}

function assertProjectedStructureBasis(value: ProjectedStagingStructureBasis): void {
  if (
    value.kind !== "projected_post_normalization" ||
    !value.normalizationId.trim() ||
    !/^\d+$/.test(value.observedDriveVersion) ||
    ![
      value.normalizationFingerprint,
      value.observedStructureFingerprint,
      value.expectedAfterStateFingerprint,
      value.forwardRequestsFingerprint,
      value.rollbackRequestsFingerprint,
    ].every((fingerprint) => /^sha256:[0-9a-f]{64}$/.test(fingerprint))
  ) {
    throw new Error("Projected Delivery RPS structure basis is incomplete.")
  }
}

function normalizeMatrix(
  values: readonly (readonly SheetCellValue[])[]
): SheetCellValue[][] {
  return values.map((row) => row.map(normalizeStagingSheetScalar))
}

function requireA1Range(value: string): string {
  const range = value.trim()
  if (!/^'?(?:[^'!]|'')+'?![A-Z]+\d+(?::[A-Z]+\d+)?$/.test(range)) {
    throw new Error(`Staging value plan requires a bounded A1 range: ${value}`)
  }
  return range
}

function assertRectangular(values: readonly (readonly SheetCellValue[])[], field: string): void {
  if (values.length === 0) throw new Error(`${field} must contain at least one row.`)
  const width = values[0]?.length ?? 0
  if (width === 0 || values.some((row) => row.length !== width)) {
    throw new Error(`${field} must be a non-empty rectangular matrix.`)
  }
}
