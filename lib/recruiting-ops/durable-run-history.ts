import { getSupabase } from "../supabase"

/**
 * Read-side projection of durable run history (recruiting_ops_runs) for the
 * console. Public-safe by construction: run ids, workflow ids, modes,
 * statuses, timestamps, and counts from the run's own public summary — never
 * normalized row content.
 *
 * The console must render even when the store is unreachable, so this loader
 * reports failure as an honest state instead of throwing — an "unavailable"
 * label on the surface, never a silent fixture fallback pretending to be live.
 */

export interface DurableRunHistoryRow {
  runId: string
  workflowId: string
  capabilityId: string
  mode: string
  status: string
  startedAt: string
  normalizedRowCount: number
  sourceGapCount: number
  discrepancyCount: number
}

export type DurableRunHistory =
  | { status: "loaded"; runs: readonly DurableRunHistoryRow[]; loadedAt: string }
  | { status: "unavailable"; reason: string }

export async function loadDurableRunHistory(limit = 24): Promise<DurableRunHistory> {
  try {
    const { data, error } = await getSupabase()
      .from("recruiting_ops_runs")
      .select("run_id, workflow_id, capability_id, mode, status, started_at, normalized_row_count, public_summary")
      .order("started_at", { ascending: false })
      .limit(limit)
    if (error) {
      return { status: "unavailable", reason: `run-history read failed: ${error.message}` }
    }
    return {
      status: "loaded",
      loadedAt: new Date().toISOString(),
      runs: (data ?? []).map((row) => mapDurableRunRow(row as Record<string, unknown>)),
    }
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export function mapDurableRunRow(row: Record<string, unknown>): DurableRunHistoryRow {
  const publicSummary = (row.public_summary ?? {}) as Record<string, unknown>
  return {
    runId: String(row.run_id),
    workflowId: String(row.workflow_id),
    capabilityId: String(row.capability_id),
    mode: String(row.mode),
    status: String(row.status),
    startedAt: String(row.started_at),
    normalizedRowCount: Number(row.normalized_row_count ?? 0),
    sourceGapCount: Number(publicSummary.sourceGapCount ?? 0),
    discrepancyCount: Number(publicSummary.discrepancyCount ?? 0),
  }
}
