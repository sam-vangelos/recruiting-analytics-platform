import {
  stagingArtifactRegistry,
  type StagingArtifactKey,
  type StagingArtifactTarget,
  type StagingMaintenanceLane,
} from "./staging-artifact-registry"

const LOS_ANGELES_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
const MS_PER_DAY = 86_400_000

type ScheduledArtifactTarget = StagingArtifactTarget & {
  maintenanceLane: StagingMaintenanceLane
}

export interface ScheduledHydrationCycle {
  readonly scheduledAt: string
  readonly lane: StagingMaintenanceLane
  readonly businessDate: string
  readonly reportingWeekFriday: string
  readonly quarterStart: string
  readonly dueArtifacts: readonly StagingArtifactKey[]
}

export function resolveScheduledHydrationCycle(input: {
  scheduledAt: string
  eligibleArtifacts: readonly string[]
}): ScheduledHydrationCycle {
  const scheduled = parseScheduledAt(input.scheduledAt)
  const eligible = requireEligibleArtifacts(input.eligibleArtifacts)
  const parts = losAngelesParts(scheduled)
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  if (weekday === 0 || weekday === 6 || parts.minute !== 30 || (parts.hour !== 6 && parts.hour !== 23)) {
    throw new Error("Scheduled hydration timestamp is outside an approved Pacific weekday slot.")
  }

  const lane: StagingMaintenanceLane = parts.hour === 6 ? "weekday_morning" : "weekday_evening"
  const scheduledTargets = stagingArtifactRegistry.filter(isScheduledArtifactTarget)
  const dueTargets = [
    ...scheduledTargets.filter((target) => target.maintenanceLane === lane && target.cadence === "daily"),
    ...(weekday === 4
      ? scheduledTargets.filter((target) => target.maintenanceLane === lane && target.cadence === "weekly")
      : []),
    ...(weekday === 5 && lane === "weekday_morning"
      ? scheduledTargets.filter((target) => target.key === "elt_doc")
      : []),
  ]
  const businessDate = isoDate(parts.year, parts.month, parts.day)

  return {
    scheduledAt: scheduled.toISOString(),
    lane,
    businessDate,
    reportingWeekFriday: fridayOnOrBefore(parts.year, parts.month, parts.day),
    quarterStart: isoDate(parts.year, Math.floor((parts.month - 1) / 3) * 3 + 1, 1),
    dueArtifacts: dueTargets.map((target) => target.key).filter((key) => eligible.has(key)),
  }
}

function parseScheduledAt(value: string): Date {
  const match = RFC3339.exec(value)
  if (!match) throw new Error("Scheduled hydration requires one RFC3339 timestamp.")
  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] = match
  const [year, month, day, hour, minute, second] = [
    yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue,
  ].map(Number)
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59
  ) {
    throw new Error("Scheduled hydration requires one valid RFC3339 timestamp.")
  }
  const timestamp = new Date(value)
  if (!Number.isFinite(timestamp.getTime()) || second !== 0) {
    throw new Error("Scheduled hydration requires one valid whole-minute RFC3339 timestamp.")
  }
  timestamp.setUTCMilliseconds(0)
  return timestamp
}

function requireEligibleArtifacts(values: readonly string[]): ReadonlySet<StagingArtifactKey> {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Scheduled hydration requires an explicit copied-artifact eligibility list.")
  }
  const byKey = new Map(stagingArtifactRegistry.map((target) => [target.key, target]))
  const eligible = new Set<StagingArtifactKey>()
  for (const value of values) {
    const target = byKey.get(value as StagingArtifactTarget["key"])
    if (!target) throw new Error("Scheduled hydration eligibility contains an unknown artifact.")
    if (!isScheduledArtifactTarget(target)) {
      throw new Error("Scheduled hydration eligibility accepts registered canonical artifacts only.")
    }
    if (eligible.has(target.key)) {
      throw new Error("Scheduled hydration eligibility contains a duplicate artifact.")
    }
    eligible.add(target.key)
  }
  return eligible
}

function isScheduledArtifactTarget(target: StagingArtifactTarget): target is ScheduledArtifactTarget {
  return target.mutationTarget === "canonical" &&
    (target.kind === "google_sheet" || (target.key === "elt_doc" && target.kind === "google_doc")) &&
    target.maintenanceLane !== null
}

function losAngelesParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const values = Object.fromEntries(
    LOS_ANGELES_PARTS.formatToParts(date).map((part) => [part.type, part.value])
  )
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  }
}

function fridayOnOrBefore(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day))
  const daysSinceFriday = (date.getUTCDay() - 5 + 7) % 7
  return new Date(date.getTime() - daysSinceFriday * MS_PER_DAY).toISOString().slice(0, 10)
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}
