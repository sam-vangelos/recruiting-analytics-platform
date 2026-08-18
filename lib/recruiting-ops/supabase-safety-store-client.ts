import { getSupabase } from "../supabase"
import type { SafetyStoreDatabaseClient } from "./durable-safety-store"

/** The one supabase-js binding for the durable safety stores (migration 019). */
export function createSupabaseSafetyStoreClient(): SafetyStoreDatabaseClient {
  const supabase = getSupabase()
  return {
    async selectDeliveryLedgerRows(deliverableId) {
      const { data, error } = await supabase
        .from("recruiting_ops_delivery_ledger")
        .select("delivery_log_id, content_fingerprint, entry")
        .eq("deliverable_id", deliverableId)
        .order("created_at", { ascending: true })
      if (error) throw new Error(`safety-store ledger select failed: ${error.message}`)
      return data ?? []
    },
    async insertDeliveryLedgerRow(row) {
      const { error } = await supabase.from("recruiting_ops_delivery_ledger").insert(row)
      if (error) throw new Error(`safety-store ledger insert failed: ${error.message}`)
    },
    async selectKillSwitchEventRows() {
      const { data, error } = await supabase
        .from("recruiting_ops_kill_switch_events")
        .select("event_id, entry")
        .order("updated_at", { ascending: true })
      if (error) throw new Error(`safety-store kill-switch select failed: ${error.message}`)
      return data ?? []
    },
    async insertKillSwitchEventRow(row) {
      const { error } = await supabase.from("recruiting_ops_kill_switch_events").insert(row)
      if (error) throw new Error(`safety-store kill-switch insert failed: ${error.message}`)
    },
    async selectAutonomyEventRows(deliverableId) {
      const { data, error } = await supabase
        .from("recruiting_ops_autonomy_state_events")
        .select("promotion_id, entry")
        .eq("deliverable_id", deliverableId)
        .order("occurred_at", { ascending: true })
      if (error) throw new Error(`safety-store autonomy select failed: ${error.message}`)
      return data ?? []
    },
    async insertAutonomyEventRow(row) {
      const { error } = await supabase.from("recruiting_ops_autonomy_state_events").insert(row)
      if (error) throw new Error(`safety-store autonomy insert failed: ${error.message}`)
    },
  }
}
