/**
 * Operator control for the copied-artifact staging hydration kill switch.
 *
 * The command is a dry run unless --execute is present. It writes only one
 * append-only durable safety-store event for the fixed staging-hydration scope;
 * it has no Google Workspace client or artifact mutation path.
 */
import type { KillSwitchState } from "../../lib/recruiting-ops/autonomy"
import {
  createKillSwitchOperatorEvent,
  type KillSwitchOperatorEvent,
} from "../../lib/recruiting-ops/autonomy-operator-controls"
import {
  readKillSwitchStates,
  recordKillSwitchEvent,
  type DurableAppendResult,
} from "../../lib/recruiting-ops/durable-safety-store"
import { STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID } from "../../lib/recruiting-ops/delivery/staging-kill-switch"
import { createSupabaseSafetyStoreClient } from "../../lib/recruiting-ops/supabase-safety-store-client"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const STAGING_KILL_SWITCH_ACTIONS = ["ENGAGED", "DISENGAGED"] as const

export type StagingKillSwitchAction = (typeof STAGING_KILL_SWITCH_ACTIONS)[number]
export type StagingKillSwitchOperatorMode = "dry_run" | "execute"

export interface StagingKillSwitchOperatorInput {
  action: StagingKillSwitchAction
  operator: string
  reason: string
  mode: StagingKillSwitchOperatorMode
}

export interface StagingKillSwitchOperatorSummary {
  status: "dry_run" | "recorded"
  mode: StagingKillSwitchOperatorMode
  action: StagingKillSwitchAction
  scope: "global"
  scopeId: typeof STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID
  eventId: string
  switchBlocksStagingWrites: boolean
  durableSafetyStoreMutation: boolean
  durableStateVerified: boolean
  googleArtifactMutation: false
  outcome: "not_recorded" | DurableAppendResult["outcome"]
}

export interface StagingKillSwitchDurableStore {
  record(event: KillSwitchOperatorEvent): Promise<DurableAppendResult>
  readStates(): Promise<KillSwitchState[]>
}

export interface StagingKillSwitchOperatorDependencies {
  now(): Date
  createDurableStore(): StagingKillSwitchDurableStore
}

const MAX_OPERATOR_LENGTH = 120
const MAX_REASON_LENGTH = 1_000

const defaultDependencies: StagingKillSwitchOperatorDependencies = {
  now: () => new Date(),
  createDurableStore: () => {
    const client = createSupabaseSafetyStoreClient()
    return {
      record: (event) => recordKillSwitchEvent(event, client),
      readStates: () => readKillSwitchStates(client),
    }
  },
}

export function parseStagingKillSwitchOperatorArgs(argv: readonly string[]): StagingKillSwitchOperatorInput {
  let action: string | undefined
  let operator: string | undefined
  let reason: string | undefined
  let execute = false
  let explicitDryRun = false
  const seen = new Set<string>()

  for (const argument of argv) {
    if (argument === "--execute") {
      assertUniqueOption(seen, "--execute")
      execute = true
      continue
    }
    if (argument === "--dry-run") {
      assertUniqueOption(seen, "--dry-run")
      explicitDryRun = true
      continue
    }
    if (argument.startsWith("--action=")) {
      assertUniqueOption(seen, "--action")
      action = argument.slice("--action=".length).trim()
      continue
    }
    if (argument.startsWith("--operator=")) {
      assertUniqueOption(seen, "--operator")
      operator = argument.slice("--operator=".length).trim()
      continue
    }
    if (argument.startsWith("--reason=")) {
      assertUniqueOption(seen, "--reason")
      reason = argument.slice("--reason=".length).trim()
      continue
    }
    throw new Error(`Unknown option: ${safeOptionName(argument)}`)
  }

  if (execute && explicitDryRun) throw new Error("--execute and --dry-run are mutually exclusive")
  if (!STAGING_KILL_SWITCH_ACTIONS.includes(action as StagingKillSwitchAction)) {
    throw new Error("--action must be explicitly set to ENGAGED or DISENGAGED")
  }
  assertRequiredText(operator, "--operator", MAX_OPERATOR_LENGTH)
  assertRequiredText(reason, "--reason", MAX_REASON_LENGTH)

  return {
    action: action as StagingKillSwitchAction,
    operator,
    reason,
    mode: execute ? "execute" : "dry_run",
  }
}

export async function runStagingKillSwitchOperator(
  input: StagingKillSwitchOperatorInput,
  dependencies: StagingKillSwitchOperatorDependencies = defaultDependencies
): Promise<StagingKillSwitchOperatorSummary> {
  validateOperatorInput(input)
  const updatedAt = dependencies.now().toISOString()
  const enabled = input.action === "ENGAGED"
  const event = createKillSwitchOperatorEvent({
    scope: "global",
    scopeId: STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID,
    enabled,
    reason: input.reason,
    updatedAt,
    updatedBy: input.operator,
  })
  const base = {
    mode: input.mode,
    action: input.action,
    scope: "global" as const,
    scopeId: STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID as typeof STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID,
    eventId: event.eventId,
    switchBlocksStagingWrites: enabled,
    googleArtifactMutation: false as const,
  }

  if (input.mode === "dry_run") {
    return {
      ...base,
      status: "dry_run",
      durableSafetyStoreMutation: false,
      durableStateVerified: false,
      outcome: "not_recorded",
    }
  }

  try {
    const store = dependencies.createDurableStore()
    const outcome = await store.record(event)
    const states = await store.readStates()
    const persisted = states.find(
      (state) => state.scope === "global" && state.scopeId === STAGING_HYDRATION_KILL_SWITCH_SCOPE_ID
    )
    if (!persisted || !sameState(persisted, event.state)) {
      throw new Error("read-back did not match the requested state")
    }
    return {
      ...base,
      status: "recorded",
      durableSafetyStoreMutation: true,
      durableStateVerified: true,
      outcome: outcome.outcome,
    }
  } catch {
    // Do not surface database diagnostics because they may contain credentials
    // or operator-provided content. A failed confirmation is always fail-closed.
    throw new Error("Durable kill-switch update was not confirmed; treat staging hydration as blocked")
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const input = parseStagingKillSwitchOperatorArgs(argv)
  const summary = await runStagingKillSwitchOperator(input)
  console.log(JSON.stringify(summary, null, 2))
}

function validateOperatorInput(input: StagingKillSwitchOperatorInput): void {
  if (!STAGING_KILL_SWITCH_ACTIONS.includes(input.action)) {
    throw new Error("action must be ENGAGED or DISENGAGED")
  }
  if (input.mode !== "dry_run" && input.mode !== "execute") {
    throw new Error("mode must be dry_run or execute")
  }
  assertRequiredText(input.operator, "operator", MAX_OPERATOR_LENGTH)
  assertRequiredText(input.reason, "reason", MAX_REASON_LENGTH)
}

function sameState(actual: KillSwitchState, expected: KillSwitchState): boolean {
  return (
    actual.scope === expected.scope &&
    actual.scopeId === expected.scopeId &&
    actual.enabled === expected.enabled &&
    actual.reason === expected.reason &&
    actual.updatedAt === expected.updatedAt &&
    actual.updatedBy === expected.updatedBy
  )
}

function assertUniqueOption(seen: Set<string>, option: string): void {
  if (seen.has(option)) throw new Error(`Duplicate option: ${option}`)
  seen.add(option)
}

function assertRequiredText(value: string | undefined, option: string, maximumLength: number): asserts value is string {
  if (!value?.trim()) throw new Error(`${option} is required`)
  if (value.length > maximumLength) throw new Error(`${option} exceeds ${maximumLength} characters`)
}

function safeOptionName(argument: string): string {
  const option = argument.split("=", 1)[0]
  return option.startsWith("--") ? option : "positional argument"
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ""
if (invokedPath && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown operator error"
    console.error(`[staging-kill-switch] blocked: ${message.replace(/[\r\n]+/g, " ").slice(0, 300)}`)
    process.exitCode = 1
  })
}
