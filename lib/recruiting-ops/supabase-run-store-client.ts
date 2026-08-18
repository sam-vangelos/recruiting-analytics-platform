import { getSupabase } from "../supabase"
import type { RunStoreDatabaseClient } from "./run-store"

/**
 * The one supabase-js binding for the run store. Every error is thrown loudly —
 * the deployed-loaders lesson: a swallowed persistence error reads as "no data"
 * weeks later.
 */
export function createSupabaseRunStoreClient(): RunStoreDatabaseClient {
  const supabase = getSupabase()
  return {
    async selectRunChecksums(runId) {
      const { data, error } = await supabase
        .from("recruiting_ops_runs")
        .select("input_checksum, normalized_checksum, children_checksum")
        .eq("run_id", runId)
        .maybeSingle()
      if (error) {
        throw new Error(`run-store select failed for ${runId}: ${error.message}`)
      }
      return data ?? null
    },
    async selectChildRowCounts(runId) {
      const countFor = async (table: string): Promise<number> => {
        const { count, error } = await supabase
          .from(table)
          .select("*", { count: "exact", head: true })
          .eq("run_id", runId)
        if (error) throw new Error(`run-store child count failed for ${table}/${runId}: ${error.message}`)
        return count ?? 0
      }
      const [evidenceRefs, artifacts, sourceGaps, discrepancies] = await Promise.all([
        countFor("recruiting_ops_run_evidence_refs"),
        countFor("recruiting_ops_run_artifacts"),
        countFor("recruiting_ops_source_gaps"),
        countFor("recruiting_ops_discrepancies"),
      ])
      return { evidenceRefs, artifacts, sourceGaps, discrepancies }
    },
    async insertRows(table, rows) {
      if (rows.length === 0) return
      const { error } = await supabase.from(table).insert(rows as Record<string, unknown>[])
      if (error) {
        throw new Error(`run-store insert into ${table} failed (${rows.length} row(s)): ${error.message}`)
      }
    },
    async deleteRun(runId) {
      const { error } = await supabase.from("recruiting_ops_runs").delete().eq("run_id", runId)
      if (error) {
        throw new Error(`run-store compensating delete failed for ${runId}: ${error.message}`)
      }
    },
  }
}
