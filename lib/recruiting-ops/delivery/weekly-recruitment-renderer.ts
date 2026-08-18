import type { ReqWeekReportRow } from "../delivery-source/req-week-report"
import { googleDateSerial } from "./all-hires-renderer"
import type { StagingSheetContractId } from "./staging-sheet-contracts"
import type { SheetCellValue } from "./staging-value-plan"

const WIDTH = 26
const JOB_NAME_INDEX = 0
const JOB_STATUS_INDEX = 1
const REQ_ID_INDEX = 2
const WEEKLY_OFFER_START_INDEX = 12
const WEEKLY_OFFER_END_INDEX = 15
const MANUAL_COLUMN_INDEXES = new Set([3, 6, 9, 10, 11, 23])

export interface WeeklyRecruitmentRenderedSegment {
  rangeId: StagingSheetContractId
  startColumn: string
  endColumn: string
  values: readonly (readonly SheetCellValue[])[]
}

export interface WeeklyRecruitmentRenderResult {
  desiredRows: readonly (readonly SheetCellValue[])[]
  segments: readonly WeeklyRecruitmentRenderedSegment[]
  appendedReqIds: readonly string[]
  departedReqIds: readonly string[]
  scopeExcludedReqIds: readonly string[]
}

/**
 * Req-ID upsert into the current Weekly Recruitment copy. The five emitted
 * segments skip D/G/J:L/X, making all six human-owned columns physically
 * unreachable by the write plan. Departed rows retain historical snapshot
 * fields, but their week-bounded offer metrics are reset so a cloned prior
 * week cannot masquerade as current-week activity.
 */
export function renderWeeklyRecruitmentRows(input: {
  currentRows: readonly (readonly SheetCellValue[])[]
  sourceRows: readonly ReqWeekReportRow[]
}): WeeklyRecruitmentRenderResult {
  const current = trimTrailingEmptyRows(input.currentRows).map((row) => normalizeRow(row))
  const currentIndex = indexRows(current)
  const sourceIndex = new Map<string, ReqWeekReportRow>()
  for (const row of input.sourceRows) {
    if (sourceIndex.has(row.requisitionId)) {
      throw new Error(`Weekly Recruitment source contains duplicate Req ID ${row.requisitionId}.`)
    }
    sourceIndex.set(row.requisitionId, row)
  }
  const duplicateTargets = resolveDuplicateTargets(current, currentIndex, sourceIndex)

  const desired = current.map((row) => [...row])
  const appendedReqIds: string[] = []
  const scopeExcludedReqIds: string[] = []
  const refreshedCurrentRowIndexes = new Set<number>()
  for (const source of input.sourceRows) {
    const rowIndexes = currentIndex.get(source.requisitionId)
    if (source.audienceScope !== "team_visible") {
      scopeExcludedReqIds.push(source.requisitionId)
      continue
    }
    if (rowIndexes === undefined) {
      const appended = Array<SheetCellValue>(WIDTH).fill(null)
      applyPlatformColumns(appended, source)
      desired.push(appended)
      appendedReqIds.push(source.requisitionId)
    } else {
      const rowIndex = rowIndexes.length === 1 ? rowIndexes[0] : duplicateTargets.get(source.requisitionId)
      if (rowIndex === undefined) {
        throw new Error(`Weekly Recruitment could not resolve duplicate Req ID ${source.requisitionId}.`)
      }
      applyPlatformColumns(desired[rowIndex], source)
      refreshedCurrentRowIndexes.add(rowIndex)
    }
  }

  const departedReqIds = [...currentIndex.keys()]
    .filter((reqId) => !sourceIndex.has(reqId))
    .sort(compareReqIds)
  // Any existing row that was not refreshed for this week—including a
  // departed/scoped role or the historical half of a duplicate Req ID—must
  // not retain the predecessor tab's M:N:O activity.
  for (const rowIndexes of currentIndex.values()) {
    for (const rowIndex of rowIndexes) {
      if (refreshedCurrentRowIndexes.has(rowIndex)) continue
      for (
        let columnIndex = WEEKLY_OFFER_START_INDEX;
        columnIndex < WEEKLY_OFFER_END_INDEX;
        columnIndex += 1
      ) {
        desired[rowIndex][columnIndex] = 0
      }
    }
  }
  return {
    desiredRows: desired,
    segments: [
      segment("weekly_recruitment_a_c", "A", "C", desired, 0, 3),
      segment("weekly_recruitment_e_f", "E", "F", desired, 4, 6),
      segment("weekly_recruitment_h_i", "H", "I", desired, 7, 9),
      segment("weekly_recruitment_m_w", "M", "W", desired, 12, 23),
      segment("weekly_recruitment_y_z", "Y", "Z", desired, 24, 26),
    ],
    appendedReqIds: appendedReqIds.sort(compareReqIds),
    departedReqIds,
    scopeExcludedReqIds: scopeExcludedReqIds.sort(compareReqIds),
  }
}

function applyPlatformColumns(target: SheetCellValue[], source: ReqWeekReportRow): void {
  const values: SheetCellValue[] = [
    source.jobName,
    source.jobStatus,
    source.requisitionId,
    null,
    source.department,
    source.location,
    null,
    source.headcountOpen,
    source.headcountClosed,
    null,
    null,
    null,
    source.offerExtended,
    source.signed,
    source.declined,
    // Preserve the legacy workbook's column-P outcome while naming the source
    // fact honestly: this is accepted offers, not employee start dates.
    source.acceptedOffers,
    source.earliestOpeningDate ? googleDateSerial(source.earliestOpeningDate) : null,
    source.daysOpen,
    joinedNames(source.recruiters),
    joinedNames(source.recruiterTeams),
    joinedNames(source.sourcers),
    joinedNames(source.hiringManagers),
    joinedNames(source.hods),
    null,
    source.jobUrl,
    source.closedDate ? googleDateSerial(source.closedDate) : null,
  ]
  for (let index = 0; index < WIDTH; index += 1) {
    if (!MANUAL_COLUMN_INDEXES.has(index)) target[index] = values[index]
  }
}

function joinedNames(names: readonly string[]): string | null {
  const joined = names.join(", ")
  return joined || null
}

function segment(
  rangeId: StagingSheetContractId,
  startColumn: string,
  endColumn: string,
  rows: readonly (readonly SheetCellValue[])[],
  startIndex: number,
  endIndex: number
): WeeklyRecruitmentRenderedSegment {
  return {
    rangeId,
    startColumn,
    endColumn,
    values: rows.map((row) => row.slice(startIndex, endIndex)),
  }
}

function indexRows(rows: readonly (readonly SheetCellValue[])[]): Map<string, number[]> {
  const index = new Map<string, number[]>()
  rows.forEach((row, rowIndex) => {
    const reqId = idOf(row[REQ_ID_INDEX])
    if (!reqId) return
    const matches = index.get(reqId)
    if (matches) matches.push(rowIndex)
    else index.set(reqId, [rowIndex])
  })
  return index
}

function resolveDuplicateTargets(
  rows: readonly (readonly SheetCellValue[])[],
  currentIndex: ReadonlyMap<string, readonly number[]>,
  sourceIndex: ReadonlyMap<string, ReqWeekReportRow>
): ReadonlyMap<string, number> {
  const resolved = new Map<string, number>()
  for (const [reqId, rowIndexes] of currentIndex) {
    if (rowIndexes.length < 2) continue
    const source = sourceIndex.get(reqId)
    if (!source || source.audienceScope !== "team_visible") continue

    const sourceJobName = normalizedText(source.jobName)
    const nameMatches = sourceJobName
      ? rowIndexes.filter(
          (rowIndex) => normalizedText(rows[rowIndex][JOB_NAME_INDEX]) === sourceJobName
        )
      : []
    if (nameMatches.length === 0) {
      throw new Error(
        `Weekly Recruitment copy contains duplicate Req ID ${reqId} with no normalized job-name match.`
      )
    }
    if (nameMatches.length === 1) {
      resolved.set(reqId, nameMatches[0])
      continue
    }

    const sourceStatus = normalizedText(source.jobStatus)
    const statusMatches = sourceStatus
      ? nameMatches.filter(
          (rowIndex) => normalizedText(rows[rowIndex][JOB_STATUS_INDEX]) === sourceStatus
        )
      : []
    if (statusMatches.length === 1) {
      resolved.set(reqId, statusMatches[0])
      continue
    }
    throw new Error(
      `Weekly Recruitment copy contains duplicate Req ID ${reqId} that is ambiguous after normalized job-name and status matching.`
    )
  }
  return resolved
}

function normalizeRow(row: readonly SheetCellValue[]): SheetCellValue[] {
  return Array.from({ length: WIDTH }, (_, index) => row[index] ?? null)
}

function trimTrailingEmptyRows(rows: readonly (readonly SheetCellValue[])[]): readonly (readonly SheetCellValue[])[] {
  let end = rows.length
  while (end > 0 && rows[end - 1].every((cell) => cell === null || cell === "")) end -= 1
  return rows.slice(0, end)
}

function idOf(value: SheetCellValue | undefined): string | null {
  if (value === null || value === undefined) return null
  const id = String(value).trim()
  return id || null
}

function normalizedText(value: SheetCellValue | undefined): string {
  if (value === null || value === undefined) return ""
  return String(value).trim().toLowerCase().replace(/\s+/g, " ")
}

function compareReqIds(left: string, right: string): number {
  return Number(left) - Number(right) || left.localeCompare(right)
}
