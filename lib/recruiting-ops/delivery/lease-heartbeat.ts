/**
 * Renews short database leases on behalf of a live process.
 *
 * A lease is only evidence of liveness if a dead process stops extending it.
 * The orchestrator claims its run and source rows with a short lease and
 * registers a renewal here; every interval tick renews all registered leases.
 * When the process dies the ticks stop, the lease expires within minutes, and
 * the claim-side recovery in migration 026 reclaims the run automatically.
 *
 * A renewal that returns false means the lease was positively lost (expired
 * and taken, or the row went terminal). The renewal is dropped and the loss is
 * recorded so the orchestrator can fail closed at the next artifact boundary
 * instead of racing the new owner. A renewal that throws is treated as
 * transient (network, database restart) and retried on the next tick — the
 * database-side lease checks on every persist remain the authority.
 */
export interface LeaseHeartbeat {
  register(name: string, renew: () => Promise<boolean>): () => void
  lostLeases(): ReadonlySet<string>
  tick(): Promise<void>
  stop(): void
}

export function createLeaseHeartbeat(intervalMs: number): LeaseHeartbeat {
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
    throw new Error("Lease heartbeat interval must be at least 1000ms.")
  }
  const renewals = new Map<string, () => Promise<boolean>>()
  const lost = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  let ticking = false

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      for (const [name, renew] of [...renewals]) {
        try {
          if (!(await renew())) {
            renewals.delete(name)
            lost.add(name)
            console.error(`[recruiting-ops-lease-heartbeat] ${name} lease lost; renewal stopped`)
          }
        } catch {
          // Transient renewal failure: the lease is short but not that short.
          // Keep the registration and try again on the next tick.
        }
      }
    } finally {
      ticking = false
    }
  }

  return {
    register(name, renew) {
      renewals.set(name, renew)
      lost.delete(name)
      if (!timer) {
        timer = setInterval(() => { void tick() }, intervalMs)
        timer.unref?.()
      }
      // A deliberate release retracts the loss too. The source lease is
      // released the moment its cut is persisted, and a tick landing between
      // the persist and the release renews false against a row that is no
      // longer 'running' — a bookkeeping artifact, not a lease another process
      // took, and never a reason to abandon the run.
      return () => {
        renewals.delete(name)
        lost.delete(name)
      }
    },
    lostLeases() {
      return lost
    },
    tick,
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      renewals.clear()
    },
  }
}
