/**
 * Google Sheets enforces a per-user read-request quota. A single guarded
 * value write intentionally reads the complete copied-workbook structure
 * during planning, immediately before mutation, and again after mutation.
 * Pace every Sheets read capability in this process so those safety reads do
 * not burst through the provider limit. Cloud Run is separately constrained
 * to one instance and concurrency one; the remaining quota headroom is for
 * the existing production process that uses the same governed identity.
 */
export const STAGING_SHEETS_READ_MINIMUM_INTERVAL_MS = 1_500

export interface StagingSheetsReadPacer {
  wait(): Promise<void>
}

export interface CreateStagingSheetsReadPacerOptions {
  minimumIntervalMs: number
  nowMs?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

export function createStagingSheetsReadPacer(
  options: CreateStagingSheetsReadPacerOptions
): StagingSheetsReadPacer {
  if (!Number.isFinite(options.minimumIntervalMs) || options.minimumIntervalMs < 0) {
    throw new Error("Sheets read pacing interval must be a non-negative finite number.")
  }
  const nowMs = options.nowMs ?? Date.now
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  }))
  let nextAllowedAtMs = 0
  let queue: Promise<void> = Promise.resolve()

  return Object.freeze({
    wait(): Promise<void> {
      const granted = queue.then(async () => {
        const waitMs = Math.max(0, nextAllowedAtMs - nowMs())
        if (waitMs > 0) await sleep(waitMs)
        nextAllowedAtMs = Math.max(nextAllowedAtMs, nowMs()) + options.minimumIntervalMs
      })
      // A failed sleeper must reject its caller without permanently poisoning
      // later quota slots.
      queue = granted.catch(() => {})
      return granted
    },
  })
}

const stagingSheetsReadPacer = createStagingSheetsReadPacer({
  minimumIntervalMs:
    process.env.NODE_ENV === "test" ? 0 : STAGING_SHEETS_READ_MINIMUM_INTERVAL_MS,
})

export function paceStagingSheetsRead(): Promise<void> {
  return stagingSheetsReadPacer.wait()
}
