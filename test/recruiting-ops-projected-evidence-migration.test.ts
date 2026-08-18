import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const sql = readFileSync(
  "supabase/migrations/027_recruiting_ops_projected_hydration_evidence.sql",
  "utf8"
).toLowerCase()

describe("projected hydration evidence migration", () => {
  test("adds one immutable invoker validator and validates one additive constraint", () => {
    expect(sql.match(/create or replace function/g)).toHaveLength(1)
    expect(sql).toContain("language plpgsql\nimmutable\nsecurity invoker")
    expect(sql).not.toContain("security definer")
    expect(sql).toContain("from public")
    expect(sql).toContain("array['anon', 'authenticated', 'service_role']")
    expect(sql).toContain(
      "revoke all on function public.recruiting_ops_projected_evidence_valid(text, text, text, text, integer, text, text, jsonb, text, text) from %i"
    )
    expect(sql).toContain("check (public.recruiting_ops_projected_evidence_valid(")
    expect(sql).toContain(") not valid")
    expect(sql).toContain("validate constraint recruiting_ops_projected_evidence_valid_check")
  })

  test("is forward-only and leaves pre-existing evidence and RPCs untouched", () => {
    expect(sql).toContain("is distinct from 'projected_dry_run' then\n    return true")
    expect(sql).not.toMatch(/\badd column\b|\bcreate index\b|\bcreate unique index\b/)
    expect(sql).not.toMatch(/\bupdate\s+public\.recruiting_ops_hydration_artifact_attempts\b/)
    expect(sql).not.toContain("create or replace function public.finish_recruiting_ops")
    expect(sql).not.toContain("create or replace function public.claim_recruiting_ops")
  })

  test("durably binds the projected certificate to zero mutation and its dated target", () => {
    for (const fragment of [
      "p_certification_evidence ?& projected_evidence_keys",
      "p_certification_evidence - projected_evidence_keys <> '{}'::jsonb",
      "p_artifact_key is distinct from 'delivery_roles_rps'",
      "p_status is distinct from 'terminal'",
      "p_outcome is distinct from 'no_change'",
      "p_mutation_call_count is distinct from 0",
      "p_version_after is not null",
      "p_failure_code is not null",
      "p_failure_stage is not null",
      "p_certification_evidence ? 'after_structure_hash'",
      "'exact_preimage_plus_deterministic_requests'",
      "'target_absent_observed'",
      "'observed_drive_version'",
      "'projected_changed_range_count'",
      "'projected_preimage_fingerprint'",
      "'desired_payload_fingerprint'",
      "'^delivery_rps_dated_rollover_[0-9]{8}$'",
      "projected_date := make_date",
      "projected_sheet_id := 1980000000 +",
      "projected_sheet_id > 2147483647",
    ]) {
      expect(sql).toContain(fragment)
    }
  })
})
