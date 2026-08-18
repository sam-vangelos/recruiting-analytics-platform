/**
 * Detects the cycle that never started.
 *
 * Every other signal in this system is written BY a run: the ledger, the run
 * summary, the per-artifact evidence, the Slack message the orchestration route
 * sends. A scheduler that never fired, a launch call that 500'd, or a job that
 * never reached its entrypoint produces none of them, and the reports simply go
 * stale in silence. Only an independent timer can see that absence, so this
 * check runs on its own schedule and asks the one question a run cannot ask
 * about itself: is there a run row for the slot that was due?
 *
 * It reads; it never claims, writes, or repairs. A slot with no due artifacts
 * (a weekend, or a lane whose artifacts are all on another cadence) is not a
 * missing run and is skipped.
 */
import { scheduledHydrationDedupeKey } from "./hydration-orchestration-store"
import {
  resolveScheduledHydrationCycle,
  type ScheduledHydrationCycle,
} from "./staging-maintenance-cadence"
import { stagingArtifactRegistry } from "./staging-artifact-registry"

/**
 * The Cloud Scheduler job allowed to drive this check. It lives here rather
 * than in the route because a Next.js route module may only export the fields
 * Next recognises — exporting it there fails the production build.
 */
export const RECRUITING_OPS_HYDRATION_WATCHDOG_SCHEDULER_JOB_NAME =
  "projects/example-project/locations/us-central1/jobs/recops-staging-hydration-watchdog"

/** Pacific wall-clock hours the cadence resolver accepts, both at :30. */
const MORNING_HOUR = 6
const EVENING_HOUR = 23
/**
 * A run row appears at claim time, roughly a minute after the scheduler fires.
 * Half an hour is far past that and still inside the same morning, so a check
 * run early cannot accuse a cycle that is merely starting.
 */
const DUE_GRACE_MS = 30 * 60 * 1000
const SCHEDULED_ARTIFACTS = stagingArtifactRegistry
  .filter((target) => target.maintenanceLane !== null)
  .map((target) => target.key)

const LOS_ANGELES_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

export interface MissingHydrationSlot {
  scheduledAt: string
  lane: string
  dueArtifactCount: number
}

export interface HydrationWatchdogResult {
  status: "healthy" | "missing_run"
  checkedSlots: readonly { scheduledAt: string; lane: string; dueArtifactCount: number }[]
  missingSlots: readonly MissingHydrationSlot[]
}

export interface HydrationWatchdogDependencies {
  /** Which of these dedupe keys already have a run row, in any state. */
  claimedDedupeKeys(keys: readonly string[]): Promise<ReadonlySet<string>>
  nowMs(): number
}

export async function runStagingHydrationWatchdog(
  dependencies: HydrationWatchdogDependencies
): Promise<HydrationWatchdogResult> {
  const nowMs = dependencies.nowMs()
  const due = dueSlots(nowMs)
  if (due.length === 0) {
    return { status: "healthy", checkedSlots: [], missingSlots: [] }
  }

  const keys = due.map((cycle) => scheduledHydrationDedupeKey(cycle.scheduledAt, "write"))
  const claimed = await dependencies.claimedDedupeKeys(keys)
  const checkedSlots = due.map(describeSlot)
  const missingSlots = due
    .filter((cycle) => !claimed.has(scheduledHydrationDedupeKey(cycle.scheduledAt, "write")))
    .map(describeSlot)

  return {
    status: missingSlots.length === 0 ? "healthy" : "missing_run",
    checkedSlots,
    missingSlots,
  }
}

function describeSlot(cycle: ScheduledHydrationCycle): MissingHydrationSlot {
  return {
    scheduledAt: cycle.scheduledAt,
    lane: cycle.lane,
    dueArtifactCount: cycle.dueArtifacts.length,
  }
}

/**
 * The two slots a morning check can speak to: this morning's, and the evening
 * slot that preceded it. Anything earlier belongs to a check that already ran.
 */
function dueSlots(nowMs: number): ScheduledHydrationCycle[] {
  const today = losAngelesDate(nowMs)
  const yesterday = losAngelesDate(nowMs - 86_400_000)
  const candidates = [
    pacificSlotInstant(yesterday, EVENING_HOUR),
    pacificSlotInstant(today, MORNING_HOUR),
  ]

  const slots: ScheduledHydrationCycle[] = []
  for (const scheduledAt of candidates) {
    if (scheduledAt === null || Date.parse(scheduledAt) + DUE_GRACE_MS > nowMs) continue
    let cycle: ScheduledHydrationCycle
    try {
      cycle = resolveScheduledHydrationCycle({
        scheduledAt,
        eligibleArtifacts: SCHEDULED_ARTIFACTS,
      })
    } catch {
      // A weekend or otherwise unapproved slot is not a missed run.
      continue
    }
    if (cycle.dueArtifacts.length > 0) slots.push(cycle)
  }
  return slots
}

/**
 * The UTC instant of a Pacific wall-clock time. Both standard and daylight
 * offsets are tried and the one that formats back to the intended wall time
 * wins, so this stays exact across both DST boundaries without a table.
 */
function pacificSlotInstant(date: string, hour: number): string | null {
  const [year, month, day] = date.split("-").map(Number)
  for (const offsetHours of [7, 8]) {
    const candidate = Date.UTC(year, month - 1, day, hour + offsetHours, 30, 0, 0)
    const parts = losAngelesParts(candidate)
    if (
      parts.year === year && parts.month === month && parts.day === day
      && parts.hour === hour && parts.minute === 30
    ) {
      return new Date(candidate).toISOString()
    }
  }
  // A wall-clock time that does not exist (the spring-forward gap) has no
  // instant, so there was no slot to miss.
  return null
}

function losAngelesDate(instantMs: number): string {
  const parts = losAngelesParts(instantMs)
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`
}

function losAngelesParts(instantMs: number): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
} {
  const values = Object.fromEntries(
    LOS_ANGELES_PARTS.formatToParts(new Date(instantMs)).map((part) => [part.type, part.value])
  )
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  }
}
