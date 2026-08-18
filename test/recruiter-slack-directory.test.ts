// P3 — recruiter -> slack directory. lookupSlackUserByEmail (fetch-stubbed) + the refresh loop's
// load-bearing guard: a missing_scope response STOPS the loop (no per-recruiter Slack retry storm).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

// ---- Supabase mock: the exact chains the refresh issues ----
const sb = vi.hoisted(() => {
  const state: { ytd: Array<{ primary_recruiter_id: number | null }>; dir: unknown[]; upserts: Array<Record<string, unknown>> } = {
    ytd: [],
    dir: [],
    upserts: [],
  }
  const ok = (data: unknown) => ({ data, error: null })
  function from(table: string) {
    const chain: Record<string, unknown> = {
      select: () => chain,
      not: () => chain,
      in: () => chain,
      range: (f: number) => {
        if (table === "ytd_application_facts") return Promise.resolve(ok(f === 0 ? state.ytd : []))
        if (table === "recruiter_slack_directory") return Promise.resolve(ok(f === 0 ? state.dir : []))
        return Promise.resolve(ok([]))
      },
      then<R>(onf: (v: { data: unknown; error: unknown }) => R) {
        // loadSlackIdsForRecruiters: .select().in() awaited without .range()
        return Promise.resolve(ok(state.dir)).then(onf)
      },
      upsert: (rows: Array<Record<string, unknown>>) => {
        state.upserts.push(...rows)
        return Promise.resolve(ok(null))
      },
    }
    return chain
  }
  return { client: { from }, state, reset() { state.ytd = []; state.dir = []; state.upserts = [] } }
})
vi.mock("../lib/supabase", () => ({ supabase: sb.client, getSupabase: () => sb.client }))

// ---- Greenhouse listUsers mock: maps id -> primary_email ----
const ghUsers = vi.hoisted(() => ({ byId: new Map<number, { id: number; primary_email: string | null }>() }))
vi.mock("../lib/greenhouse-evidence", () => ({
  listUsers: async (ids: Array<number | null | undefined>) =>
    ids.filter((id): id is number => typeof id === "number").map((id) => ghUsers.byId.get(id)).filter(Boolean),
}))

import { lookupSlackUserByEmail } from "../lib/slack-resolve"
import { refreshRecruiterSlackDirectory } from "../lib/recruiter-slack-directory"

function slackFetch(handler: (email: string) => Record<string, unknown>) {
  const spy = vi.fn(async (url: string) => {
    const email = new URL(String(url)).searchParams.get("email") ?? ""
    return { json: async () => handler(email) } as unknown as Response
  })
  vi.stubGlobal("fetch", spy)
  return spy
}

describe("lookupSlackUserByEmail", () => {
  beforeEach(() => vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test"))
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  test("ok -> resolved with the slack id", async () => {
    slackFetch(() => ({ ok: true, user: { id: "U123" } }))
    expect(await lookupSlackUserByEmail("a@x.com")).toEqual({ status: "resolved", slack_user_id: "U123" })
  })
  test("users_not_found -> slack_not_found", async () => {
    slackFetch(() => ({ ok: false, error: "users_not_found" }))
    expect(await lookupSlackUserByEmail("a@x.com")).toEqual({ status: "slack_not_found" })
  })
  test("missing_scope -> scope_blocked", async () => {
    slackFetch(() => ({ ok: false, error: "missing_scope" }))
    expect(await lookupSlackUserByEmail("a@x.com")).toEqual({ status: "scope_blocked" })
  })
  test("other error -> error", async () => {
    slackFetch(() => ({ ok: false, error: "ratelimited" }))
    expect((await lookupSlackUserByEmail("a@x.com")).status).toBe("error")
  })
})

describe("refreshRecruiterSlackDirectory", () => {
  beforeEach(() => {
    sb.reset()
    ghUsers.byId.clear()
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test")
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  test("dedups recruiter ids: two facts with the same owner -> one Slack lookup", async () => {
    sb.state.ytd = [{ primary_recruiter_id: 501 }, { primary_recruiter_id: 501 }, { primary_recruiter_id: 502 }]
    ghUsers.byId.set(501, { id: 501, primary_email: "r1@x.com" })
    ghUsers.byId.set(502, { id: 502, primary_email: "r2@x.com" })
    const spy = slackFetch(() => ({ ok: true, user: { id: "Uxx" } }))
    const result = await refreshRecruiterSlackDirectory()
    expect(result.scanned).toBe(2) // 501, 502 — deduped
    expect(spy).toHaveBeenCalledTimes(2)
    expect(result.resolved).toBe(2)
  })

  test("missing_scope STOPS the loop — no retry storm across recruiters", async () => {
    sb.state.ytd = [{ primary_recruiter_id: 1 }, { primary_recruiter_id: 2 }, { primary_recruiter_id: 3 }]
    for (const id of [1, 2, 3]) ghUsers.byId.set(id, { id, primary_email: `r${id}@x.com` })
    const spy = slackFetch(() => ({ ok: false, error: "missing_scope" }))
    const result = await refreshRecruiterSlackDirectory()
    expect(result.scope_blocked).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1) // stopped after the first scope_blocked
  })

  test("no email -> email_missing without a Slack call", async () => {
    sb.state.ytd = [{ primary_recruiter_id: 9 }]
    ghUsers.byId.set(9, { id: 9, primary_email: null })
    const spy = slackFetch(() => ({ ok: true, user: { id: "U" } }))
    const result = await refreshRecruiterSlackDirectory()
    expect(result.email_missing).toBe(1)
    expect(spy).not.toHaveBeenCalled()
  })
})
