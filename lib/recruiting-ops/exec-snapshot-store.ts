import { getSupabase } from "../supabase"
import type { ExecStateBundle } from "./modules/exec-state-of-play"

/**
 * Durable exec snapshot (migration 021, recruiting_ops_exec_snapshot) — the
 * plane's first row-content store, scoped to what /state-of-play renders:
 * per-req rows whose only person-identifying content is finalist names +
 * Greenhouse profile URLs, the org rollup, hires, and the ELT facts. One row
 * per E01 run; the page reads the latest. Service-role only (RLS
 * deny-by-default with no policies).
 */

export interface ExecSnapshotRow {
  run_id: string
  workflow_id: string
  mode: string
  generated_at: string
  org_rollup: ExecStateBundle["rollup"]
  req_rows: ExecStateBundle["rows"]
  hires: ExecStateBundle["hires"]
  elt_facts: unknown | null
}

export interface ExecSnapshotWriteInput {
  runId: string
  mode: "fixture" | "local" | "shadow" | "production_disabled"
  generatedAt: string
  bundle: ExecStateBundle
  eltFacts?: unknown
}

export interface ExecSnapshotDatabaseClient {
  upsert(table: string, row: Record<string, unknown>, onConflict: string): Promise<void>
  selectLatest(table: string): Promise<Record<string, unknown> | null>
}

export function createSupabaseExecSnapshotClient(): ExecSnapshotDatabaseClient {
  return {
    async upsert(table, row, onConflict) {
      const { error } = await getSupabase().from(table).upsert(row, { onConflict })
      if (error) throw new Error(`exec snapshot upsert failed: ${error.message}`)
    },
    async selectLatest(table) {
      const { data, error } = await getSupabase()
        .from(table)
        .select("run_id, workflow_id, mode, generated_at, org_rollup, req_rows, hires, elt_facts")
        .order("generated_at", { ascending: false })
        .limit(1)
      if (error) throw new Error(`exec snapshot read failed: ${error.message}`)
      return (data?.[0] as Record<string, unknown> | undefined) ?? null
    },
  }
}

export const EXEC_SNAPSHOT_TABLE = "recruiting_ops_exec_snapshot"

export function execSnapshotPersistenceRow(input: ExecSnapshotWriteInput): Record<string, unknown> {
  return {
    run_id: input.runId,
    workflow_id: "E01",
    mode: input.mode,
    generated_at: input.generatedAt,
    org_rollup: input.bundle.rollup,
    req_rows: input.bundle.rows,
    hires: input.bundle.hires,
    elt_facts: input.eltFacts ?? null,
  }
}

export async function writeExecSnapshot(
  input: ExecSnapshotWriteInput,
  client: ExecSnapshotDatabaseClient = createSupabaseExecSnapshotClient()
): Promise<void> {
  await client.upsert(EXEC_SNAPSHOT_TABLE, execSnapshotPersistenceRow(input), "run_id")
}

export type LatestExecSnapshot =
  | { status: "available"; snapshot: ExecSnapshotRow }
  | { status: "unavailable"; reason: string }

/**
 * Read the latest snapshot for the page. Returns an honest unavailable state
 * instead of throwing — the page renders "no snapshot yet", never a 500.
 */
export async function loadLatestExecSnapshot(
  client?: ExecSnapshotDatabaseClient
): Promise<LatestExecSnapshot> {
  try {
    const row = await (client ?? createSupabaseExecSnapshotClient()).selectLatest(EXEC_SNAPSHOT_TABLE)
    if (!row) return { status: "unavailable", reason: "no snapshot rows yet — run the E01 workflow" }
    return { status: "available", snapshot: row as unknown as ExecSnapshotRow }
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) }
  }
}
