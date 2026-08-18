import { createStableChecksum } from "./checksums"
import {
  discrepancyPersistenceRows,
  runArtifactPersistenceRows,
  runEvidenceRefPersistenceRows,
  runPersistenceRow,
  sourceGapPersistenceRows,
} from "./persistence"
import type { LocalCommandCenterWorkflowResult } from "./workflow-runner"

/**
 * Durable run-history store (C2). Pure orchestration over a minimal database
 * client so the recruiting-ops lib carries no supabase-js dependency — the
 * binding lives in supabase-run-store-client.ts.
 *
 * Idempotency contract (the P8 ledger rule, applied to runs): re-persisting a
 * run with identical checksums is a no-op; the same runId with DIFFERENT
 * checksums throws — a retry over changed inputs must mint a new runId, never
 * silently overwrite history.
 */

export interface RunStoreDatabaseClient {
  /** Returns the stored checksums for a run id, or null when absent. */
  selectRunChecksums(runId: string): Promise<{
    input_checksum: string
    normalized_checksum: string
    /** Null on rows persisted before migration 020. */
    children_checksum?: string | null
  } | null>
  /** Returns the stored child-row counts for a run id (torn-state detection). */
  selectChildRowCounts(runId: string): Promise<{
    evidenceRefs: number
    artifacts: number
    sourceGaps: number
    discrepancies: number
  }>
  /** Inserts rows into a command-center table; throws on any database error. */
  insertRows(table: string, rows: readonly Record<string, unknown>[]): Promise<void>
  /** Deletes a run row (children cascade) — the compensating action when a child insert fails. */
  deleteRun(runId: string): Promise<void>
}

export interface PersistedModuleRunSummary {
  runId: string
  workflowId: string
  outcome: "persisted" | "already_persisted"
  rowCounts: {
    evidenceRefs: number
    artifacts: number
    sourceGaps: number
    discrepancies: number
  }
}

const INSERT_CHUNK_SIZE = 500

export async function persistWorkflowRuns(
  result: LocalCommandCenterWorkflowResult,
  client: RunStoreDatabaseClient
): Promise<PersistedModuleRunSummary[]> {
  const summaries: PersistedModuleRunSummary[] = []
  for (const workflowId of result.moduleOrder) {
    const moduleResult = result.runs[workflowId]
    summaries.push(await persistModuleRun(moduleResult, client))
  }
  return summaries
}

interface PersistableModuleResult {
  run: Parameters<typeof runPersistenceRow>[0]
  discrepancies: Parameters<typeof discrepancyPersistenceRows>[0]
}

export async function persistModuleRun(
  moduleResult: PersistableModuleResult,
  client: RunStoreDatabaseClient
): Promise<PersistedModuleRunSummary> {
  const run = moduleResult.run
  const runRow = runPersistenceRow(run)
  const evidenceRefRows = runEvidenceRefPersistenceRows(run)
  const artifactRows = runArtifactPersistenceRows(run)
  const sourceGapRows = sourceGapPersistenceRows(run)
  const discrepancyRows = discrepancyPersistenceRows(moduleResult.discrepancies)

  // A duplicate id inside one run means two records share an identity — an
  // upstream grain bug (e.g. an application-keyed gap on interview-grain rows).
  // Caught here with the precise ids, never as an opaque PK violation mid-insert.
  assertUniqueIds(run.runId, "source gap", sourceGapRows.map((row) => row.id))
  assertUniqueIds(run.runId, "artifact", artifactRows.map((row) => row.artifact_id))
  assertUniqueIds(run.runId, "discrepancy", discrepancyRows.map((row) => row.id))

  // The parent checksums (inputs, normalized rows) do not cover gaps or
  // discrepancies (lens finding) — a dedicated child checksum closes the
  // silent-coalesce path where the same runId re-persists with different
  // gap/discrepancy content.
  const childrenChecksum = createStableChecksum({
    sourceGaps: sourceGapRows,
    discrepancies: discrepancyRows,
  })

  const existing = await client.selectRunChecksums(run.runId)
  if (existing) {
    if (existing.children_checksum != null && existing.children_checksum !== childrenChecksum) {
      throw new Error(
        `Run ${run.runId} is already persisted with different source-gap/discrepancy content — a retry over changed inputs must use a new runId, never overwrite run history.`
      )
    }
    if (
      existing.input_checksum === runRow.input_checksum &&
      existing.normalized_checksum === runRow.normalized_checksum
    ) {
      // Torn-state detection (lens finding): a prior persist that died between
      // the run insert and its children — or whose compensating delete failed —
      // leaves a run row whose checksums match while child rows are missing.
      // An unverified no-op here would freeze that corruption forever.
      const stored = await client.selectChildRowCounts(run.runId)
      const expected = {
        evidenceRefs: evidenceRefRows.length,
        artifacts: artifactRows.length,
        sourceGaps: sourceGapRows.length,
        discrepancies: discrepancyRows.length,
      }
      const torn = (Object.keys(expected) as (keyof typeof expected)[]).filter(
        (key) => stored[key] !== expected[key]
      )
      if (torn.length > 0) {
        throw new Error(
          `Run ${run.runId} is persisted with TORN children (${torn
            .map((key) => `${key}: stored ${stored[key]} vs expected ${expected[key]}`)
            .join("; ")}) — delete the run row (children cascade) and re-persist.`
        )
      }
      return {
        runId: run.runId,
        workflowId: run.workflowId,
        outcome: "already_persisted",
        rowCounts: { evidenceRefs: 0, artifacts: 0, sourceGaps: 0, discrepancies: 0 },
      }
    }
    throw new Error(
      `Run ${run.runId} is already persisted with different checksums — a retry over changed inputs must use a new runId, never overwrite run history.`
    )
  }

  await client.insertRows("recruiting_ops_runs", [
    { ...(runRow as unknown as Record<string, unknown>), children_checksum: childrenChecksum },
  ])
  try {
    await insertChunked(client, "recruiting_ops_run_evidence_refs", evidenceRefRows)
    await insertChunked(client, "recruiting_ops_run_artifacts", artifactRows)
    await insertChunked(client, "recruiting_ops_source_gaps", sourceGapRows)
    await insertChunked(client, "recruiting_ops_discrepancies", discrepancyRows)
  } catch (error) {
    // Never leave a run row without its children: a partial persist would read
    // as a clean run with zero gaps. Compensate (children cascade), then rethrow.
    // A failed compensation must surface BOTH failures — swallowing the insert
    // error behind the delete error (or vice versa) hides the root cause.
    try {
      await client.deleteRun(run.runId)
    } catch (compensationError) {
      throw new Error(
        `Run ${run.runId} child insert failed (${describeError(error)}) AND the compensating delete failed (${describeError(compensationError)}) — the run row is TORN; delete it manually before re-persisting.`
      )
    }
    throw error
  }

  return {
    runId: run.runId,
    workflowId: run.workflowId,
    outcome: "persisted",
    rowCounts: {
      evidenceRefs: evidenceRefRows.length,
      artifacts: artifactRows.length,
      sourceGaps: sourceGapRows.length,
      discrepancies: discrepancyRows.length,
    },
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertUniqueIds(runId: string, kind: string, ids: readonly string[]): void {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id)
    seen.add(id)
  }
  if (duplicates.size > 0) {
    const sample = [...duplicates].slice(0, 3).join(", ")
    throw new Error(
      `Run ${runId} carries ${duplicates.size} duplicate ${kind} id(s) (${sample}) — a ${kind} id must identify exactly one record; fix the builder's grain.`
    )
  }
}

async function insertChunked(
  client: RunStoreDatabaseClient,
  table: string,
  rows: readonly unknown[]
): Promise<void> {
  for (let start = 0; start < rows.length; start += INSERT_CHUNK_SIZE) {
    await client.insertRows(table, rows.slice(start, start + INSERT_CHUNK_SIZE) as Record<string, unknown>[])
  }
}
