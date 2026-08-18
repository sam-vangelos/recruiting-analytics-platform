import { describe, expect, test } from "vitest"
import { dedupeByKey } from "../lib/ytd-normalize"

// Pure unit coverage for the last-write-wins dedupe used at the ytd-extract persist boundary.
// The persist()-level proof that the four upsert batches are actually deduped lives in
// test/ytd-persist-dedupe.test.ts; this file pins the helper's contract in isolation.

describe("dedupeByKey", () => {
  test("collapses duplicate scalar keys, last write wins", () => {
    const rows = [
      { id: 1, v: "a" },
      { id: 2, v: "b" },
      { id: 1, v: "c" },
    ]
    const out = dedupeByKey(rows, (r) => String(r.id))
    expect(out).toHaveLength(2)
    // The surviving id:1 row carries the LATER value — it's the fully-mutated copy at the
    // persist boundary, so last-write-wins must keep it.
    expect(out.find((r) => r.id === 1)?.v).toBe("c")
    expect(out.find((r) => r.id === 2)?.v).toBe("b")
  })

  test("handles composite keys (job_id|user_id|owner_type)", () => {
    const rows = [
      { job_id: 20, user_id: 77, owner_type: "recruiter", active: true },
      { job_id: 20, user_id: 77, owner_type: "recruiter", active: false },
      { job_id: 20, user_id: 77, owner_type: "coordinator", active: true },
    ]
    const out = dedupeByKey(rows, (r) => `${r.job_id}|${r.user_id}|${r.owner_type}`)
    expect(out).toHaveLength(2)
    expect(out.find((r) => r.owner_type === "recruiter")?.active).toBe(false)
  })

  test("is a no-op when all keys are distinct (and preserves contents)", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const out = dedupeByKey(rows, (r) => String(r.id))
    expect(out).toHaveLength(3)
    expect(out.map((r) => r.id)).toEqual([1, 2, 3])
  })

  test("empty input yields empty output", () => {
    expect(dedupeByKey([] as Array<{ id: number }>, (r) => String(r.id))).toEqual([])
  })
})
