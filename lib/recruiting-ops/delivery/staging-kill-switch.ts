import type { KillSwitchState } from "../autonomy"
import type { StagingArtifactKey } from "./staging-artifact-registry"

export const STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID = "recruiting_ops_staging_hydration"

export interface StagingKillSwitchEvidence {
  storeReachable: true
  clear: boolean
  blockingScopes: readonly string[]
  reason: string
}

/**
 * Requires an explicit durable DISENGAGED staging-global event. The latest
 * durable value remains authoritative until an operator supersedes it; any
 * broader or artifact-specific engaged switch wins.
 */
export function evaluateStagingKillSwitchStates(
  artifactKey: StagingArtifactKey,
  states: readonly KillSwitchState[],
  nowMs: number
): StagingKillSwitchEvidence {
  const explicitClear = states.find(
    (state) => state.scope === "global" && state.scopeId === STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID
  )
  const blockers = states.filter(
    (state) =>
      state.enabled &&
      ((state.scope === "global" && ["all", "recruiting_ops", STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID].includes(state.scopeId)) ||
        (state.scope === "capability" && state.scopeId === "staging_hydration") ||
        (state.scope === "deliverable" && [artifactKey, `staging:${artifactKey}`].includes(state.scopeId)))
  )
  const blockingScopes = blockers.map((state) => `${state.scope}:${state.scopeId}`).sort()
  if (!explicitClear || explicitClear.enabled) {
    return {
      storeReachable: true,
      clear: false,
      blockingScopes,
      reason: "No explicit durable DISENGAGED staging-hydration switch state is present.",
    }
  }
  const explicitClearUpdatedAtMs = Date.parse(explicitClear.updatedAt)
  if (!Number.isFinite(nowMs) || Number.isNaN(explicitClearUpdatedAtMs)) {
    return {
      storeReachable: true,
      clear: false,
      blockingScopes,
      reason: "The explicit durable DISENGAGED staging-hydration switch state has an invalid timestamp.",
    }
  }
  if (explicitClearUpdatedAtMs > nowMs) {
    return {
      storeReachable: true,
      clear: false,
      blockingScopes,
      reason: "The explicit durable DISENGAGED staging-hydration switch state is future-dated.",
    }
  }
  if (blockingScopes.length > 0) {
    return {
      storeReachable: true,
      clear: false,
      blockingScopes,
      reason: "An applicable durable kill switch is engaged.",
    }
  }
  return {
    storeReachable: true,
    clear: true,
    blockingScopes: [],
    reason: "Durable staging-hydration switch is disengaged and no applicable blocker is engaged.",
  }
}
