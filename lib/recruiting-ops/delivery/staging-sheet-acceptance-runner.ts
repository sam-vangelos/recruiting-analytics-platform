import type { KillSwitchState } from "../autonomy"
import type { RecruiterTeamHodEntry } from "../dimensions/config/recruiter-team-hod.v1"
import type { StagingHydrationFacts } from "../delivery-source/staging-hydration-source-loader"
import { assertPublicSafe } from "../safe-public-output"
import {
  compareCanonicalParity,
  type ApprovedParityDivergence,
  type CanonicalParityReport,
  type CanonicalParitySurfaceInput,
  type ParityCellValue,
} from "./canonical-parity-comparison"
import { getCanonicalParityArtifact } from "./canonical-parity-registry"
import {
  readStagingSheetStructureSnapshot,
  writeStagingSheetValues,
  type GoogleWorkspaceStagingClients,
  type StagingSheetWriteSummary,
} from "./google-workspace-staging-client"
import {
  planStagingArtifactValues,
  type PlannedStagingArtifact,
  type StagingSheetArtifactKey,
} from "./staging-artifact-value-planner"
import { getStagingArtifact } from "./staging-artifact-registry"
import { createStagingSheetWritePermit } from "./staging-hydration-runner"
import { evaluateStagingKillSwitchStates } from "./staging-kill-switch"
import { expectedStagingSheetAcceptanceSurfaceIds } from "./staging-sheet-acceptance-surfaces"
import type { StagingSheetContractId } from "./staging-sheet-contracts"
import type { StagingSheetValuePlan } from "./staging-value-plan"
import { paceStagingSheetsRead } from "./staging-sheets-read-pacer"

export interface PinnedStagingSheetAcceptanceCut {
  facts: StagingHydrationFacts
  roster: readonly RecruiterTeamHodEntry[]
}

export interface CanonicalSheetParityRangeRequest {
  /** Derived from a private planned write; callers cannot select surfaces. */
  surfaceId: StagingSheetContractId
  copiedA1Range: string
  canonicalA1Range: string
  rowCount: number
  columnCount: number
}

export interface CanonicalSheetParityReadRequest {
  artifactKey: StagingSheetArtifactKey
  canonicalArtifactId: string
  readOnly: true
  ranges: readonly CanonicalSheetParityRangeRequest[]
}

export interface CanonicalSheetParityReadResult {
  canonicalArtifactId: string
  readOnly: true
  surfaces: readonly {
    surfaceId: StagingSheetContractId
    canonicalA1Range: string
    values: readonly (readonly ParityCellValue[])[]
  }[]
}

/** A deliberately read-only capability: no canonical writer is representable. */
export interface CanonicalSheetParityReadPort {
  readCanonicalRanges(input: CanonicalSheetParityReadRequest): Promise<CanonicalSheetParityReadResult>
}

export interface StagingSheetAcceptancePorts {
  clients: GoogleWorkspaceStagingClients
  loadPinnedCut(input: { artifactKey: StagingSheetArtifactKey }): Promise<PinnedStagingSheetAcceptanceCut>
  loadKillSwitchStates(): Promise<readonly KillSwitchState[]>
  canonical: CanonicalSheetParityReadPort
}

export type StagingSheetAcceptanceBlockCode =
  | "source_cut_unavailable"
  | "source_truncated"
  | "initial_plan_failed"
  | "initial_kill_switch_unavailable"
  | "initial_kill_switch_blocked"
  | "initial_copy_write_failed"
  | "copy_post_read_failed"
  | "canonical_unreadable"
  | "incomplete_range_coverage"
  | "parity_needs_investigation"
  | "rerun_plan_failed"
  | "rerun_contract_changed"
  | "rerun_kill_switch_unavailable"
  | "rerun_kill_switch_blocked"
  | "rerun_copy_write_failed"
  | "rerun_not_no_change"

export interface StagingSheetAcceptancePlanEvidence {
  rangeCount: number
  changedRangeCount: number
  rowCount: number
  payloadFingerprint: string
  structureFingerprint: string
  noOp: boolean
}

export interface StagingSheetAcceptanceWriteEvidence {
  status: StagingSheetWriteSummary["status"]
  changedRangeCount: number
  mutationCallCount: number
  beforeStructureFingerprint: string
  afterStructureFingerprint: string
  structureCertification: StagingSheetWriteSummary["structureCertification"]
  driveVersionChanged: boolean
  compensationAttempted: boolean
}

export interface StagingSheetAcceptanceStepEvidence {
  plan: StagingSheetAcceptancePlanEvidence
  write?: StagingSheetAcceptanceWriteEvidence
}

export interface StagingSheetAcceptanceOutcome {
  artifactKey: StagingSheetArtifactKey
  status: "accepted" | "blocked"
  blockCode?: StagingSheetAcceptanceBlockCode
  copyOnly: false
  canonicalWriteAuthorized: true
  sourceGeneratedAt: string | null
  reportingWeekFriday: string | null
  quarterStart: string | null
  sourceCounts?: {
    candidateEvents: number
    offers: number
    scorecards: number
    reqWeeks: number
    diagnostics: number
  }
  initial?: StagingSheetAcceptanceStepEvidence
  parity?: CanonicalParityReport
  rerun?: StagingSheetAcceptanceStepEvidence
}

export interface RunStagingSheetAcceptanceInput {
  /** Scalar by design: acceptance is never an all-artifact write. */
  artifactKey: StagingSheetArtifactKey
  fingerprintKey: string
  ports: StagingSheetAcceptancePorts
  env?: Readonly<Record<string, string | undefined>>
  nowMs?: number
  approvedDivergences?: Readonly<Partial<Record<StagingSheetContractId, ApprovedParityDivergence>>>
}

interface ExactCopiedParityRangeRead {
  requestedA1Range: string
  actualA1Range: string
  values: readonly (readonly ParityCellValue[])[]
}

class IncompleteRangeCoverageError extends Error {
  constructor() {
    super("Parity range coverage is incomplete.")
    this.name = "IncompleteRangeCoverageError"
  }
}

/**
 * Executes the complete copy-only Sheet acceptance sequence for exactly one
 * artifact and one pinned source cut:
 *
 *   complete canonical read and planned-value parity preflight -> guarded copy
 *   write -> copy post-read and classified parity -> exact same-cut guarded
 *   rerun with zero mutations.
 *
 * Private cells never enter the returned outcome. External errors are reduced
 * to stable block codes so a connector cannot leak canonical or recruiting
 * data through an exception message.
 */
export async function runStagingSheetAcceptance(
  input: RunStagingSheetAcceptanceInput
): Promise<StagingSheetAcceptanceOutcome> {
  const baseNowMs = input.nowMs ?? Date.now()
  const currentTimeMs = () => input.nowMs ?? Date.now()
  const runPrefix = `staging_acceptance_${new Date(baseNowMs).toISOString().replace(/[^0-9]/g, "")}`
  const base = {
    artifactKey: input.artifactKey,
    copyOnly: false as const,
    canonicalWriteAuthorized: true as const,
  }

  let cut: PinnedStagingSheetAcceptanceCut
  try {
    // This is intentionally the only source/roster load in the entire run.
    // Clone immediately so a mutable connector cache cannot change the facts
    // between the initial plan and the idempotency rerun.
    cut = structuredClone(await input.ports.loadPinnedCut({ artifactKey: input.artifactKey }))
  } catch {
    return publicOutcome({
      ...base,
      status: "blocked",
      blockCode: "source_cut_unavailable",
      sourceGeneratedAt: null,
      reportingWeekFriday: null,
      quarterStart: null,
    })
  }

  const sourceEvidence = sourceEvidenceOf(cut.facts)
  if (cut.facts.diagnostics.some((diagnostic) => diagnostic.truncationSuspected)) {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: "source_truncated",
    })
  }

  let initialPlanned: PlannedStagingArtifact
  try {
    initialPlanned = await planPinnedArtifact({
      artifactKey: input.artifactKey,
      runId: `${runPrefix}_initial`,
      cut,
      clients: input.ports.clients,
    })
    assertCompletePrivatePlan(initialPlanned.plan)
  } catch {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: "initial_plan_failed",
    })
  }
  const initial: StagingSheetAcceptanceStepEvidence = {
    plan: planEvidenceOf(initialPlanned),
  }

  // Prove the complete read-only baseline is available before touching the
  // copy. A missing canonical permission or surface must never be discovered
  // only after the initial copied-sheet mutation has already landed.
  const canonicalBaseline = getCanonicalParityArtifact(input.artifactKey)
  if (canonicalBaseline.kind !== "google_sheet" || canonicalBaseline.writeEligible !== false) {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: "incomplete_range_coverage",
      initial,
    })
  }
  let canonicalRequest: readonly CanonicalSheetParityRangeRequest[]
  try {
    canonicalRequest = buildCanonicalParityRangeRequests(initialPlanned.plan)
  } catch {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: "incomplete_range_coverage",
      initial,
    })
  }
  let canonicalRead: CanonicalSheetParityReadResult
  try {
    canonicalRead = await input.ports.canonical.readCanonicalRanges({
      artifactKey: input.artifactKey,
      canonicalArtifactId: canonicalBaseline.artifactId,
      readOnly: true,
      ranges: canonicalRequest,
    })
  } catch {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: "canonical_unreadable",
      initial,
    })
  }
  let prewriteParity: CanonicalParityReport
  try {
    // Reuse the complete-surface validator with the immutable planned values
    // standing in for the not-yet-written copy. This proves canonical ids,
    // A1 ranges, shapes, scalar values, and approved-divergence scope before
    // the first copied-sheet mutation.
    const surfaces = completeParitySurfaces({
      plan: initialPlanned.plan,
      copiedValues: initialPlanned.plan.writes.map((write) => ({
        requestedA1Range: write.a1Range,
        actualA1Range: write.a1Range,
        values: write.values,
      })),
      canonicalRead,
      expectedCanonicalArtifactId: canonicalBaseline.artifactId,
      approvedDivergences: input.approvedDivergences,
    })
    prewriteParity = compareCanonicalParity({
      artifactKey: input.artifactKey,
      fingerprintKey: input.fingerprintKey,
      surfaces,
    })
  } catch {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: "incomplete_range_coverage",
      initial,
    })
  }
  if (
    prewriteParity.surfaceCount !== initialPlanned.plan.writes.length ||
    prewriteParity.classificationCounts["needs-investigation"] > 0
  ) {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: "parity_needs_investigation",
      initial,
      parity: prewriteParity,
    })
  }

  const initialWrite = await guardedWrite({
    stage: "initial",
    artifactKey: input.artifactKey,
    planned: initialPlanned,
    issuedAtMs: currentTimeMs(),
    currentTimeMs,
    env: input.env,
    ports: input.ports,
  })
  if (!initialWrite.ok) {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: initialWrite.blockCode,
      initial,
    })
  }
  initial.write = writeEvidenceOf(initialWrite.write)
  if (!initialWriteMatchesPlan(initialPlanned.plan, initialWrite.write)) {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: "initial_copy_write_failed",
      initial,
    })
  }

  let copiedValues: readonly ExactCopiedParityRangeRead[]
  try {
    copiedValues = await readExactCopiedParityRanges({
      artifactKey: input.artifactKey,
      ranges: initialPlanned.plan.writes.map((write) => write.a1Range),
      clients: input.ports.clients,
    })
  } catch (error) {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: error instanceof IncompleteRangeCoverageError
        ? "incomplete_range_coverage"
        : "copy_post_read_failed",
      initial,
    })
  }

  let parity: CanonicalParityReport
  try {
    const surfaces = completeParitySurfaces({
      plan: initialPlanned.plan,
      copiedValues,
      canonicalRead,
      expectedCanonicalArtifactId: canonicalBaseline.artifactId,
      approvedDivergences: input.approvedDivergences,
    })
    parity = compareCanonicalParity({
      artifactKey: input.artifactKey,
      fingerprintKey: input.fingerprintKey,
      surfaces,
    })
  } catch {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: "incomplete_range_coverage",
      initial,
    })
  }
  if (
    parity.surfaceCount !== initialPlanned.plan.writes.length ||
    parity.classificationCounts["needs-investigation"] > 0
  ) {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: "parity_needs_investigation",
      initial,
      parity,
    })
  }

  let rerunPlanned: PlannedStagingArtifact
  try {
    rerunPlanned = await planPinnedArtifact({
      artifactKey: input.artifactKey,
      runId: `${runPrefix}_rerun`,
      cut,
      clients: input.ports.clients,
    })
    assertCompletePrivatePlan(rerunPlanned.plan)
  } catch {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: "rerun_plan_failed",
      initial,
      parity,
    })
  }
  const rerun: StagingSheetAcceptanceStepEvidence = { plan: planEvidenceOf(rerunPlanned) }
  if (!sameRerunContract(initialPlanned.plan, initialWrite.write, rerunPlanned.plan)) {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: "rerun_contract_changed",
      initial,
      parity,
      rerun,
    })
  }

  const rerunWrite = await guardedWrite({
    stage: "rerun",
    artifactKey: input.artifactKey,
    planned: rerunPlanned,
    issuedAtMs: currentTimeMs(),
    currentTimeMs,
    env: input.env,
    ports: input.ports,
  })
  if (!rerunWrite.ok) {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: rerunWrite.blockCode,
      initial,
      parity,
      rerun,
    })
  }
  rerun.write = writeEvidenceOf(rerunWrite.write)
  if (
    !writeMatchesPlan(rerunPlanned.plan, rerunWrite.write) ||
    rerunWrite.write.status !== "no_change" ||
    rerunWrite.write.mutationCallCount !== 0 ||
    rerunWrite.write.changedRangeCount !== 0
  ) {
    return publicOutcome({
      ...base,
      ...sourceEvidence,
      status: "blocked",
      blockCode: "rerun_not_no_change",
      initial,
      parity,
      rerun,
    })
  }

  return publicOutcome({
    ...base,
    ...sourceEvidence,
    status: "accepted",
    initial,
    parity,
    rerun,
  })
}

/** Always emits exactly one request for every private planned write. */
export function buildCanonicalParityRangeRequests(
  plan: StagingSheetValuePlan
): readonly CanonicalSheetParityRangeRequest[] {
  assertCompletePrivatePlan(plan)
  return plan.writes.map((write) => {
    const rangeShape = boundedA1Shape(write.a1Range)
    const rowCount = write.values.length
    const columnCount = write.values[0]?.length ?? 0
    if (rangeShape.rows !== rowCount || rangeShape.columns !== columnCount) {
      throw new Error("Planned values do not completely cover their bounded A1 range.")
    }
    return {
      surfaceId: write.rangeId,
      copiedA1Range: write.a1Range,
      canonicalA1Range: write.a1Range,
      rowCount,
      columnCount,
    }
  })
}

async function planPinnedArtifact(input: {
  artifactKey: StagingSheetArtifactKey
  runId: string
  cut: PinnedStagingSheetAcceptanceCut
  clients: GoogleWorkspaceStagingClients
}): Promise<PlannedStagingArtifact> {
  const structure = await readStagingSheetStructureSnapshot(input.artifactKey, input.clients)
  return planStagingArtifactValues({
    artifactKey: input.artifactKey,
    runId: input.runId,
    facts: input.cut.facts,
    roster: input.cut.roster,
    clients: input.clients,
    structure,
  })
}

async function guardedWrite(input: {
  stage: "initial" | "rerun"
  artifactKey: StagingSheetArtifactKey
  planned: PlannedStagingArtifact
  issuedAtMs: number
  currentTimeMs: () => number
  env?: Readonly<Record<string, string | undefined>>
  ports: StagingSheetAcceptancePorts
}): Promise<
  | { ok: true; write: StagingSheetWriteSummary }
  | { ok: false; blockCode: StagingSheetAcceptanceBlockCode }
> {
  let states: readonly KillSwitchState[]
  try {
    states = await input.ports.loadKillSwitchStates()
  } catch {
    return {
      ok: false,
      blockCode: input.stage === "initial"
        ? "initial_kill_switch_unavailable"
        : "rerun_kill_switch_unavailable",
    }
  }
  const killSwitch = evaluateStagingKillSwitchStates(
    input.artifactKey,
    states,
    input.issuedAtMs
  )
  if (!killSwitch.clear) {
    return {
      ok: false,
      blockCode: input.stage === "initial"
        ? "initial_kill_switch_blocked"
        : "rerun_kill_switch_blocked",
    }
  }
  const permit = createStagingSheetWritePermit({
    artifactKey: input.artifactKey,
    plan: input.planned.plan,
    runId: input.planned.plan.runId,
    issuedAtMs: input.issuedAtMs,
    killSwitch,
  })
  try {
    const write = await writeStagingSheetValues({
      plan: input.planned.plan,
      permit,
      clients: input.ports.clients,
      env: input.env,
      nowMs: input.issuedAtMs,
      currentTimeMs: input.currentTimeMs,
      revalidateKillSwitchClear: async ({ artifactKey, nowMs }) => {
        const freshStates = await input.ports.loadKillSwitchStates()
        const freshKillSwitch = evaluateStagingKillSwitchStates(artifactKey, freshStates, nowMs)
        if (!freshKillSwitch.clear) {
          throw new Error("Durable staging hydration kill switch blocks the mutation boundary.")
        }
      },
    })
    return { ok: true, write }
  } catch {
    return {
      ok: false,
      blockCode: input.stage === "initial"
        ? "initial_copy_write_failed"
        : "rerun_copy_write_failed",
    }
  }
}

async function readExactCopiedParityRanges(input: {
  artifactKey: StagingSheetArtifactKey
  ranges: readonly string[]
  clients: GoogleWorkspaceStagingClients
}): Promise<readonly ExactCopiedParityRangeRead[]> {
  const target = getStagingArtifact(input.artifactKey)
  if (target.kind !== "google_sheet" || input.ranges.length === 0) {
    throw new Error("Copied parity read requires one registered Sheet and bounded ranges.")
  }
  await paceStagingSheetsRead()
  const response = await input.clients.sheets.spreadsheets.values.batchGet({
    spreadsheetId: target.artifactId,
    ranges: [...input.ranges],
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
  })
  const returned = response.data.valueRanges ?? []
  if (returned.length !== input.ranges.length) {
    throw new IncompleteRangeCoverageError()
  }
  return input.ranges.map((requestedA1Range, index) => {
    const actualA1Range = returned[index]?.range?.trim()
    if (!actualA1Range || !sameA1Range(actualA1Range, requestedA1Range)) {
      throw new IncompleteRangeCoverageError()
    }
    return {
      requestedA1Range,
      actualA1Range,
      values: (returned[index]?.values ?? []).map((row) => row.map(parityCell)),
    }
  })
}

function completeParitySurfaces(input: {
  plan: StagingSheetValuePlan
  copiedValues: readonly ExactCopiedParityRangeRead[]
  canonicalRead: CanonicalSheetParityReadResult
  expectedCanonicalArtifactId: string
  approvedDivergences?: Readonly<Partial<Record<StagingSheetContractId, ApprovedParityDivergence>>>
}): CanonicalParitySurfaceInput[] {
  assertCompletePrivatePlan(input.plan)
  const expectedIds = input.plan.writes.map((write) => write.rangeId)
  const expectedSet = new Set(expectedIds)
  if (
    input.copiedValues.length !== input.plan.writes.length ||
    input.canonicalRead.readOnly !== true ||
    input.canonicalRead.canonicalArtifactId !== input.expectedCanonicalArtifactId ||
    input.canonicalRead.surfaces.length !== input.plan.writes.length
  ) {
    throw new Error("Incomplete parity range coverage.")
  }
  const canonicalById = new Map<StagingSheetContractId, CanonicalSheetParityReadResult["surfaces"][number]>()
  for (const surface of input.canonicalRead.surfaces) {
    if (!expectedSet.has(surface.surfaceId) || canonicalById.has(surface.surfaceId)) {
      throw new Error("Canonical parity returned an unknown or duplicate surface.")
    }
    canonicalById.set(surface.surfaceId, surface)
  }
  for (const approvedId of Object.keys(input.approvedDivergences ?? {})) {
    if (!expectedSet.has(approvedId as StagingSheetContractId)) {
      throw new Error("Approved parity divergence is outside the complete planned surface set.")
    }
  }

  return input.plan.writes.map((write, index) => {
    const canonical = canonicalById.get(write.rangeId)
    if (!canonical) throw new Error("Canonical parity omitted a planned surface.")
    const shape = { rows: write.values.length, columns: write.values[0]?.length ?? 0 }
    const copied = input.copiedValues[index]
    if (
      !sameA1Range(copied.requestedA1Range, write.a1Range) ||
      !sameA1Range(copied.actualA1Range, write.a1Range) ||
      !sameA1Range(canonical.canonicalA1Range, write.a1Range) ||
      !sameShape(boundedA1Shape(copied.actualA1Range), shape) ||
      !sameShape(boundedA1Shape(canonical.canonicalA1Range), shape)
    ) {
      throw new Error("Parity reader did not prove the exact planned range coverage.")
    }
    const approvedDivergence = input.approvedDivergences?.[write.rangeId]
    const start = parseBoundedA1(write.a1Range)
    return {
      surfaceId: write.rangeId,
      matrixStartCell: `${columnLabel(start.startColumn)}${start.startRow}`,
      canonical: { kind: "matrix", values: rectangularParityValues(canonical.values, shape) },
      copied: { kind: "matrix", values: rectangularParityValues(copied.values, shape) },
      platform: { kind: "matrix", values: rectangularParityValues(write.values, shape) },
      ...(approvedDivergence ? { approvedDivergence } : {}),
    }
  })
}

function rectangularParityValues(
  values: readonly (readonly ParityCellValue[])[],
  shape: { rows: number; columns: number }
): ParityCellValue[][] {
  if (
    shape.rows <= 0 ||
    shape.columns <= 0 ||
    values.length > shape.rows ||
    values.some((row) => row.length > shape.columns)
  ) {
    throw new Error("Parity matrix does not fit its complete planned range shape.")
  }
  return Array.from({ length: shape.rows }, (_, row) =>
    Array.from({ length: shape.columns }, (__, column) => parityCell(values[row]?.[column]))
  )
}

function parityCell(value: unknown): ParityCellValue {
  if (value === undefined || value === null || value === "") return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  throw new Error("Parity range contained a non-scalar or non-finite cell.")
}

function assertCompletePrivatePlan(plan: StagingSheetValuePlan): void {
  const expectedIds = expectedStagingSheetAcceptanceSurfaceIds(plan.artifactKey)
  const writeIds = plan.writes.map((write) => write.rangeId)
  if (
    plan.writes.length === 0 ||
    plan.writes.length !== expectedIds.length ||
    plan.approvedRangeIds.length !== plan.writes.length ||
    new Set(writeIds).size !== writeIds.length ||
    new Set(plan.approvedRangeIds).size !== plan.approvedRangeIds.length ||
    writeIds.some(
      (id, index) => id !== plan.approvedRangeIds[index] || id !== expectedIds[index]
    )
  ) {
    throw new Error("Private staging plan does not completely bind every planned range.")
  }
}

function sameRerunContract(
  initial: StagingSheetValuePlan,
  initialWrite: StagingSheetWriteSummary,
  rerun: StagingSheetValuePlan
): boolean {
  const expectedRerunStructureHash = initialWrite.structureCertification === "value_coupled_auto_link"
    ? initialWrite.afterStructureHash
    : initial.structureHash
  if (
    rerun.artifactKey !== initial.artifactKey ||
    !rerun.noOp ||
    rerun.writes.some((write) => write.changed) ||
    rerun.payloadFingerprint !== initial.payloadFingerprint ||
    rerun.structureHash !== expectedRerunStructureHash ||
    rerun.sourceGeneratedAt !== initial.sourceGeneratedAt ||
    rerun.writes.length !== initial.writes.length
  ) {
    return false
  }
  return rerun.writes.every((write, index) => {
    const first = initial.writes[index]
    return (
      write.rangeId === first.rangeId &&
      write.a1Range === first.a1Range &&
      write.desiredFingerprint === first.desiredFingerprint
    )
  })
}

function initialWriteMatchesPlan(plan: StagingSheetValuePlan, write: StagingSheetWriteSummary): boolean {
  return writeMatchesPlan(plan, write)
}

function writeMatchesPlan(plan: StagingSheetValuePlan, write: StagingSheetWriteSummary): boolean {
  const expectedChanged = plan.writes.filter((range) => range.changed).length
  const structureCertified =
    write.afterStructureHash === plan.structureHash
      ? write.structureCertification === "exact"
      : !plan.noOp &&
        write.status === "written" &&
        write.structureCertification === "value_coupled_auto_link"
  if (
    write.artifactKey !== plan.artifactKey ||
    write.runId !== plan.runId ||
    write.changedRangeCount !== expectedChanged ||
    write.beforeStructureHash !== plan.structureHash ||
    !structureCertified ||
    write.compensationAttempted
  ) {
    return false
  }
  return plan.noOp
    ? write.status === "no_change" && write.mutationCallCount === 0
    : write.status === "written" && write.mutationCallCount === 1
}

function boundedA1Shape(range: string): { rows: number; columns: number } {
  const parsed = parseBoundedA1(range)
  return {
    rows: parsed.endRow - parsed.startRow + 1,
    columns: parsed.endColumn - parsed.startColumn + 1,
  }
}

function sameA1Range(left: string, right: string): boolean {
  const a = parseBoundedA1(left)
  const b = parseBoundedA1(right)
  return (
    a.sheetTitle === b.sheetTitle &&
    a.startColumn === b.startColumn &&
    a.startRow === b.startRow &&
    a.endColumn === b.endColumn &&
    a.endRow === b.endRow
  )
}

function sameShape(
  left: { rows: number; columns: number },
  right: { rows: number; columns: number }
): boolean {
  return left.rows === right.rows && left.columns === right.columns
}

function parseBoundedA1(range: string): {
  sheetTitle: string
  startColumn: number
  startRow: number
  endColumn: number
  endRow: number
} {
  const separator = range.lastIndexOf("!")
  if (separator <= 0) throw new Error("Parity requires a sheet-qualified bounded A1 range.")
  const rawTitle = range.slice(0, separator).trim()
  const sheetTitle = rawTitle.startsWith("'")
    ? unquoteSheetTitle(rawTitle)
    : rawTitle
  const coordinates = range.slice(separator + 1).replaceAll("$", "").toUpperCase()
  const match = coordinates.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/)
  if (!sheetTitle || !match) throw new Error("Parity requires an exact bounded A1 range.")
  const startColumn = columnIndex(match[1])
  const startRow = Number(match[2])
  const endColumn = columnIndex(match[3] ?? match[1])
  const endRow = Number(match[4] ?? match[2])
  if (
    !Number.isSafeInteger(startRow) ||
    !Number.isSafeInteger(endRow) ||
    startRow <= 0 ||
    endRow < startRow ||
    endColumn < startColumn
  ) {
    throw new Error("Parity A1 range bounds are invalid or reversed.")
  }
  return { sheetTitle, startColumn, startRow, endColumn, endRow }
}

function unquoteSheetTitle(value: string): string {
  if (value.length < 2 || !value.endsWith("'")) {
    throw new Error("Parity A1 range has a malformed quoted sheet title.")
  }
  return value.slice(1, -1).replaceAll("''", "'")
}

function columnIndex(label: string): number {
  let index = 0
  for (const character of label) index = index * 26 + character.charCodeAt(0) - 64
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

function sourceEvidenceOf(facts: StagingHydrationFacts): Pick<
  StagingSheetAcceptanceOutcome,
  "sourceGeneratedAt" | "reportingWeekFriday" | "quarterStart" | "sourceCounts"
> {
  return {
    sourceGeneratedAt: validIsoOrNull(facts.generatedAt),
    reportingWeekFriday: facts.reportingWeekFriday,
    quarterStart: facts.quarterStart,
    sourceCounts: {
      candidateEvents: facts.candidateEvents.length,
      offers: facts.offers.length,
      scorecards: facts.scorecards.length,
      reqWeeks: facts.reqWeeks.length,
      diagnostics: facts.diagnostics.length,
    },
  }
}

function planEvidenceOf(planned: PlannedStagingArtifact): StagingSheetAcceptancePlanEvidence {
  return {
    rangeCount: planned.plan.writes.length,
    changedRangeCount: planned.plan.writes.filter((write) => write.changed).length,
    rowCount: planned.plan.writes.reduce((total, write) => total + write.values.length, 0),
    payloadFingerprint: planned.plan.payloadFingerprint,
    structureFingerprint: planned.plan.structureHash,
    noOp: planned.plan.noOp,
  }
}

function writeEvidenceOf(write: StagingSheetWriteSummary): StagingSheetAcceptanceWriteEvidence {
  return {
    status: write.status,
    changedRangeCount: write.changedRangeCount,
    mutationCallCount: write.mutationCallCount,
    beforeStructureFingerprint: write.beforeStructureHash,
    afterStructureFingerprint: write.afterStructureHash,
    structureCertification: write.structureCertification,
    driveVersionChanged: write.beforeDriveVersion !== write.afterDriveVersion,
    compensationAttempted: write.compensationAttempted,
  }
}

function publicOutcome(outcome: StagingSheetAcceptanceOutcome): StagingSheetAcceptanceOutcome {
  assertPublicSafe(outcome, "stagingSheetAcceptance.publicOutcome")
  return outcome
}

function validIsoOrNull(value: string): string | null {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}
