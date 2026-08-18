import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const sql = readFileSync(
  "supabase/migrations/030_recruiting_ops_lease_heartbeat.sql",
  "utf8"
).toLowerCase()

function functionBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = sql.indexOf("$$;", start)
  expect(end).toBeGreaterThan(start)
  return sql.slice(start, end)
}

/** The columns the function's UPDATE actually writes, read off its SET clause. */
function assignedColumns(body: string): string[] {
  const update = /update\s+public\.[a-z_]+\s+\w+\s+set\s+([\s\S]*?)\s+where\s/.exec(body)
  expect(update).not.toBeNull()
  return [...update![1].matchAll(/(?:^|,)\s*([a-z_]+)\s*=/g)].map((match) => match[1])
}

describe("hydration lease heartbeat migration", () => {
  test("a run heartbeat only extends a lease its exact owner still holds", () => {
    const body = functionBody("heartbeat_recruiting_ops_hydration_run")
    expect(body).toContain("set leased_until = now() + make_interval(secs => p_lease_seconds)")
    expect(body).toContain("and r.owner_token = p_owner_token")
    expect(body).toContain("and r.status <> 'terminal'")
    expect(body).toContain("and r.leased_until > now()")
    expect(body).toContain("return changed = 1")
  })

  test("a source heartbeat only extends a running lease its exact owner still holds", () => {
    const body = functionBody("heartbeat_recruiting_ops_source_execution")
    expect(body).toContain("set leased_until = now() + make_interval(secs => p_lease_seconds)")
    expect(body).toContain("and e.owner_token = p_owner_token")
    expect(body).toContain("and e.status = 'running'")
    expect(body).toContain("and e.leased_until > now()")
  })

  // The claim RPC deliberately revives a terminal partial/failed run (026:339).
  // A renewal must never be able to do that, or a tick racing finish_run would
  // push a completed run back to 'running' and wedge every later run — exactly
  // the failure this migration exists to remove.
  test("neither heartbeat can revive a terminal run or change any evidence column", () => {
    for (const name of [
      "heartbeat_recruiting_ops_hydration_run",
      "heartbeat_recruiting_ops_source_execution",
    ]) {
      const assigned = assignedColumns(functionBody(name))
      expect(assigned).not.toHaveLength(0)
      for (const column of assigned) {
        expect(["leased_until", "updated_at"]).toContain(column)
      }
    }
  })

  test("rejects a lease outside the supported window", () => {
    const runBody = functionBody("heartbeat_recruiting_ops_hydration_run")
    expect(runBody).toContain("p_lease_seconds < 60 or p_lease_seconds > 7200")
    const sourceBody = functionBody("heartbeat_recruiting_ops_source_execution")
    expect(sourceBody).toContain("p_lease_seconds < 60 or p_lease_seconds > 7200")
  })

  test("keeps both heartbeat RPCs service-role only", () => {
    expect(sql).toContain("revoke all on function %s from public")
    expect(sql).toContain(
      "grant execute on function public.heartbeat_recruiting_ops_hydration_run(uuid, uuid, integer)"
    )
    expect(sql).toContain(
      "grant execute on function public.heartbeat_recruiting_ops_source_execution(uuid, uuid, integer)"
    )
    expect(sql).toContain("to service_role;")
  })
})
