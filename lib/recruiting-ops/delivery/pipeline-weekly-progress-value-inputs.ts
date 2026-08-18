import { fridayWeekLabels } from "../exec-definitions"
import type { CandidateStageEventRow } from "../delivery-source/candidate-stage-events"
import type { OfferLifecycleExportRow } from "../delivery-source/offer-lifecycle-export"
import type { ScorecardSubmissionRow } from "../delivery-source/scorecard-submission"
import type { BoundedStagingValueRangeInput } from "./bounded-value-plan-inputs"
import {
  pipelineRenderContracts,
  renderPipelineCandidateRows,
  renderPipelineJobWeekRows,
  type PipelineArtifactKey,
} from "./pipeline-sheet-renderer"
import {
  assertExactHeaders,
  getStagingSheetContract,
  type StagingSheetRangeContract,
  type StagingSheetContractId,
} from "./staging-sheet-contracts"
import type {
  SheetCellValue,
} from "./staging-value-plan"
import {
  renderWeeklyProgressValues,
  type WeeklyProgressRoleBucket,
} from "./weekly-progress-renderer"

export type SheetValueMatrix = readonly (readonly SheetCellValue[])[]

export interface NormalizedSheetMatrixTarget {
  /** Exact title of the already-normalized target tab. */
  sheetTitle: string
  /** Current tab values, starting at A1. Ragged trailing blank cells are allowed. */
  currentMatrix: SheetValueMatrix
}

export interface WeeklyProgressMatrixTarget extends NormalizedSheetMatrixTarget {
  /** Exact visible current-week header already present in row 1. */
  weekHeader: string
}

export const pipelineRangeContractIds = {
  pipeline_890: {
    candidate: "pipeline_890_candidate",
    jobWeek: "pipeline_890_job_week",
  },
  pipeline_907: {
    candidate: "pipeline_907_candidate",
    jobWeek: "pipeline_907_job_week",
  },
  pipeline_1026_1027: {
    candidate: "pipeline_1026_1027_candidate",
    jobWeek: "pipeline_1026_1027_job_week",
  },
  pipeline_1118_1119: {
    candidate: "pipeline_1118_1119_candidate",
    jobWeek: "pipeline_1118_1119_job_week",
  },
} as const satisfies Readonly<
  Record<
    PipelineArtifactKey,
    { candidate: StagingSheetContractId; jobWeek: StagingSheetContractId }
  >
>

const WEEKLY_PROGRESS_RANGE_IDS = {
  code_rl: "weekly_progress_code_rl",
  fde_pe: "weekly_progress_fde_pe",
  brazil_colombia: "weekly_progress_brazil_colombia",
} as const satisfies Readonly<Record<WeeklyProgressRoleBucket, StagingSheetContractId>>

const WEEKLY_PROGRESS_TARGET_ORDER = [
  "code_rl",
  "fde_pe",
  "brazil_colombia",
] as const satisfies readonly WeeklyProgressRoleBucket[]

const CANDIDATE_TAB_TITLE =
  /^Candidate Level Data - (?:0?[1-9]|[12]\d|3[01]) (?:January|February|March|April|May|June|July|August|September|October|November|December)$/

/**
 * Builds the two exact bounded range inputs for one pipeline copy:
 * - candidate tab: complete current-week replacement, padded to clear stale rows;
 * - job-week summary: preserve every manual snapshot block, append a new
 *   platform block when the latest matching block differs, and no-op an
 *   identical rerun against the latest complete matching block.
 */
export function buildPipelineStagingValuePlanRanges(input: {
  artifactKey: PipelineArtifactKey
  reportingWeekFriday: string
  candidateEvents: readonly CandidateStageEventRow[]
  jobOpenDateByReq?: ReadonlyMap<string, string | null>
  candidateTarget: NormalizedSheetMatrixTarget
  jobWeekTarget: NormalizedSheetMatrixTarget
}): BoundedStagingValueRangeInput[] {
  assertFriday(input.reportingWeekFriday)
  const ids = pipelineRangeContractIds[input.artifactKey]
  const allowedRequisitionIds = new Set(pipelineRenderContracts[input.artifactKey].requisitionIds)
  const candidateRows = renderPipelineCandidateRows({
    artifactKey: input.artifactKey,
    reportingWeekFriday: input.reportingWeekFriday,
    rows: input.candidateEvents,
  })
  const jobWeekRows = renderPipelineJobWeekRows({
    artifactKey: input.artifactKey,
    reportingWeekFriday: input.reportingWeekFriday,
    rows: input.candidateEvents,
    jobOpenDateByReq: input.jobOpenDateByReq,
  }).map((row) => [...row.cells])

  return [
    candidateReplacementRange({
      rangeId: ids.candidate,
      reportingWeekFriday: input.reportingWeekFriday,
      target: input.candidateTarget,
      desiredRows: candidateRows,
      allowedRequisitionIds,
    }),
    buildPipelineJobWeekStagingValuePlanRange({
      artifactKey: input.artifactKey,
      target: input.jobWeekTarget,
      desiredRows: jobWeekRows,
    }),
  ]
}

/** Shared observed-state target selection for summary formatting and bounded values. */
export function buildPipelineJobWeekStagingValuePlanRange(input: {
  artifactKey: PipelineArtifactKey
  target: NormalizedSheetMatrixTarget
  desiredRows: readonly (readonly SheetCellValue[])[]
}): BoundedStagingValueRangeInput {
  return jobWeekUpsertRange({
    rangeId: pipelineRangeContractIds[input.artifactKey].jobWeek,
    target: input.target,
    desiredRows: input.desiredRows,
    allowedRequisitionIds: new Set(
      pipelineRenderContracts[input.artifactKey].requisitionIds
    ),
  })
}

/** Exact one-column current-week inputs for all three Weekly Progress tabs. */
export function buildWeeklyProgressStagingValuePlanRanges(input: {
  reportingWeekFriday: string
  candidateEvents: readonly CandidateStageEventRow[]
  offers: readonly OfferLifecycleExportRow[]
  scorecards: readonly ScorecardSubmissionRow[]
  targets: Readonly<Record<WeeklyProgressRoleBucket, WeeklyProgressMatrixTarget>>
}): BoundedStagingValueRangeInput[] {
  assertFriday(input.reportingWeekFriday)
  return WEEKLY_PROGRESS_TARGET_ORDER.map((bucket) => {
    const rangeId = WEEKLY_PROGRESS_RANGE_IDS[bucket]
    const contract = getStagingSheetContract(rangeId)
    const target = input.targets[bucket]
    assertExactStaticTitle(target.sheetTitle, contract.sheetTitle, rangeId)
    const rendered = renderWeeklyProgressValues({
      bucket,
      reportingWeekFriday: input.reportingWeekFriday,
      candidateEvents: input.candidateEvents,
      offers: input.offers,
      scorecards: input.scorecards,
    })
    if (!sameStrings(rendered.rowLabels, contract.headers)) {
      throw new Error(`${rangeId} renderer row labels drifted from the sheet contract.`)
    }
    if (target.currentMatrix.length === 0) {
      throw new Error(`${rangeId} current matrix is missing row 1.`)
    }
    const weekHeader = target.weekHeader.trim()
    if (!weekHeader) throw new Error(`${rangeId} current-week header is required.`)
    assertWeekHeaderMatches(rangeId, weekHeader, input.reportingWeekFriday)
    const weekColumns = (target.currentMatrix[0] ?? [])
      .map((value, index) => ({ value: headerText(value), index }))
      .filter((cell) => weekHeaderIdentifiesReportingWeek(cell.value, input.reportingWeekFriday))
    if (weekColumns.length !== 1 || weekColumns[0].index === 0) {
      throw new Error(`${rangeId} current-week header is missing or ambiguous.`)
    }

    const rowIndices = rendered.rowLabels.map((label) => {
      const matches: number[] = []
      for (let index = 1; index < target.currentMatrix.length; index += 1) {
        if (headerText(target.currentMatrix[index]?.[0]) === label) matches.push(index)
      }
      if (matches.length !== 1) {
        throw new Error(`${rangeId} stage row ${label} is missing or ambiguous.`)
      }
      return matches[0]
    })
    const firstRowIndex = rowIndices[0]
    if (rowIndices.some((rowIndex, offset) => rowIndex !== firstRowIndex + offset)) {
      throw new Error(`${rangeId} stage rows are not one normalized contiguous block.`)
    }
    if (rendered.values.some((row) => row.length !== 1)) {
      throw new Error(`${rangeId} renderer must emit exactly one value per stage row.`)
    }

    const columnIndex = weekColumns[0].index
    const currentValues = rowIndices.map((rowIndex) => [
      cellAt(target.currentMatrix, rowIndex, columnIndex),
    ])
    const desiredValues = rendered.values.map((row) => [normalizeCell(row[0])])
    return {
      rangeId,
      a1Range: boundedA1(
        target.sheetTitle,
        columnIndex,
        firstRowIndex + 1,
        columnIndex,
        firstRowIndex + rowIndices.length
      ),
      currentValues,
      desiredValues,
    }
  })
}

function candidateReplacementRange(input: {
  rangeId: StagingSheetContractId
  reportingWeekFriday: string
  target: NormalizedSheetMatrixTarget
  desiredRows: readonly (readonly SheetCellValue[])[]
  allowedRequisitionIds: ReadonlySet<string>
}): BoundedStagingValueRangeInput {
  if (!CANDIDATE_TAB_TITLE.test(input.target.sheetTitle.trim())) {
    throw new Error(`${input.rangeId} target title is not a normalized current-date candidate tab.`)
  }
  const contract = getStagingSheetContract(input.rangeId)
  const width = contract.headers.length
  assertHeaderRows(input.rangeId, input.target.currentMatrix, contract)
  assertNoOverflow(input.rangeId, input.target.currentMatrix, contract.headerRow, width)
  assertRowsWidth(input.rangeId, input.desiredRows, width)

  const expectedWeeks = new Set([
    fridayWeekLabels(input.reportingWeekFriday).weekShort,
    fridayWeekLabels(previousFriday(input.reportingWeekFriday)).weekShort,
  ])
  const lastDataRowIndex = lastNonEmptyRow(input.target.currentMatrix, contract.headerRow, width)
  for (let rowIndex = contract.headerRow; rowIndex <= lastDataRowIndex; rowIndex += 1) {
    const row = matrixRow(input.target.currentMatrix, rowIndex, width)
    if (!row.some(isNonBlank)) continue
    if (!expectedWeeks.has(headerText(row[1]))) {
      throw new Error(`${input.rangeId} contains a non-current-or-predecessor-week candidate row.`)
    }
    if (!input.allowedRequisitionIds.has(keyText(row[2]))) {
      throw new Error(`${input.rangeId} contains an unexpected requisition row.`)
    }
  }

  const currentHeight = Math.max(0, lastDataRowIndex - contract.headerRow + 1)
  const height = Math.max(1, currentHeight, input.desiredRows.length)
  const currentValues = Array.from({ length: height }, (_, offset) =>
    matrixRow(input.target.currentMatrix, contract.headerRow + offset, width)
  )
  const desiredValues = Array.from({ length: height }, (_, offset) =>
    offset < input.desiredRows.length
      ? input.desiredRows[offset].map(normalizeCell)
      : Array<SheetCellValue>(width).fill(null)
  )
  return {
    rangeId: input.rangeId,
    a1Range: boundedA1(
      input.target.sheetTitle.trim(),
      0,
      contract.headerRow + 1,
      width - 1,
      contract.headerRow + height
    ),
    currentValues,
    desiredValues,
  }
}

function previousFriday(reportingWeekFriday: string): string {
  return new Date(Date.parse(`${reportingWeekFriday}T00:00:00.000Z`) - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

function jobWeekUpsertRange(input: {
  rangeId: StagingSheetContractId
  target: NormalizedSheetMatrixTarget
  desiredRows: readonly (readonly SheetCellValue[])[]
  allowedRequisitionIds: ReadonlySet<string>
}): BoundedStagingValueRangeInput {
  const contract = getStagingSheetContract(input.rangeId)
  assertExactStaticTitle(input.target.sheetTitle, contract.sheetTitle, input.rangeId)
  const width = contract.headers.length
  assertHeaderRows(input.rangeId, input.target.currentMatrix, contract)
  assertNoOverflow(input.rangeId, input.target.currentMatrix, contract.headerRow, width)
  assertRowsWidth(input.rangeId, input.desiredRows, width)
  if (input.desiredRows.length === 0) throw new Error(`${input.rangeId} has no desired requisition rows.`)

  const desiredWeekOrder = keyText(input.desiredRows[0][0])
  const desiredWeek = keyText(input.desiredRows[0][1])
  const desiredReqs = input.desiredRows.map((row) => keyText(row[2]))
  if (
    !desiredWeekOrder ||
    !desiredWeek ||
    desiredReqs.some((value) => !value) ||
    new Set(desiredReqs).size !== desiredReqs.length ||
    input.desiredRows.some(
      (row) => keyText(row[0]) !== desiredWeekOrder || keyText(row[1]) !== desiredWeek
    )
  ) {
    throw new Error(`${input.rangeId} renderer emitted an ambiguous job-week block.`)
  }

  // The legacy sheets contain annotation rows and repeated pasted header
  // bands between historical snapshots. Only rows with a real requisition id
  // participate in target-block matching; all other history remains untouched.
  for (let rowIndex = contract.headerRow; rowIndex < input.target.currentMatrix.length; rowIndex += 1) {
    const row = matrixRow(input.target.currentMatrix, rowIndex, width)
    if (!row.some(isNonBlank)) continue
    const req = keyText(row[2])
    if (!req) continue
    if (isRepeatedJobHeader(row, contract)) continue
    if (!input.allowedRequisitionIds.has(req)) {
      throw new Error(`${input.rangeId} contains an unexpected requisition row.`)
    }
  }

  const height = input.desiredRows.length
  const matchingStarts: number[] = []
  for (
    let rowIndex = contract.headerRow;
    rowIndex + height <= input.target.currentMatrix.length;
    rowIndex += 1
  ) {
    const matches = input.desiredRows.every((desiredRow, offset) => {
      const observed = matrixRow(input.target.currentMatrix, rowIndex + offset, width)
      return (
        keyText(observed[0]) === desiredWeekOrder &&
        keyText(observed[1]) === desiredWeek &&
        keyText(observed[2]) === desiredReqs[offset] &&
        keyText(desiredRow[2]) === desiredReqs[offset]
      )
    })
    if (matches) matchingStarts.push(rowIndex)
  }

  const latestMatchingStart = matchingStarts.at(-1)
  const latestMatchingRows = latestMatchingStart === undefined
    ? undefined
    : Array.from({ length: height }, (_, offset) =>
        matrixRow(input.target.currentMatrix, latestMatchingStart + offset, width)
      )
  const latestMatchingBlockIsDesired =
    latestMatchingRows !== undefined && matrixEquals(latestMatchingRows, input.desiredRows)
  const lastDataRowIndex = lastNonEmptyRow(input.target.currentMatrix, contract.headerRow, width)
  const startRowIndex = latestMatchingBlockIsDesired && latestMatchingStart !== undefined
    ? latestMatchingStart
    : Math.max(contract.headerRow, lastDataRowIndex + 1)
  const currentValues = Array.from({ length: height }, (_, offset) =>
    matrixRow(input.target.currentMatrix, startRowIndex + offset, width)
  )
  return {
    rangeId: input.rangeId,
    a1Range: boundedA1(
      input.target.sheetTitle,
      0,
      startRowIndex + 1,
      width - 1,
      startRowIndex + height
    ),
    currentValues,
    desiredValues: input.desiredRows.map((row) => row.map(normalizeCell)),
  }
}

function isRepeatedJobHeader(
  row: readonly SheetCellValue[],
  contract: StagingSheetRangeContract
): boolean {
  return contract.headers
    .slice(0, 5)
    .every((header, index) => headerText(row[index]) === header)
}

function matrixEquals(
  left: readonly (readonly SheetCellValue[])[],
  right: readonly (readonly SheetCellValue[])[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, rowIndex) =>
        row.length === right[rowIndex]?.length &&
        row.every((value, columnIndex) => normalizeCell(value) === normalizeCell(right[rowIndex][columnIndex]))
    )
  )
}

function assertHeaderRows(
  rangeId: StagingSheetContractId,
  matrix: SheetValueMatrix,
  contract: StagingSheetRangeContract
): void {
  const { headerRow, headers: expected } = contract
  const row = matrix[headerRow - 1]
  if (!row) throw new Error(`${rangeId} current matrix is missing header row ${headerRow}.`)
  assertExactHeaders(rangeId, row)
  if (row.slice(expected.length).some(isNonBlank)) {
    throw new Error(`${rangeId} header has unexpected trailing columns.`)
  }
  const groupedHeader = contract.groupedHeader
  if (!groupedHeader) {
    const occurrences = matrix.filter((candidate) => headerMatches(candidate, expected)).length
    if (occurrences !== 1) throw new Error(`${rangeId} header row is ambiguous.`)
    return
  }
  if (groupedHeader.row >= headerRow) {
    throw new Error(`${rangeId} grouped header must precede the primary header row.`)
  }
  const groupedRow = matrix[groupedHeader.row - 1]
  if (!groupedRow) {
    throw new Error(`${rangeId} current matrix is missing grouped header row ${groupedHeader.row}.`)
  }
  if (
    !headerMatches(groupedRow, groupedHeader.headers) ||
    groupedRow.slice(groupedHeader.headers.length).some(isNonBlank)
  ) {
    throw new Error(`${rangeId} grouped header contract drifted; refusing hydration.`)
  }
  // Exact repeated header bands are part of the audited legacy snapshot
  // history. Only the fixed top rows define the writable table contract.
}

function headerMatches(row: readonly SheetCellValue[], expected: readonly string[]): boolean {
  return expected.every((header, index) => headerText(row[index]) === header)
}

function assertNoOverflow(
  rangeId: StagingSheetContractId,
  matrix: SheetValueMatrix,
  dataStartRowIndex: number,
  width: number
): void {
  for (let rowIndex = dataStartRowIndex; rowIndex < matrix.length; rowIndex += 1) {
    if ((matrix[rowIndex] ?? []).slice(width).some(isNonBlank)) {
      throw new Error(`${rangeId} contains values beyond the contracted columns.`)
    }
  }
}

function assertRowsWidth(
  rangeId: StagingSheetContractId,
  rows: readonly (readonly SheetCellValue[])[],
  width: number
): void {
  if (rows.some((row) => row.length !== width)) {
    throw new Error(`${rangeId} renderer width does not match the sheet contract.`)
  }
}

function assertExactStaticTitle(actual: string, expected: string, rangeId: StagingSheetContractId): void {
  if (actual.trim() !== expected) {
    throw new Error(`${rangeId} target title does not match the normalized sheet contract.`)
  }
}

function assertFriday(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("reportingWeekFriday must be an ISO date.")
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value || date.getUTCDay() !== 5) {
    throw new Error("reportingWeekFriday must be a valid Friday.")
  }
}

function assertWeekHeaderMatches(
  rangeId: StagingSheetContractId,
  header: string,
  reportingWeekFriday: string
): void {
  if (!weekHeaderIdentifiesReportingWeek(header, reportingWeekFriday)) {
    throw new Error(`${rangeId} header does not identify the requested Fri-Thu reporting week.`)
  }
}

function weekHeaderIdentifiesReportingWeek(
  header: string,
  reportingWeekFriday: string
): boolean {
  const start = new Date(`${reportingWeekFriday}T00:00:00.000Z`)
  const end = new Date(start.getTime() + 6 * 86_400_000)
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const startMonth = months[start.getUTCMonth()]
  const endMonth = months[end.getUTCMonth()]
  const startDay = start.getUTCDate()
  const endDay = end.getUTCDate()
  const paddedStart = String(startDay).padStart(2, "0")
  const paddedEnd = String(endDay).padStart(2, "0")
  const labels = fridayWeekLabels(reportingWeekFriday)
  const allowed = new Set([
    labels.weekShort,
    labels.weekLabel,
    `${paddedStart} ${startMonth} - ${paddedEnd} ${endMonth}`,
    `${paddedStart} ${startMonth} to ${paddedEnd} ${endMonth}`,
    `${startDay} ${startMonth} - ${endDay} ${endMonth}`,
    `${startDay} ${startMonth} to ${endDay} ${endMonth}`,
    `${startMonth} ${startDay} - ${endMonth} ${endDay}`,
    `${startMonth} ${startDay} to ${endMonth} ${endDay}`,
  ])
  return allowed.has(header)
}

function lastNonEmptyRow(matrix: SheetValueMatrix, startRowIndex: number, width: number): number {
  for (let rowIndex = matrix.length - 1; rowIndex >= startRowIndex; rowIndex -= 1) {
    if (matrixRow(matrix, rowIndex, width).some(isNonBlank)) return rowIndex
  }
  return startRowIndex - 1
}

function matrixRow(matrix: SheetValueMatrix, rowIndex: number, width: number): SheetCellValue[] {
  return Array.from({ length: width }, (_, columnIndex) => cellAt(matrix, rowIndex, columnIndex))
}

function cellAt(matrix: SheetValueMatrix, rowIndex: number, columnIndex: number): SheetCellValue {
  return normalizeCell(matrix[rowIndex]?.[columnIndex])
}

function normalizeCell(value: SheetCellValue | undefined): SheetCellValue {
  return value === undefined || value === "" ? null : value
}

function isNonBlank(value: SheetCellValue | undefined): boolean {
  return value !== undefined && value !== null && value !== ""
}

function headerText(value: SheetCellValue | undefined): string {
  return String(value ?? "").trim()
}

function keyText(value: SheetCellValue | undefined): string {
  return headerText(value)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function boundedA1(
  sheetTitle: string,
  startColumnIndex: number,
  startRow: number,
  endColumnIndex: number,
  endRow: number
): string {
  const title = sheetTitle.trim()
  if (!title || /[\r\n]/.test(title)) throw new Error("Bounded sheet target title is invalid.")
  if (
    startColumnIndex < 0 ||
    endColumnIndex < startColumnIndex ||
    startRow < 1 ||
    endRow < startRow
  ) {
    throw new Error("Bounded sheet target coordinates are invalid.")
  }
  const quotedTitle = `'${title.replace(/'/g, "''")}'`
  return `${quotedTitle}!${columnLabel(startColumnIndex)}${startRow}:${columnLabel(endColumnIndex)}${endRow}`
}

function columnLabel(columnIndex: number): string {
  let value = columnIndex + 1
  let label = ""
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}
