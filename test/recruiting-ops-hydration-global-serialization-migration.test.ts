import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const sql = readFileSync(
  "supabase/migrations/026_recruiting_ops_hydration_global_serialization.sql",
  "utf8"
).toLowerCase()

describe("hydration global serialization migration", () => {
  test("enforces exactly one nonterminal run and serializes the existing claim RPC", () => {
    expect(sql).toContain("drop index if exists public.idx_recops_hydration_run_one_active")
    expect(sql).not.toContain("create unique index if not exists idx_recops_hydration_run_one_active")
    expect(sql).toContain("on public.recruiting_ops_hydration_runs ((1))\n  where status <> 'terminal'")
    expect(sql).toContain("pg_catalog.pg_advisory_xact_lock")
    expect(sql).toContain("public.recruiting_ops_hydration_runs:global_claim")
    expect(sql).toContain("on conflict do nothing")
  })

  test("retires an expired different-dedupe run in source-first order with computed PII-free evidence", () => {
    const recovery = sql.slice(sql.indexOf("lock the source before attempts"), sql.indexOf("if not requested_run_found then"))
    expect(recovery.indexOf("for no key update")).toBeGreaterThanOrEqual(0)
    expect(recovery.indexOf("update public.recruiting_ops_hydration_artifact_attempts")).toBeGreaterThan(
      recovery.indexOf("for no key update")
    )
    expect(recovery.indexOf("update public.recruiting_ops_hydration_runs")).toBeGreaterThan(
      recovery.indexOf("update public.recruiting_ops_hydration_artifact_attempts")
    )
    expect(recovery).toContain("failure_code = 'hydration_run_lease_expired'")
    expect(recovery).toContain("failure_stage = 'claim_recovery'")
    expect(recovery).toContain("when completed_count = requested_count")
    expect(recovery).toContain("when latest_count = 0 then 'timed_out'")
    expect(recovery).toContain("jsonb_build_object")
  })

  test("normal owned timeout adds failure fields without erasing existing evidence", () => {
    const timeout = sql.slice(
      sql.indexOf("create or replace function public.timeout_recruiting_ops_hydration_artifact_attempts"),
      sql.indexOf("do $$", sql.indexOf("create or replace function public.timeout_recruiting_ops_hydration_artifact_attempts"))
    )
    expect(timeout).toContain("failure_code = 'hydration_attempt_timed_out'")
    expect(timeout).toContain("failure_stage = 'orchestration_recovery'")
    expect(timeout).not.toContain("plan_fingerprint =")
    expect(timeout).not.toContain("version_before =")
    expect(timeout).not.toContain("certification_evidence =")
  })

  test("keeps both replaced RPCs service-role only", () => {
    expect(sql).toContain("revoke all on function public.claim_recruiting_ops_hydration_run")
    expect(sql).toContain("revoke all on function public.timeout_recruiting_ops_hydration_artifact_attempts")
    expect(sql).toContain(") to service_role;")
  })
})
