import { getSupabase } from "../../supabase"
import type {
  HydrationArtifactAttempt,
  HydrationOrchestrationDatabaseClient,
  HydrationRunClaim,
} from "./hydration-orchestration-store"

export function createSupabaseHydrationOrchestrationClient(): HydrationOrchestrationDatabaseClient {
  const supabase = getSupabase()
  return {
    async claimRun(input) {
      const { data, error } = await supabase.rpc("claim_recruiting_ops_hydration_run", {
        p_dedupe_key: input.dedupeKey,
        p_business_date: input.businessDate,
        p_mode: input.mode,
        p_requested_artifacts: input.requestedArtifacts,
        p_owner_token: input.ownerToken,
        p_lease_seconds: input.leaseSeconds,
      })
      if (error) throw new Error(`hydration run claim failed: ${error.message}`)
      const row = Array.isArray(data) ? data[0] : data
      if (!row) throw new Error("hydration run claim returned no row")
      return {
        runId: String(row.run_id),
        claimAcquired: row.claim_acquired === true,
        status: String(row.status) as HydrationRunClaim["status"],
        outcome: (row.outcome ?? null) as HydrationRunClaim["outcome"],
        sourceExecutionId: optionalString(row.source_execution_id),
        sourceFingerprint: optionalString(row.source_fingerprint),
        sourceGeneratedAt: optionalString(row.source_generated_at),
      }
    },
    async bindRunSource(input) {
      const { data, error } = await supabase.rpc("bind_recruiting_ops_hydration_run_source", {
        p_run_id: input.runId,
        p_owner_token: input.ownerToken,
        p_source_execution_id: input.sourceExecutionId,
        p_source_fingerprint: input.sourceFingerprint,
        p_source_generated_at: input.sourceGeneratedAt,
      })
      if (error) throw new Error(`hydration source binding failed: ${error.message}`)
      return data === true
    },
    async heartbeatRun(input) {
      const { data, error } = await supabase.rpc("heartbeat_recruiting_ops_hydration_run", {
        p_run_id: input.runId,
        p_owner_token: input.ownerToken,
        p_lease_seconds: input.leaseSeconds,
      })
      if (error) throw new Error(`hydration run heartbeat failed: ${error.message}`)
      return data === true
    },
    async listAttempts(runId) {
      const { data, error } = await supabase
        .from("recruiting_ops_hydration_artifact_attempts")
        .select("attempt_id, run_id, artifact_key, attempt_no, source_execution_id, source_fingerprint, status, outcome, plan_fingerprint, mutation_call_count, version_before, version_after, certification_evidence, failure_code, failure_stage, started_at, completed_at")
        .eq("run_id", runId)
        .order("attempt_no", { ascending: true })
      if (error) throw new Error(`hydration attempt read failed: ${error.message}`)
      return (data ?? []).map(attemptFromRow)
    },
    async timeoutRunningAttempts(input) {
      const { error } = await supabase.rpc("timeout_recruiting_ops_hydration_artifact_attempts", {
        p_run_id: input.runId,
        p_owner_token: input.ownerToken,
        p_completed_at: input.completedAt,
      })
      if (error) throw new Error(`hydration stale-attempt recovery failed: ${error.message}`)
    },
    async insertAttempt(input) {
      const { data, error } = await supabase.rpc("start_recruiting_ops_hydration_artifact_attempt", {
        p_attempt_id: input.attemptId,
        p_run_id: input.runId,
        p_owner_token: input.ownerToken,
        p_artifact_key: input.artifactKey,
        p_attempt_no: input.attemptNo,
        p_source_execution_id: input.sourceExecutionId,
        p_source_fingerprint: input.sourceFingerprint,
        p_started_at: input.startedAt,
      })
      if (error) throw new Error(`hydration attempt insert failed: ${error.message}`)
      if (data !== true) throw new Error("hydration attempt insert lost its active run lease")
    },
    async finishAttempt(input) {
      const { data, error } = await supabase.rpc("finish_recruiting_ops_hydration_artifact_attempt", {
        p_attempt_id: input.attemptId,
        p_run_id: input.runId,
        p_owner_token: input.ownerToken,
        p_outcome: input.outcome,
        p_completed_at: input.completedAt,
        p_plan_fingerprint: input.planFingerprint ?? null,
        p_mutation_call_count: input.mutationCallCount ?? null,
        p_version_before: input.versionBefore ?? null,
        p_version_after: input.versionAfter ?? null,
        p_certification_evidence: input.certificationEvidence ?? null,
        p_failure_code: input.failureCode ?? null,
        p_failure_stage: input.failureStage ?? null,
      })
      if (error) throw new Error(`hydration attempt completion failed: ${error.message}`)
      return data === true
    },
    async finishRun(input) {
      const { data, error } = await supabase.rpc("finish_recruiting_ops_hydration_run", {
        p_run_id: input.runId,
        p_owner_token: input.ownerToken,
        p_outcome: input.outcome,
        p_completed_at: input.completedAt,
        p_public_summary: input.publicSummary,
      })
      if (error) throw new Error(`hydration run completion failed: ${error.message}`)
      return data === true
    },
  }
}

function attemptFromRow(row: Record<string, unknown>): HydrationArtifactAttempt {
  return {
    attemptId: String(row.attempt_id),
    runId: String(row.run_id),
    artifactKey: String(row.artifact_key) as HydrationArtifactAttempt["artifactKey"],
    attemptNo: Number(row.attempt_no),
    sourceExecutionId: String(row.source_execution_id),
    sourceFingerprint: String(row.source_fingerprint),
    status: String(row.status) as HydrationArtifactAttempt["status"],
    outcome: (row.outcome ?? null) as HydrationArtifactAttempt["outcome"],
    planFingerprint: optionalString(row.plan_fingerprint),
    mutationCallCount: row.mutation_call_count == null ? null : Number(row.mutation_call_count),
    versionBefore: optionalString(row.version_before),
    versionAfter: optionalString(row.version_after),
    certificationEvidence: (row.certification_evidence ?? null) as HydrationArtifactAttempt["certificationEvidence"],
    failureCode: optionalString(row.failure_code),
    failureStage: optionalString(row.failure_stage),
    startedAt: String(row.started_at),
    completedAt: optionalString(row.completed_at),
  }
}

function optionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}
