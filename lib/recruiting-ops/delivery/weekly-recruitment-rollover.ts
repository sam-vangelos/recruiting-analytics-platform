import { fridayWeekStartUtc } from "../exec-definitions"

const DAY_MS = 86_400_000
const WEEKLY_RECRUITMENT_SHEET_ID_BASE = 1_960_000_000
const WEEKLY_RECRUITMENT_SHEET_ID_EPOCH_FRIDAY_MS = Date.UTC(2000, 0, 7)
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const
const TITLE_PREFIX = "Weekly Working Report Sheet "

export interface WeeklyRecruitmentCycle {
  reportingWeekFriday: string
  reportingWeekThursday: string
  predecessorWeekFriday: string
  predecessorWeekThursday: string
  targetSheetTitle: string
  targetSheetId: number
}

export interface WeeklyRecruitmentSheetDescriptor {
  sheetId: number
  title: string
  index: number
}

/** Exact Fri-Thu lifecycle identity used by both rollover and value hydration. */
export function weeklyRecruitmentCycle(reportingWeekFriday: string): WeeklyRecruitmentCycle {
  const fridayMs = validFridayMs(reportingWeekFriday)
  const reportingWeekThursday = isoDate(fridayMs + 6 * DAY_MS)
  const predecessorWeekFriday = isoDate(fridayMs - 7 * DAY_MS)
  const predecessorWeekThursday = isoDate(fridayMs - DAY_MS)
  return {
    reportingWeekFriday,
    reportingWeekThursday,
    predecessorWeekFriday,
    predecessorWeekThursday,
    targetSheetTitle: weeklyRecruitmentTargetSheetTitle(reportingWeekFriday),
    targetSheetId: weeklyRecruitmentTargetSheetId(reportingWeekFriday),
  }
}

/** The Thursday ISO date at the end of a Fri-Thu recruiting reporting week. */
export function weeklyRecruitmentEndDate(reportingWeekFriday: string): string {
  return isoDate(validFridayMs(reportingWeekFriday) + 6 * DAY_MS)
}

/** Legacy tab title retained verbatim so platform output remains recognizable. */
export function weeklyRecruitmentTargetSheetTitle(reportingWeekFriday: string): string {
  const fridayMs = validFridayMs(reportingWeekFriday)
  const thursdayMs = fridayMs + 6 * DAY_MS
  return `${TITLE_PREFIX}${displayDate(fridayMs, false)} to ${displayDate(thursdayMs, true)}`
}

/**
 * Reserves one stable sheet id per Friday in a dedicated, bounded id band.
 * The structural observer still requires the id and title to be absent before
 * duplication, so even an unlikely legacy collision fails closed.
 */
export function weeklyRecruitmentTargetSheetId(reportingWeekFriday: string): number {
  const fridayMs = validFridayMs(reportingWeekFriday)
  const weekOrdinal = (fridayMs - WEEKLY_RECRUITMENT_SHEET_ID_EPOCH_FRIDAY_MS) / (7 * DAY_MS)
  if (!Number.isSafeInteger(weekOrdinal) || weekOrdinal < 0) {
    throw new Error("Weekly Recruitment reportingWeekFriday is outside the reserved sheet-id epoch.")
  }
  const sheetId = WEEKLY_RECRUITMENT_SHEET_ID_BASE + weekOrdinal
  if (sheetId > 2_147_483_647) {
    throw new Error("Weekly Recruitment target sheet id exceeds the Google Sheets limit.")
  }
  return sheetId
}

/**
 * Restricts live rollover/hydration to the one week the platform source clock
 * currently exposes. This prevents accidental future-tab creation or stale
 * backfill through the recurring endpoint.
 */
export function requireAvailableWeeklyRecruitmentFriday(
  reportingWeekFriday: string,
  nowMs: number
): string {
  validFridayMs(reportingWeekFriday)
  const available = currentWeeklyRecruitmentFriday(nowMs)
  if (reportingWeekFriday !== available) {
    throw new Error(
      `Weekly Recruitment reporting week ${reportingWeekFriday} is not currently available; expected ${available}.`
    )
  }
  return reportingWeekFriday
}

/** Runtime reporting week used when a recurring rollover has no date override. */
export function currentWeeklyRecruitmentFriday(nowMs: number): string {
  if (!Number.isFinite(nowMs)) throw new Error("Weekly Recruitment rollover nowMs must be finite.")
  return fridayWeekStartUtc(new Date(nowMs))
}

/**
 * Selects the most recent existing tab whose end date is strictly before the
 * target week starts, deliberately ignoring displayed start dates (the live
 * 09 Jul predecessor is named "02 Jul to 09 Jul" even though its underlying
 * reporting bucket starts 03 Jul). This is a structural-template lookup, not
 * a claim that the immediately preceding week exists: if a week went
 * unmaintained, the newest surviving tab further back is used as-is and the
 * skipped week is never fabricated. Blocks closed if no tab qualifies or if
 * two or more tie for the newest qualifying end date.
 */
export function selectWeeklyRecruitmentPredecessorSheet(
  sheets: readonly WeeklyRecruitmentSheetDescriptor[],
  reportingWeekFriday: string
): WeeklyRecruitmentSheetDescriptor {
  const { reportingWeekFriday: targetWeekFriday } = weeklyRecruitmentCycle(reportingWeekFriday)
  const targetWeekStartMs = Date.parse(`${targetWeekFriday}T00:00:00.000Z`)
  const dated = sheets.flatMap((sheet) => {
    const endDate = weeklyRecruitmentSheetTitleEndDate(sheet.title)
    if (endDate === null) return []
    const endDateMs = Date.parse(`${endDate}T00:00:00.000Z`)
    return endDateMs < targetWeekStartMs ? [{ sheet, endDateMs }] : []
  })
  const newestMs = dated.reduce((max, entry) => Math.max(max, entry.endDateMs), -Infinity)
  const matches = dated.filter((entry) => entry.endDateMs === newestMs).map((entry) => entry.sheet)
  if (matches.length === 0) {
    throw new Error(
      `Weekly Recruitment rollover requires at least one predecessor tab ending before ${targetWeekFriday}; found 0.`
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `Weekly Recruitment rollover requires exactly one predecessor before ${targetWeekFriday}; found ${matches.length} tied for the newest end date.`
    )
  }
  const [match] = matches
  if (!Number.isInteger(match.sheetId) || match.sheetId < 0 || !Number.isInteger(match.index) || match.index < 0) {
    throw new Error("Weekly Recruitment predecessor has invalid sheet metadata.")
  }
  return match
}

/** Parses only the authoritative end date from a legacy weekly tab title. */
export function weeklyRecruitmentSheetTitleEndDate(title: string): string | null {
  const match = title.match(
    /^Weekly Working Report Sheet (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) to (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})$/
  )
  if (!match) return null
  const startMonth = MONTHS.indexOf(match[2] as (typeof MONTHS)[number])
  const endMonth = MONTHS.indexOf(match[4] as (typeof MONTHS)[number])
  const endYear = Number(match[5])
  const startYear = startMonth > endMonth ? endYear - 1 : endYear
  const start = new Date(Date.UTC(startYear, startMonth, Number(match[1])))
  const end = new Date(Date.UTC(endYear, endMonth, Number(match[3])))
  if (
    start.getUTCFullYear() !== startYear ||
    start.getUTCMonth() !== startMonth ||
    start.getUTCDate() !== Number(match[1]) ||
    end.getUTCFullYear() !== endYear ||
    end.getUTCMonth() !== endMonth ||
    end.getUTCDate() !== Number(match[3])
  ) {
    return null
  }
  return end.toISOString().slice(0, 10)
}

function validFridayMs(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Weekly Recruitment reportingWeekFriday must be an ISO date.")
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  const date = new Date(timestamp)
  if (
    Number.isNaN(timestamp) ||
    date.toISOString().slice(0, 10) !== value ||
    date.getUTCDay() !== 5
  ) {
    throw new Error("Weekly Recruitment reportingWeekFriday must be a valid Friday.")
  }
  return timestamp
}

function displayDate(timestamp: number, includeYear: boolean): string {
  const date = new Date(timestamp)
  return `${String(date.getUTCDate()).padStart(2, "0")} ${MONTHS[date.getUTCMonth()]}${
    includeYear ? ` ${date.getUTCFullYear()}` : ""
  }`
}

function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}
