import { getSupabase } from "../supabase"
import type {
  SourceExecutionDatabaseClient,
  SourceExecutionRecord,
  SourceExecutionStatus,
} from "./source-execution-store"

type SourceExecutionSqlRow = {
  source_execution_id: string
  owner_token: string
  status: SourceExecutionStatus
  acquired_at: string
  leased_until: string
  completed_at: string | null
  source_generated_at: string | null
  source_fingerprint: string | null
  source_counts: Record<string, unknown> | null
  public_diagnostics: Record<string, unknown>
  source_payload: unknown | null
  source_payload_schema_version: number | null
  source_payload_checksum: string | null
}

/** The sole supabase-js binding for the reporting source-execution lease. */
export function createSupabaseSourceExecutionStoreClient(): SourceExecutionDatabaseClient {
  const supabase = getSupabase()
  return {
    async claim(input) {
      const { data, error } = await supabase.rpc("acquire_recruiting_ops_source_execution", {
        p_source_execution_id: input.sourceExecutionId,
        p_owner_token: input.ownerToken,
        p_lease_seconds: input.leaseSeconds,
      })
      if (error) throw new Error(`source-execution claim failed: ${error.message}`)
      return oneRow(data, "claim", false)
    },
    async complete(input) {
      const { data, error } = await supabase.rpc("complete_recruiting_ops_source_execution", {
        p_source_execution_id: input.sourceExecutionId,
        p_owner_token: input.ownerToken,
        p_source_generated_at: input.sourceGeneratedAt,
        p_source_fingerprint: input.sourceFingerprint,
        p_source_counts: input.sourceCounts,
        p_public_diagnostics: input.publicDiagnostics,
        p_source_payload: input.sourcePayload,
        p_source_payload_schema_version: input.sourcePayloadSchemaVersion,
        p_source_payload_checksum: input.sourcePayloadChecksum,
      })
      if (error) throw new Error(`source-execution completion failed: ${error.message}`)
      return oneRow(data, "completion", true)!
    },
    async fail(input) {
      const { data, error } = await supabase.rpc("fail_recruiting_ops_source_execution", {
        p_source_execution_id: input.sourceExecutionId,
        p_owner_token: input.ownerToken,
        p_public_diagnostics: input.publicDiagnostics,
      })
      if (error) throw new Error(`source-execution failure record failed: ${error.message}`)
      return oneRow(data, "failure", true)!
    },
    async heartbeat(input) {
      const { data, error } = await supabase.rpc("heartbeat_recruiting_ops_source_execution", {
        p_source_execution_id: input.sourceExecutionId,
        p_owner_token: input.ownerToken,
        p_lease_seconds: input.leaseSeconds,
      })
      if (error) throw new Error(`source-execution heartbeat failed: ${error.message}`)
      return data === true
    },
    async reapStale() {
      const { data, error } = await supabase.rpc(
        "reap_stale_recruiting_ops_source_execution_leases"
      )
      if (error) throw new Error(`source-execution lease reap failed: ${error.message}`)
      if (typeof data !== "number") throw new Error("source-execution lease reap returned no count")
      return data
    },
    async selectCompleted(sourceExecutionId) {
      const { data, error } = await supabase
        .from("recruiting_ops_source_executions")
        .select("*")
        .eq("source_execution_id", sourceExecutionId)
        .eq("status", "completed")
        .maybeSingle()
      if (error) throw new Error(`source-execution read failed: ${error.message}`)
      return data ? mapRow(data as SourceExecutionSqlRow) : null
    },
  }
}

function oneRow(data: unknown, operation: string, required: boolean): SourceExecutionRecord | null {
  if (!Array.isArray(data) || data.length > 1 || (required && data.length !== 1)) {
    throw new Error(`source-execution ${operation} returned an invalid row count`)
  }
  return data.length === 0 ? null : mapRow(data[0] as SourceExecutionSqlRow)
}

function mapRow(row: SourceExecutionSqlRow): SourceExecutionRecord {
  return {
    sourceExecutionId: row.source_execution_id,
    ownerToken: row.owner_token,
    status: row.status,
    acquiredAt: row.acquired_at,
    leasedUntil: row.leased_until,
    completedAt: row.completed_at,
    sourceGeneratedAt: row.source_generated_at,
    sourceFingerprint: row.source_fingerprint,
    sourceCounts: row.source_counts,
    publicDiagnostics: row.public_diagnostics,
    sourcePayload: row.source_payload,
    sourcePayloadSchemaVersion: row.source_payload_schema_version,
    sourcePayloadChecksum: row.source_payload_checksum,
  }
}
