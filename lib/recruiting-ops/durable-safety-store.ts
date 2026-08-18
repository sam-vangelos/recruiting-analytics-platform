import type { AutonomyPromotionRecord, KillSwitchOperatorEvent } from "./autonomy-operator-controls"
import type { DeliverableAutonomyState, KillSwitchState } from "./autonomy"
import { createStableChecksum } from "./checksums"
import {
  deriveShadowLedgerHistory,
  serializeLocalDeliveryLedgerEntry,
  validateLocalDeliveryLedgerEntry,
  type LocalDeliveryLedgerEntry,
  type ShadowLedgerHistory,
  type ShadowLedgerHistoryInput,
} from "./delivery-ledger"

/**
 * Durable safety stores (migration 019): delivery ledger, kill-switch events,
 * autonomy state events. Pure orchestration over a minimal client — the
 * supabase-js binding lives in supabase-safety-store-client.ts.
 *
 * All three stores are APPEND-ONLY with P8 content-aware idempotency: replaying
 * an identical record is a no-op; the same id carrying different content throws.
 * Current state (switch engaged? autonomy state?) is derived from the latest
 * event, never mutated in place — the full operator audit trail is the table.
 */

export interface SafetyStoreDatabaseClient {
  selectDeliveryLedgerRows(deliverableId: string): Promise<{ delivery_log_id: string; content_fingerprint: string; entry: unknown }[]>
  insertDeliveryLedgerRow(row: Record<string, unknown>): Promise<void>
  selectKillSwitchEventRows(): Promise<{ event_id: string; content_fingerprint?: string; entry: unknown }[]>
  insertKillSwitchEventRow(row: Record<string, unknown>): Promise<void>
  selectAutonomyEventRows(deliverableId: string): Promise<{ promotion_id: string; entry: unknown }[]>
  insertAutonomyEventRow(row: Record<string, unknown>): Promise<void>
}

export interface DurableAppendResult {
  id: string
  outcome: "appended" | "already_recorded"
}

const KILL_SWITCH_READ_MAXIMUM_ATTEMPTS = 3
const KILL_SWITCH_READ_BASE_DELAY_MS = 100

export async function appendDurableDeliveryLedgerEntry(
  entry: LocalDeliveryLedgerEntry,
  client: SafetyStoreDatabaseClient
): Promise<DurableAppendResult> {
  const validated = validateLocalDeliveryLedgerEntry(entry)
  const contentFingerprint = createStableChecksum(serializeLocalDeliveryLedgerEntry(validated))
  const existing = await client.selectDeliveryLedgerRows(validated.deliverableId)
  const knownIds = new Set(existing.map((row) => row.delivery_log_id))
  const duplicate = existing.find((row) => row.delivery_log_id === validated.deliveryLogId)
  if (duplicate) {
    if (duplicate.content_fingerprint !== contentFingerprint) {
      throw new Error(
        `${validated.deliveryLogId} is already recorded with different content; ` +
          "a re-run over changed inputs must use a new runId, not overwrite ledger history"
      )
    }
    return { id: validated.deliveryLogId, outcome: "already_recorded" }
  }
  if (validated.correctionOf && !knownIds.has(validated.correctionOf)) {
    throw new Error(`${validated.deliveryLogId}.correctionOf references unknown ledger entry: ${validated.correctionOf}`)
  }
  if (validated.supersededBy && !knownIds.has(validated.supersededBy)) {
    throw new Error(`${validated.deliveryLogId}.supersededBy references unknown ledger entry: ${validated.supersededBy}`)
  }
  await client.insertDeliveryLedgerRow({
    delivery_log_id: validated.deliveryLogId,
    deliverable_id: validated.deliverableId,
    capability_id: validated.capabilityId,
    run_id: validated.runId,
    event_type: validated.eventType,
    status: validated.status,
    payload_fingerprint: validated.payloadFingerprint,
    content_fingerprint: contentFingerprint,
    created_at: validated.createdAt,
    entry: validated,
  })
  return { id: validated.deliveryLogId, outcome: "appended" }
}

export async function readDurableDeliveryLedgerEntries(
  deliverableId: string,
  client: SafetyStoreDatabaseClient
): Promise<LocalDeliveryLedgerEntry[]> {
  const rows = await client.selectDeliveryLedgerRows(deliverableId)
  return rows.map((row) => validateLocalDeliveryLedgerEntry(row.entry as LocalDeliveryLedgerEntry))
}

export async function collectDurableShadowLedgerHistory(
  input: Omit<ShadowLedgerHistoryInput, "rootDir">,
  client: SafetyStoreDatabaseClient
): Promise<ShadowLedgerHistory> {
  const entries = await readDurableDeliveryLedgerEntries(input.deliverableId, client)
  return deriveShadowLedgerHistory(entries, input)
}

export async function recordKillSwitchEvent(
  event: KillSwitchOperatorEvent,
  client: SafetyStoreDatabaseClient
): Promise<DurableAppendResult> {
  const contentFingerprint = createStableChecksum(JSON.stringify(event.state))
  const existing = await readKillSwitchEventRowsWithRetry(client)
  const duplicate = existing.find((row) => row.event_id === event.eventId)
  if (duplicate) {
    const duplicateFingerprint =
      duplicate.content_fingerprint ??
      createStableChecksum(JSON.stringify((duplicate.entry as KillSwitchOperatorEvent).state))
    if (duplicateFingerprint !== contentFingerprint) {
      throw new Error(`Kill-switch event ${event.eventId} is already recorded with different content`)
    }
    return { id: event.eventId, outcome: "already_recorded" }
  }
  await client.insertKillSwitchEventRow({
    event_id: event.eventId,
    scope: event.state.scope,
    scope_id: event.state.scopeId,
    enabled: event.state.enabled,
    reason: event.state.reason,
    updated_at: event.state.updatedAt,
    updated_by: event.state.updatedBy,
    entry: event,
  })
  return { id: event.eventId, outcome: "appended" }
}

/**
 * Current kill-switch states: the latest event per (scope, scopeId). Includes
 * DISENGAGED states so callers can present affirmative evidence ("the switch
 * exists and is off"), not just absence.
 */
export async function readKillSwitchStates(client: SafetyStoreDatabaseClient): Promise<KillSwitchState[]> {
  const rows = await readKillSwitchEventRowsWithRetry(client)
  const latestByScope = new Map<string, KillSwitchState>()
  for (const row of rows) {
    const state = (row.entry as KillSwitchOperatorEvent).state
    const key = `${state.scope}|${state.scopeId}`
    const stateMs = parseEventTimestamp(state.updatedAt, `kill-switch event ${row.event_id}`)
    const current = latestByScope.get(key)
    if (!current) {
      latestByScope.set(key, state)
      continue
    }
    const currentMs = parseEventTimestamp(current.updatedAt, `kill-switch state ${key}`)
    // Strictly newer wins; an exact-timestamp tie resolves to ENGAGED — when
    // event order is unknowable, the safe reading is "the switch is on".
    if (stateMs > currentMs || (stateMs === currentMs && state.enabled && !current.enabled)) {
      latestByScope.set(key, state)
    }
  }
  return [...latestByScope.values()]
}

async function readKillSwitchEventRowsWithRetry(
  client: SafetyStoreDatabaseClient
): ReturnType<SafetyStoreDatabaseClient["selectKillSwitchEventRows"]> {
  let lastError: unknown
  for (let attempt = 0; attempt < KILL_SWITCH_READ_MAXIMUM_ATTEMPTS; attempt += 1) {
    try {
      return await client.selectKillSwitchEventRows()
    } catch (error) {
      lastError = error
      if (attempt < KILL_SWITCH_READ_MAXIMUM_ATTEMPTS - 1) {
        await new Promise<void>((resolve) => setTimeout(
          resolve,
          KILL_SWITCH_READ_BASE_DELAY_MS * (2 ** attempt)
        ))
      }
    }
  }
  throw lastError
}

/**
 * Fail loud on corruption, never silently freeze state (the same posture as
 * deriveShadowLedgerHistory): an unparseable timestamp that entered as NaN
 * would win every `>=` comparison forever and pin a scope's derived state.
 */
function parseEventTimestamp(value: string, label: string): number {
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    throw new Error(`Corrupt timestamp on ${label}: ${JSON.stringify(value)} does not parse`)
  }
  return ms
}

export async function recordAutonomyPromotion(
  record: AutonomyPromotionRecord,
  client: SafetyStoreDatabaseClient
): Promise<DurableAppendResult> {
  const existing = await client.selectAutonomyEventRows(record.deliverableId)
  const duplicate = existing.find((row) => row.promotion_id === record.promotionId)
  if (duplicate) {
    const same =
      JSON.stringify((duplicate.entry as AutonomyPromotionRecord).resolvedState) ===
      JSON.stringify(record.resolvedState)
    if (!same) {
      throw new Error(`Autonomy promotion ${record.promotionId} is already recorded with different content`)
    }
    return { id: record.promotionId, outcome: "already_recorded" }
  }
  await client.insertAutonomyEventRow({
    promotion_id: record.promotionId,
    deliverable_id: record.deliverableId,
    capability_id: record.capabilityId,
    from_state: record.fromState,
    requested_state: record.requestedState,
    resolved_state: record.resolvedState,
    result: record.result,
    occurred_at: record.operatorControl.createdAt,
    entry: record,
  })
  return { id: record.promotionId, outcome: "appended" }
}

/**
 * Current autonomy state for a deliverable: the latest APPROVED promotion's
 * resolved state, or null when no approved promotion exists (callers fall back
 * to the contract's initial state).
 */
export async function readCurrentAutonomyState(
  deliverableId: string,
  client: SafetyStoreDatabaseClient
): Promise<DeliverableAutonomyState | null> {
  const rows = await client.selectAutonomyEventRows(deliverableId)
  const approved = rows
    .map((row) => row.entry as AutonomyPromotionRecord)
    .filter((record) => record.result === "approved_local_state")
    .sort((a, b) => {
      const aMs = parseEventTimestamp(a.operatorControl.createdAt, `autonomy promotion ${a.promotionId}`)
      const bMs = parseEventTimestamp(b.operatorControl.createdAt, `autonomy promotion ${b.promotionId}`)
      // Exact ties order deterministically by promotion id — never by insert order.
      return aMs - bMs || a.promotionId.localeCompare(b.promotionId)
    })
  const latest = approved[approved.length - 1]
  return latest ? latest.resolvedState : null
}
