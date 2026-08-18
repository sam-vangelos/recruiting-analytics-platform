import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

// REGRESSION LOCK (was RED SPEC) — net-new high (completeness pass): the command-center
// migrations create PII-bearing tables (recruiting_ops_discrepancies.owner,
// redacted_payload_summary jsonb, public_summary jsonb) and under Supabase a table
// without RLS is anon-readable/writable via PostgREST the moment the schema is exposed —
// the analytics app's anonymous-PII cluster, recurring on the persistence side
// (the internal control-plane excavation audit (2026-06-26) §4.6).
// Locked contract: EVERY table the command-center migration creates enables row-level
// security with deny-by-default (no policies; anon/authenticated revoked). The migration
// lineage was renumbered 010→015 to clear main's parallel 010–014 lineage.

const migration = "supabase/migrations/015_recruiting_ops_command_center.sql"

describe("persistence RLS: command-center tables must enable deny-by-default row-level security", () => {
  const sql = readFileSync(join(process.cwd(), migration), "utf8").toLowerCase()

  test("the migration enables row level security", () => {
    expect(sql).toContain("enable row level security")
  })

  test("every created table enables RLS and revokes anon/authenticated", () => {
    const createdTables = [...sql.matchAll(/create table if not exists ([a-z0-9_]+)/g)].map(
      (match) => match[1]
    )
    expect(createdTables.length).toBeGreaterThanOrEqual(10)

    const missingRls = createdTables.filter(
      (table) => !sql.includes(`alter table ${table} enable row level security`)
    )
    const missingRevoke = createdTables.filter(
      (table) => !sql.includes(`revoke all on table ${table} from anon, authenticated`)
    )

    expect(missingRls).toEqual([])
    expect(missingRevoke).toEqual([])
  })

  test("no permissive policies are declared — deny-by-default", () => {
    expect(sql).not.toContain("create policy")
  })
})
