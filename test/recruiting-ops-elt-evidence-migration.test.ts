import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const sql = readFileSync(
  "supabase/migrations/028_recruiting_ops_elt_hydration_evidence.sql",
  "utf8"
).toLowerCase()

describe("ELT hydration evidence migration", () => {
  test("adds one immutable invoker validator and validates one additive constraint", () => {
    expect(sql.match(/create or replace function/g)).toHaveLength(1)
    expect(sql).toContain("language plpgsql\nimmutable\nsecurity invoker")
    expect(sql).not.toContain("security definer")
    expect(sql).toContain("from public")
    expect(sql).toContain("array['anon', 'authenticated', 'service_role']")
    expect(sql).toContain(
      "revoke all on function public.recruiting_ops_elt_evidence_valid(text, text, text, text, integer, text, text, jsonb, text, text) from %i"
    )
    expect(sql).toContain("check (public.recruiting_ops_elt_evidence_valid(")
    expect(sql).toContain(") not valid")
    expect(sql).toContain("validate constraint recruiting_ops_elt_evidence_valid_check")
  })

  test("is forward-only and leaves orchestration storage and RPCs untouched", () => {
    expect(sql).not.toMatch(/\badd column\b|\bcreate index\b|\bcreate unique index\b/)
    expect(sql).not.toMatch(/\bupdate\s+public\.recruiting_ops_hydration_artifact_attempts\b/)
    expect(sql).not.toContain("create or replace function public.finish_recruiting_ops")
    expect(sql).not.toContain("create or replace function public.claim_recruiting_ops")
  })

  test("preserves legacy successful ELT evidence and opts in only by exact contract label", () => {
    expect(sql).toContain("preserve every pre-028 evidence shape")
    expect(sql).toContain(
      "if p_certification_evidence is null\n     or jsonb_typeof(p_certification_evidence) is distinct from 'object' then\n    return true;"
    )
    expect(sql).toContain(
      "if jsonb_typeof(p_certification_evidence -> 'evidence_contract')\n       is distinct from 'string'\n     or p_certification_evidence ->> 'evidence_contract'\n       is distinct from 'elt_fact_table_v1' then\n    return true;"
    )
    expect(sql.indexOf("preserve every pre-028 evidence shape")).toBeLessThan(
      sql.indexOf("not (p_certification_evidence ?& evidence_keys)")
    )
  })

  test("rejects incomplete successful ELT certificates and binds every outcome shape", () => {
    for (const fragment of [
      "p_artifact_key is distinct from 'elt_doc'",
      "p_outcome not in ('written', 'no_change')",
      "p_certification_evidence ?& evidence_keys",
      "p_certification_evidence - evidence_keys <> '{}'::jsonb",
      "'elt_fact_table_v1'",
      "'internal_review_identifiers'",
      "'exact_owner_and_service_writer'",
      "'weekly_fact_table'",
      "'dry_run_verified'",
      "'preimage_verified'",
      "'postimage_verified'",
      "'permission_fingerprint'",
      "'permission_fingerprint_after'",
      "'rollback_permission_fingerprint'",
      "'drive_version_before'",
      "'drive_version_after'",
      "'rollback_drive_version'",
      "'revision_before_fingerprint'",
      "'revision_after_fingerprint'",
      "'reporting_week'",
      "'snapshot_run_id'",
      "'snapshot_mode'",
      "is distinct from 'shadow'",
      "'source_generated_at'",
      "'template_hash'",
      "expected_snapshot_run_id := 'e01_'",
      "reporting_friday := source_date",
      "p_mutation_call_count = 0",
      "p_mutation_call_count = 1",
      "p_version_after <> p_version_before",
      "jsonb_typeof(p_certification_evidence -> 'drive_version_before') = 'string'",
      "jsonb_typeof(p_certification_evidence -> 'drive_version_after') = 'string'",
      "jsonb_typeof(p_certification_evidence -> 'permission_fingerprint_after') = 'string'",
      "char_length(p_certification_evidence ->> 'drive_version_after')",
      "collate \"c\"",
      "p_certification_evidence ->> 'rollback_request_count' ~ '^[1-9][0-9]*$'",
      "return coalesce((",
    ]) {
      expect(sql).toContain(fragment)
    }
    expect(sql.match(/return coalesce\(\(/g)).toHaveLength(3)
    expect(sql).not.toContain("::numeric")
  })
})
