import { createPseudonymousFingerprint, stableSerialize } from "../checksums"
import { getCanonicalParityArtifact } from "./canonical-parity-registry"
import type { StagingArtifactKey } from "./staging-artifact-registry"

export type ParityCellValue = string | number | boolean | null

export const CANONICAL_PARITY_MATRIX_EVIDENCE_LIMIT = 512

export type CanonicalParityClassification =
  | "exact-match"
  | "platform-correct"
  | "legacy-error"
  | "needs-investigation"

export type CanonicalParityPayload =
  | {
      kind: "matrix"
      values: readonly (readonly ParityCellValue[])[]
    }
  | {
      kind: "doc_text"
      text: string
    }

export interface ApprovedParityDivergence {
  /**
   * A copied/platform result may only be called correct when a separate review
   * has already adjudicated the canonical divergence. The evidence is carried
   * by fingerprint so this report never needs to retain a private example.
   */
  classification: "platform-correct" | "legacy-error"
  evidenceFingerprint: string
}

export interface CanonicalParitySurfaceInput {
  /** Stable, non-PII contract id such as `data_dump_a_r` or `elt_body`. */
  surfaceId: string
  /** Required absolute origin for matrix coordinates; document surfaces must omit it. */
  matrixStartCell?: string
  canonical: CanonicalParityPayload
  copied: CanonicalParityPayload
  platform: CanonicalParityPayload
  approvedDivergence?: ApprovedParityDivergence
}

export interface CanonicalParityComparisonInput {
  artifactKey: StagingArtifactKey
  /** Inject the live PII fingerprint secret at the caller boundary. It is never returned. */
  fingerprintKey: string
  surfaces: readonly CanonicalParitySurfaceInput[]
}

export interface ParityMatrixCounts {
  kind: "matrix"
  rowCount: number
  columnCount: number
  cellCount: number
}

export interface ParityDocCounts {
  kind: "doc_text"
  lineCount: number
  characterCount: number
}

export type ParityPayloadCounts = ParityMatrixCounts | ParityDocCounts

export type ParityMatrixValueCategory = "missing" | "null" | "string" | "number" | "boolean"

export interface CanonicalParityMatrixMismatchEvidence {
  surfaceId: string
  coordinate: string
  beforeCategory: ParityMatrixValueCategory
  afterCategory: ParityMatrixValueCategory
  beforeFingerprint: string
  afterFingerprint: string
}

export interface CanonicalParityMatrixEvidenceReport {
  comparison: "canonical-to-platform"
  limit: number
  totalMismatchCount: number
  returnedMismatchCount: number
  truncated: boolean
  entries: readonly CanonicalParityMatrixMismatchEvidence[]
}

export interface CanonicalParitySurfaceReport {
  surfaceId: string
  kind: CanonicalParityPayload["kind"]
  classification: CanonicalParityClassification
  canonicalFingerprint: string
  copiedFingerprint: string
  platformFingerprint: string
  divergenceEvidenceFingerprint: string | null
  counts: {
    canonical: ParityPayloadCounts
    copied: ParityPayloadCounts
    platform: ParityPayloadCounts
  }
  mismatchCounts: {
    canonicalToCopied: number
    canonicalToPlatform: number
    copiedToPlatform: number
  }
}

export interface CanonicalParityReport {
  artifactKey: StagingArtifactKey
  readOnly: true
  canonicalWriteAuthorized: false
  surfaceCount: number
  classificationCounts: Record<CanonicalParityClassification, number>
  surfaces: readonly CanonicalParitySurfaceReport[]
  matrixMismatchEvidence: CanonicalParityMatrixEvidenceReport
}

/**
 * Pure, in-memory comparison over values that a caller has already read. The
 * returned report contains classifications, counts, coordinates, typed value
 * categories, and contextual HMACs only; it never echoes or persists matrix
 * cells or document text. Matrix coordinate evidence is bounded across the
 * whole report and incomplete evidence cannot support an approved divergence.
 *
 * `platform-correct` and `legacy-error` fail closed: copied output must equal
 * the platform output, must differ from the manual baseline, and must carry a
 * separately approved evidence fingerprint. Unadjudicated drift is always
 * `needs-investigation`.
 */
export function compareCanonicalParity(input: CanonicalParityComparisonInput): CanonicalParityReport {
  if (!input.fingerprintKey.trim()) throw new Error("Canonical parity fingerprint key is required.")
  if (input.surfaces.length === 0) throw new Error("Canonical parity comparison requires at least one surface.")

  const baseline = getCanonicalParityArtifact(input.artifactKey)
  const expectedPayloadKind: CanonicalParityPayload["kind"] =
    baseline.kind === "google_doc" ? "doc_text" : "matrix"
  const seenSurfaceIds = new Set<string>()
  let remainingEvidence = CANONICAL_PARITY_MATRIX_EVIDENCE_LIMIT
  const compared = input.surfaces.map((surface) => {
    requireSurfaceId(surface.surfaceId)
    if (seenSurfaceIds.has(surface.surfaceId)) {
      throw new Error(`Duplicate canonical parity surface id: ${surface.surfaceId}`)
    }
    seenSurfaceIds.add(surface.surfaceId)
    if (surface.canonical.kind !== expectedPayloadKind) {
      throw new Error(
        `Canonical parity surface ${surface.surfaceId} must use ${expectedPayloadKind} for ${baseline.kind}.`
      )
    }
    const result = compareSurface(input.artifactKey, input.fingerprintKey, surface, remainingEvidence)
    remainingEvidence -= result.matrixMismatchEvidence.length
    return result
  })
  const surfaces = compared.map((result) => result.report)
  const matrixMismatchEntries = compared.flatMap((result) => result.matrixMismatchEvidence)
  const matrixMismatchCount = compared.reduce(
    (total, result) => total + result.matrixMismatchCount,
    0
  )

  const classificationCounts = emptyClassificationCounts()
  for (const surface of surfaces) classificationCounts[surface.classification] += 1

  return {
    artifactKey: input.artifactKey,
    readOnly: true,
    canonicalWriteAuthorized: false,
    surfaceCount: surfaces.length,
    classificationCounts,
    surfaces,
    matrixMismatchEvidence: {
      comparison: "canonical-to-platform",
      limit: CANONICAL_PARITY_MATRIX_EVIDENCE_LIMIT,
      totalMismatchCount: matrixMismatchCount,
      returnedMismatchCount: matrixMismatchEntries.length,
      truncated: matrixMismatchEntries.length !== matrixMismatchCount,
      entries: matrixMismatchEntries,
    },
  }
}

interface ComparedSurface {
  report: CanonicalParitySurfaceReport
  matrixMismatchCount: number
  matrixMismatchEvidence: readonly CanonicalParityMatrixMismatchEvidence[]
}

function compareSurface(
  artifactKey: StagingArtifactKey,
  fingerprintKey: string,
  input: CanonicalParitySurfaceInput,
  evidenceLimit: number
): ComparedSurface {
  if (input.canonical.kind !== input.copied.kind || input.canonical.kind !== input.platform.kind) {
    throw new Error(`Canonical parity surface ${input.surfaceId} mixes payload kinds.`)
  }
  if (input.matrixStartCell && input.canonical.kind !== "matrix") {
    throw new Error(`Canonical parity surface ${input.surfaceId} has a matrix origin for a non-matrix payload.`)
  }
  if (input.approvedDivergence && !isStrictFingerprint(input.approvedDivergence.evidenceFingerprint)) {
    throw new Error(`Canonical parity surface ${input.surfaceId} has a malformed evidence fingerprint.`)
  }

  const canonical = normalizedPayload(input.canonical, input.surfaceId, "canonical")
  const copied = normalizedPayload(input.copied, input.surfaceId, "copied")
  const platform = normalizedPayload(input.platform, input.surfaceId, "platform")
  const canonicalSerialized = stableSerialize(canonical)
  const copiedSerialized = stableSerialize(copied)
  const platformSerialized = stableSerialize(platform)
  const copiedMatchesCanonical = copiedSerialized === canonicalSerialized
  const copiedMatchesPlatform = copiedSerialized === platformSerialized
  const platformMatchesCanonical = platformSerialized === canonicalSerialized
  const matrixEvidence =
    canonical.kind === "matrix" && platform.kind === "matrix"
      ? compareMatrixCoordinates({
          artifactKey,
          surfaceId: input.surfaceId,
          fingerprintKey,
          startCell: requireMatrixStartCell(input),
          before: canonical.values,
          after: platform.values,
          limit: evidenceLimit,
        })
      : { totalMismatchCount: 0, entries: [] }
  const classification = classify({
    copiedMatchesCanonical,
    copiedMatchesPlatform,
    platformMatchesCanonical,
    approvedDivergence: input.approvedDivergence,
    coordinateEvidenceComplete:
      canonical.kind !== "matrix" ||
      matrixEvidence.entries.length === matrixEvidence.totalMismatchCount,
  })
  const context = `recops:canonical-parity:${artifactKey}:${input.surfaceId}:${input.canonical.kind}`
  const fingerprint = (value: CanonicalParityPayload): string =>
    createPseudonymousFingerprint(value, { key: fingerprintKey, context })

  return {
    report: {
      surfaceId: input.surfaceId,
      kind: input.canonical.kind,
      classification,
      canonicalFingerprint: fingerprint(canonical),
      copiedFingerprint: fingerprint(copied),
      platformFingerprint: fingerprint(platform),
      divergenceEvidenceFingerprint: input.approvedDivergence?.evidenceFingerprint ?? null,
      counts: {
        canonical: payloadCounts(canonical),
        copied: payloadCounts(copied),
        platform: payloadCounts(platform),
      },
      mismatchCounts: {
        canonicalToCopied: mismatchCount(canonical, copied),
        canonicalToPlatform:
          canonical.kind === "matrix"
            ? matrixEvidence.totalMismatchCount
            : mismatchCount(canonical, platform),
        copiedToPlatform: mismatchCount(copied, platform),
      },
    },
    matrixMismatchCount: matrixEvidence.totalMismatchCount,
    matrixMismatchEvidence: matrixEvidence.entries,
  }
}

function classify(input: {
  copiedMatchesCanonical: boolean
  copiedMatchesPlatform: boolean
  platformMatchesCanonical: boolean
  approvedDivergence?: ApprovedParityDivergence
  coordinateEvidenceComplete: boolean
}): CanonicalParityClassification {
  if (input.copiedMatchesCanonical && input.copiedMatchesPlatform && input.platformMatchesCanonical) {
    return "exact-match"
  }
  if (
    input.copiedMatchesPlatform &&
    !input.copiedMatchesCanonical &&
    !input.platformMatchesCanonical &&
    input.approvedDivergence &&
    input.coordinateEvidenceComplete
  ) {
    return input.approvedDivergence.classification
  }
  return "needs-investigation"
}

function normalizedPayload(
  payload: CanonicalParityPayload,
  surfaceId: string,
  source: "canonical" | "copied" | "platform"
): CanonicalParityPayload {
  if (payload.kind === "doc_text") return { kind: "doc_text", text: payload.text }
  const width = payload.values[0]?.length ?? 0
  if (payload.values.length === 0 || width === 0) {
    throw new Error(`Canonical parity ${surfaceId}.${source} matrix must contain at least one cell.`)
  }
  if (payload.values.some((row) => row.length !== width)) {
    throw new Error(`Canonical parity ${surfaceId}.${source} matrix must be rectangular.`)
  }
  for (const row of payload.values) {
    for (const value of row) {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error(`Canonical parity ${surfaceId}.${source} matrix contains a non-finite number.`)
      }
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(`Canonical parity ${surfaceId}.${source} matrix contains a non-scalar value.`)
      }
    }
  }
  return { kind: "matrix", values: payload.values.map((row) => [...row]) }
}

function requireMatrixStartCell(input: CanonicalParitySurfaceInput): string {
  if (!input.matrixStartCell) {
    throw new Error(`Canonical parity surface ${input.surfaceId} requires an exact matrix origin.`)
  }
  return input.matrixStartCell
}

function compareMatrixCoordinates(input: {
  artifactKey: StagingArtifactKey
  surfaceId: string
  fingerprintKey: string
  startCell: string
  before: readonly (readonly ParityCellValue[])[]
  after: readonly (readonly ParityCellValue[])[]
  limit: number
}): {
  totalMismatchCount: number
  entries: CanonicalParityMatrixMismatchEvidence[]
} {
  const origin = parseMatrixStartCell(input.startCell)
  const height = Math.max(input.before.length, input.after.length)
  const width = Math.max(input.before[0]?.length ?? 0, input.after[0]?.length ?? 0)
  let totalMismatchCount = 0
  const entries: CanonicalParityMatrixMismatchEvidence[] = []
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const before = matrixValueAt(input.before, row, column)
      const after = matrixValueAt(input.after, row, column)
      if (stableSerialize(before) === stableSerialize(after)) continue
      totalMismatchCount += 1
      if (entries.length >= input.limit) continue
      const coordinate = matrixCoordinate(origin, row, column)
      const context =
        `recops:canonical-parity-coordinate:${input.artifactKey}:${input.surfaceId}:` +
        `${coordinate}:canonical-to-platform`
      const fingerprint = (value: MatrixValueAt): string =>
        createPseudonymousFingerprint(value, { key: input.fingerprintKey, context })
      entries.push({
        surfaceId: input.surfaceId,
        coordinate,
        beforeCategory: before.category,
        afterCategory: after.category,
        beforeFingerprint: fingerprint(before),
        afterFingerprint: fingerprint(after),
      })
    }
  }
  return { totalMismatchCount, entries }
}

type MatrixValueAt =
  | { category: "missing" }
  | { category: Exclude<ParityMatrixValueCategory, "missing">; value: ParityCellValue }

function matrixValueAt(
  values: readonly (readonly ParityCellValue[])[],
  row: number,
  column: number
): MatrixValueAt {
  if (row >= values.length || column >= (values[row]?.length ?? 0)) return { category: "missing" }
  const value = values[row]?.[column]
  if (value === null) return { category: "null", value }
  if (typeof value === "string") return { category: "string", value }
  if (typeof value === "number") return { category: "number", value }
  if (typeof value === "boolean") return { category: "boolean", value }
  throw new Error("Canonical parity matrix contains an unsupported value.")
}

function parseMatrixStartCell(value: string): { column: number; row: number } {
  const match = value.match(/^([A-Z]+)([1-9]\d*)$/)
  if (!match) throw new Error("Canonical parity matrix origin must be an absolute A1 cell coordinate.")
  const row = Number(match[2])
  const column = columnIndex(match[1])
  if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column)) {
    throw new Error("Canonical parity matrix origin exceeds safe coordinate bounds.")
  }
  return { column, row }
}

function matrixCoordinate(
  origin: { column: number; row: number },
  rowOffset: number,
  columnOffset: number
): string {
  const row = origin.row + rowOffset
  const column = origin.column + columnOffset
  if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column)) {
    throw new Error("Canonical parity matrix evidence exceeds safe coordinate bounds.")
  }
  return `${columnLabel(column)}${row}`
}

function columnIndex(label: string): number {
  let index = 0
  for (const character of label) {
    index = index * 26 + character.charCodeAt(0) - 64
    if (!Number.isSafeInteger(index)) {
      throw new Error("Canonical parity matrix origin exceeds safe coordinate bounds.")
    }
  }
  return index - 1
}

function columnLabel(index: number): string {
  let remaining = index + 1
  let label = ""
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    remaining = Math.floor((remaining - 1) / 26)
  }
  return label
}

function payloadCounts(payload: CanonicalParityPayload): ParityPayloadCounts {
  if (payload.kind === "matrix") {
    const rowCount = payload.values.length
    const columnCount = payload.values[0]?.length ?? 0
    return { kind: "matrix", rowCount, columnCount, cellCount: rowCount * columnCount }
  }
  return {
    kind: "doc_text",
    lineCount: payload.text.length === 0 ? 0 : payload.text.split(/\r\n|\r|\n/).length,
    characterCount: Array.from(payload.text).length,
  }
}

function mismatchCount(left: CanonicalParityPayload, right: CanonicalParityPayload): number {
  if (left.kind !== right.kind) throw new Error("Cannot count parity mismatches across payload kinds.")
  if (left.kind === "doc_text" && right.kind === "doc_text") {
    return positionalMismatchCount(Array.from(left.text), Array.from(right.text))
  }
  if (left.kind === "matrix" && right.kind === "matrix") {
    const height = Math.max(left.values.length, right.values.length)
    const width = Math.max(left.values[0]?.length ?? 0, right.values[0]?.length ?? 0)
    let mismatches = 0
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const leftPresent = row < left.values.length && column < (left.values[row]?.length ?? 0)
        const rightPresent = row < right.values.length && column < (right.values[row]?.length ?? 0)
        if (!leftPresent || !rightPresent) {
          if (leftPresent !== rightPresent) mismatches += 1
          continue
        }
        if (stableSerialize(left.values[row]?.[column]) !== stableSerialize(right.values[row]?.[column])) {
          mismatches += 1
        }
      }
    }
    return mismatches
  }
  throw new Error("Cannot count parity mismatches across payload kinds.")
}

function positionalMismatchCount(left: readonly string[], right: readonly string[]): number {
  const length = Math.max(left.length, right.length)
  let mismatches = 0
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) mismatches += 1
  }
  return mismatches
}

function requireSurfaceId(value: string): void {
  if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error(`Canonical parity surface id must be a stable non-PII contract id: ${value}`)
  }
}

function isStrictFingerprint(value: string): boolean {
  return /^(?:sha256|hmac-sha256):[a-f0-9]{64}$/.test(value)
}

function emptyClassificationCounts(): Record<CanonicalParityClassification, number> {
  return {
    "exact-match": 0,
    "platform-correct": 0,
    "legacy-error": 0,
    "needs-investigation": 0,
  }
}
