// W3 — notification delivery (outbox enqueue + drain worker) unit tests.
//
// WHAT THIS TESTS, AND WHY IT IS SHAPED THIS WAY
// ----------------------------------------------
// The unit under test is lib/notification-delivery.ts: the I/O half of the W3
// outbox+drain design (lib/notification-render.ts is the PURE half, exercised through
// buildNotification here but not re-asserted — its own purity is its contract). This
// module reads the alert_ledger, writes notification_outbox idempotently, claims work
// via the claim_notification_outbox RPC, talks to Slack, and appends
// notification_delivery_attempts rows (schema: supabase/migrations/006_notification_
// delivery.sql). All of that is I/O, so the tests drive it against:
//
//   * a MOCKED Supabase client — vi.mock("../lib/supabase") with a hand-built query
//     builder that records every call and returns scripted { data, error } results.
//     The module imports `supabase` from "./supabase" by RELATIVE path (notification-
//     delivery.ts:51), and this repo ships no vitest config / vite-tsconfig-paths, so
//     a relative-path mock is the seam that actually intercepts (the "@/" alias would
//     not — reconcile-identity.test.ts:6-9 documents that same alias gap). The mock is
//     installed via vi.hoisted so the factory can reference it despite vi.mock hoisting.
//   * the REAL send gate over a STUBBED env — vi.stubEnv drives NOTIFY_REFERRAL_SEND /
//     NOTIFY_AGENCY_SEND through the real readEnv (env.ts:1-4) so isChannelSendEnabled
//     (notification-delivery.ts:100-103) is exercised as written: only a literal "true"
//     sends; unset/blank/anything-else SUPPRESSES (the safety contract, 006 header).
//   * a STUBBED global fetch — postSlackDm (notification-delivery.ts:894-907) is the
//     ONLY network in the module; drainOne calls it via the module-local binding, so the
//     fetch spy is the seam that proves "Slack was / was not called". The gate-OFF test
//     asserts fetch was NOT invoked; the gate-ON test asserts it WAS and that the
//     returned `ts` lands on the attempt row as provider_message_id.
//
// The five behaviors pinned (the W3 acceptance set):
//   1. enqueue is IDEMPOTENT on dedupe_key — a re-enqueue over an outbox that already
//      holds the row inserts nothing, and the upsert is issued with the dedupe_key
//      conflict target + ignoreDuplicates (the DB-level backstop, 006:53).
//   2. gate OFF (env unset) => the intent is SUPPRESSED with suppression_reason=
//      'policy_disabled' and NO Slack send is made (fetch never called).
//   3. gate ON => Slack send IS made and a notification_delivery_attempts row is
//      recorded carrying provider_message_id (the Slack ts, 006:68).
//   4. a FAILED send records status='failed' WITHOUT ever stamping the intent 'sent'.
//   5. the reaper returns a leaked 'sending' lease to 'pending' (the RPC the crashed-
//      drain self-heal runs, 006:108) — asserted at the wrapper seam reap() owns.
//
// Mirrors the stub style of test/identity-resolver.test.ts (small typed builders, one
// override-per-case) and the vi.mock/vi.fn discipline of test/reconcile-identity.test.ts.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted Supabase mock. vi.mock is hoisted above the imports, so its factory cannot
// close over a normally-declared variable; vi.hoisted lifts the controller alongside it.
// The controller is a programmable fake of the PostgREST builder shaped to exactly the
// chains notification-delivery.ts issues (enumerated below), no more:
//
//   from(t).select(c)                         -> awaitable { data, error }   (outbox/ledger scan)
//   from(t).select(c).in(col,vals).order(...) -> awaitable { data, error }   (sweep_items / agency_submissions)
//   from(t).upsert(rows,opts).select(c)       -> awaitable { data, error }   (idempotent enqueue)
//   from(t).insert(row).select(c).single()    -> awaitable { data, error }   (append attempt)
//   from(t).update(patch).eq(col,val)         -> awaitable { error }         (stamp outbox)
//   rpc(name,args)                            -> awaitable { data, error }   (claim / reaper)
//
// Each terminal resolves from a per-table/-rpc script the test sets up; every call is
// recorded so a test can assert what was written (insert/upsert/update payloads) and
// what was read.
// ---------------------------------------------------------------------------

interface SupabaseResult<T = unknown> {
  data: T
  error: unknown
}

interface RecordedCall {
  table: string
  op: "select" | "upsert" | "insert" | "update"
  /** insert/upsert payload, or the update patch. */
  payload?: unknown
  /** upsert options ({ onConflict, ignoreDuplicates }). */
  options?: unknown
  /** the .eq() filter for an update. */
  eq?: { col: string; val: unknown }
}

const sb = vi.hoisted(() => {
  // Scripts: what each terminal returns. Keyed by table for from(), by name for rpc().
  // A function lets a script depend on call arguments (e.g. the upsert rows).
  type Script = (call: { args: unknown[] }) => SupabaseResult
  const selectScript = new Map<string, Script>()
  const upsertScript = new Map<string, Script>()
  const insertScript = new Map<string, Script>()
  const updateScript = new Map<string, Script>()
  const rpcScript = new Map<string, Script>()
  const calls: RecordedCall[] = []

  const ok = (data: unknown): SupabaseResult => ({ data, error: null })

  function from(table: string) {
    // A select chain. Terminal at .select() (resolves directly) OR after .in()/.order()
    // (PostgREST returns the same thenable from each filter). We make the object BOTH a
    // thenable and a holder of .in()/.order() so either await-point resolves identically.
    function makeSelectThenable(): PromiseLike<SupabaseResult> & {
      in: (col: string, vals: unknown[]) => ReturnType<typeof makeSelectThenable>
      order: (col: string, opts?: unknown) => ReturnType<typeof makeSelectThenable>
      range: (from: number, to: number) => ReturnType<typeof makeSelectThenable>
    } {
      const resolve = (): SupabaseResult =>
        (selectScript.get(table) ?? (() => ok([])))({ args: [] })
      const thenable = {
        then<TResult1 = SupabaseResult, TResult2 = never>(
          onfulfilled?:
            | ((value: SupabaseResult) => TResult1 | PromiseLike<TResult1>)
            | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ): PromiseLike<TResult1 | TResult2> {
          return Promise.resolve(resolve()).then(onfulfilled, onrejected)
        },
        in() {
          return thenable
        },
        order() {
          return thenable
        },
        // enqueuePending paginates the outbox + ledger scans with .range() (Q5). The
        // builder returns the SAME thenable from .range(), so a script that returns a
        // sub-1000-row page (the only sizes these tests use) ends the scanAll loop
        // after its first fetch — no infinite paging.
        range() {
          return thenable
        },
      }
      return thenable
    }

    return {
      select(_cols: string) {
        calls.push({ table, op: "select" })
        return makeSelectThenable()
      },
      upsert(rows: unknown, options: unknown) {
        calls.push({ table, op: "upsert", payload: rows, options })
        return {
          select(_cols: string) {
            return Promise.resolve(
              (upsertScript.get(table) ?? (() => ok([])))({ args: [rows] })
            )
          },
        }
      },
      insert(row: unknown) {
        calls.push({ table, op: "insert", payload: row })
        return {
          select(_cols: string) {
            return {
              single() {
                return Promise.resolve(
                  (insertScript.get(table) ?? (() => ok({ id: "attempt-default" })))({
                    args: [row],
                  })
                )
              },
            }
          },
        }
      },
      update(patch: unknown) {
        return {
          eq(col: string, val: unknown) {
            calls.push({ table, op: "update", payload: patch, eq: { col, val } })
            return Promise.resolve(
              (updateScript.get(table) ?? (() => ok(null)))({ args: [patch] })
            )
          },
        }
      },
    }
  }

  const client = {
    from,
    rpc(name: string, args: unknown) {
      return Promise.resolve(
        (rpcScript.get(name) ?? (() => ok(null)))({ args: [args] })
      )
    },
  }

  return {
    client,
    calls,
    selectScript,
    upsertScript,
    insertScript,
    updateScript,
    rpcScript,
    ok,
    reset() {
      calls.length = 0
      selectScript.clear()
      upsertScript.clear()
      insertScript.clear()
      updateScript.clear()
      rpcScript.clear()
    },
  }
})

// The module imports `supabase` (the Proxy) by relative path; replace it with our fake.
vi.mock("../lib/supabase", () => ({
  supabase: sb.client,
  getSupabase: () => sb.client,
}))

// Import AFTER the mock is registered. vi.mock is hoisted, so this static import already
// sees the mocked ./supabase. Pull in the exact public surface the five tests exercise.
import {
  enqueuePending,
  drain,
  reap,
  isChannelSendEnabled,
  type OutboxRow,
} from "../lib/notification-delivery"
import type { OutboxPayload } from "../lib/notification-delivery"
import { buildNotification } from "../lib/notification-render"

// ---------------------------------------------------------------------------
// Slack fetch stub. postSlackDm is conversations.open -> chat.postMessage; the stub
// returns a channel id then a `ts`, the two values the real two-call shape yields
// (notification-delivery.ts:894-907). A test can flip it to fail (ok:false) to drive
// the failed-send path. fetchSpy.mock.calls is the assertion seam for "Slack called?".
// ---------------------------------------------------------------------------

const SENT_TS = "1716900000.000200"

function installSlackOk(): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(async (url: string) => {
    const method = String(url).split("/api/")[1] ?? ""
    const body = method.startsWith("conversations.open")
      ? { ok: true, channel: { id: "D_HEAD_OF_TA" } }
      : { ok: true, ts: SENT_TS }
    return { json: async () => body } as unknown as Response
  })
  vi.stubGlobal("fetch", fetchSpy)
  return fetchSpy
}

function installSlackFail(error = "channel_not_found"): ReturnType<typeof vi.fn> {
  // conversations.open succeeds; chat.postMessage returns ok:false -> slackCall throws.
  const fetchSpy = vi.fn(async (url: string) => {
    const method = String(url).split("/api/")[1] ?? ""
    const body = method.startsWith("conversations.open")
      ? { ok: true, channel: { id: "D_HEAD_OF_TA" } }
      : { ok: false, error }
    return { json: async () => body } as unknown as Response
  })
  vi.stubGlobal("fetch", fetchSpy)
  return fetchSpy
}

// ---------------------------------------------------------------------------
// Builders. A claimed outbox row as claim_notification_outbox would return it: status
// already 'sending', attempt_count already incremented (006:96). payload is a valid
// referral NotificationIntent snapshot minus the promoted columns (OutboxPayload), so
// buildNotification renders a real recipient + text. Override per case.
// ---------------------------------------------------------------------------

const HEAD_OF_TA = "U0MAG0002" // SWEEP_CONFIG.slack.headOfTaUserId

function referralPayload(over: Partial<OutboxPayload> = {}): OutboxPayload {
  return {
    candidate_name: "Jane Candidate",
    job_title: "Staff Engineer",
    recruiter_owner_name: "Riley Recruiter",
    referrer_name: "Pat Referrer",
    current_stage: "Application Review",
    urgency_since: "26 hours ago",
    hours_in_stage: 26,
    recipient_user_id: HEAD_OF_TA,
    recipient_resolution_status: "resolved",
    ...over,
  } as OutboxPayload
}

function claimedRow(over: Partial<OutboxRow> = {}): OutboxRow {
  const now = new Date().toISOString()
  return {
    id: "outbox-1",
    dedupe_key: "referral:5001:sla_alerted",
    channel: "referral",
    notification_type: "referral_alert",
    reason: "sla_alerted",
    application_id: 5001,
    candidate_id: 9001,
    job_id: 7001,
    recipient_user_id: HEAD_OF_TA,
    recipient_resolution_status: "resolved",
    delivery_target: "slack_dm",
    payload: referralPayload(),
    status: "sending", // claim already moved it
    attempt_count: 1, // claim already incremented
    max_attempts: 5,
    next_attempt_at: now,
    leased_until: now,
    last_delivery_attempt_id: null,
    suppression_reason: null,
    created_at: now,
    updated_at: now,
    sent_at: null,
    ...over,
  }
}

/** Script claim_notification_outbox to lease exactly these rows; reaper to report n. */
function scriptDrain(rows: OutboxRow[], reaped = 0): void {
  sb.rpcScript.set("claim_notification_outbox", () => sb.ok(rows))
  sb.rpcScript.set("reap_stale_notification_leases", () => sb.ok(reaped))
  // Attempt inserts return a stable id; outbox stamps succeed.
  sb.insertScript.set("notification_delivery_attempts", () =>
    sb.ok({ id: "attempt-1" })
  )
  sb.updateScript.set("notification_outbox", () => sb.ok(null))
}

/** Pull the single recorded attempt insert (notification_delivery_attempts). */
function attemptInsert(): Record<string, unknown> | undefined {
  const call = sb.calls.find(
    (c) => c.table === "notification_delivery_attempts" && c.op === "insert"
  )
  return call?.payload as Record<string, unknown> | undefined
}

/** Pull every outbox stamp (update) issued, in order. */
function outboxStamps(): Array<Record<string, unknown>> {
  return sb.calls
    .filter((c) => c.table === "notification_outbox" && c.op === "update")
    .map((c) => c.payload as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Fixtures share a clean slate: reset the mock, clear env stubs, restore fetch.
// ---------------------------------------------------------------------------

beforeEach(() => {
  sb.reset()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  // Slack token present by default so the send path can run; the GATE (not the token)
  // is what the suppression tests turn off.
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test")
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ===========================================================================
// (1) enqueue is idempotent on dedupe_key.
// ===========================================================================

describe("enqueuePending — idempotent on dedupe_key", () => {
  // A ledger row whose FULL dedupe_key (channel:application_id:reason) already has an
  // outbox row must not be re-enqueued: the post-hydration pre-filter (Q1) drops it, so
  // no intent reaches the upsert and inserted stays 0. The reason axis is now part of
  // the key, so hydration runs FIRST (sweep_items is queried) and the dropped row is
  // matched on the full key — re-running the enqueue at the same tier is a no-op.
  test("a ledger row already present in the outbox at the same tier is not re-enqueued (inserted = 0)", async () => {
    // Outbox already holds referral:5001:sla_alerted (the FULL dedupe_key now).
    sb.selectScript.set("notification_outbox", () =>
      sb.ok([{ application_id: 5001, channel: "referral", reason: "sla_alerted" }])
    )
    // The ledger reports the SAME alert.
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([
        {
          application_id: 5001,
          sweep_type: "referral",
          greenhouse_stage_at_alert: "Application Review",
          first_alerted_at: "2026-05-27T00:00:00Z",
          last_alerted_at: "2026-05-27T12:00:00Z",
          resolved_at: null,
        },
      ])
    )
    // Hydration runs before the dedupe filter now (the tier is the reason). The live
    // tier is still 'alerted' => sla_alerted => same key, so it's dropped.
    sb.selectScript.set("sweep_items", () =>
      sb.ok([
        {
          application_id: 5001,
          candidate_id: 9001,
          job_id: 7001,
          candidate_name: "Jane Candidate",
          job_title: "Staff Engineer",
          source_name: "Referral",
          current_stage: "Application Review",
          urgency_tier: "alerted",
          hours_in_current_stage: 26,
          last_activity_at: "2026-05-27T00:00:00Z",
          application_created_at: "2026-05-26T00:00:00Z",
          referrer_name: "Pat Referrer",
          recruiter_name: "Riley Recruiter",
          ownership_resolution_status: "resolved",
          conflict_detail: null,
          created_at: "2026-05-27T12:00:00Z",
        },
      ])
    )

    const result = await enqueuePending()

    expect(result.candidates).toBe(0) // dropped by the full-key pre-filter
    expect(result.inserted).toBe(0)
    // No upsert was attempted — every built intent matched an existing key.
    expect(sb.calls.some((c) => c.table === "notification_outbox" && c.op === "upsert")).toBe(
      false
    )
  })

  // The complementary half: a NEW ledger row (no outbox row yet) IS enqueued, and the
  // write is the idempotent upsert — onConflict:'dedupe_key', ignoreDuplicates:true
  // (notification-delivery.ts:355). That option pair is what makes a concurrent/duplicate
  // enqueue a no-op at the DB level (006:53 unique constraint), so a second run that races
  // the pre-filter still cannot double-insert. We assert the option shape AND the derived
  // dedupe_key on the upserted row.
  test("a new ledger row is upserted with the dedupe_key conflict target + ignoreDuplicates", async () => {
    sb.selectScript.set("notification_outbox", () => sb.ok([])) // empty outbox
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([
        {
          application_id: 5001,
          sweep_type: "referral",
          greenhouse_stage_at_alert: "Application Review",
          first_alerted_at: "2026-05-27T00:00:00Z",
          last_alerted_at: "2026-05-27T12:00:00Z",
        },
      ])
    )
    // sweep_items hydration: an 'alerted' tier yields reason 'sla_alerted' (the only
    // alerting tier here), so the intent is buildable and reaches the upsert.
    sb.selectScript.set("sweep_items", () =>
      sb.ok([
        {
          application_id: 5001,
          candidate_id: 9001,
          job_id: 7001,
          candidate_name: "Jane Candidate",
          job_title: "Staff Engineer",
          source_name: "Referral",
          current_stage: "Application Review",
          urgency_tier: "alerted",
          hours_in_current_stage: 26,
          last_activity_at: "2026-05-27T00:00:00Z",
          application_created_at: "2026-05-26T00:00:00Z",
          referrer_name: "Pat Referrer",
          recruiter_name: "Riley Recruiter",
          ownership_resolution_status: "resolved",
          conflict_detail: null,
          created_at: "2026-05-27T12:00:00Z",
        },
      ])
    )
    // The upsert returns the one inserted row.
    sb.upsertScript.set("notification_outbox", () =>
      sb.ok([{ id: "outbox-1", channel: "referral" }])
    )

    const result = await enqueuePending()

    expect(result.candidates).toBe(1)
    expect(result.inserted).toBe(1)
    expect(result.byChannel.referral).toBe(1)

    const upsert = sb.calls.find(
      (c) => c.table === "notification_outbox" && c.op === "upsert"
    )
    expect(upsert, "an upsert must have been issued for the new alert").toBeDefined()
    // The idempotency contract on the write itself.
    expect(upsert!.options).toEqual({
      onConflict: "dedupe_key",
      ignoreDuplicates: true,
    })
    // The deterministic key the unique constraint dedupes on.
    const rows = upsert!.payload as Array<{ dedupe_key: string; status: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].dedupe_key).toBe("referral:5001:sla_alerted")
    expect(rows[0].status).toBe("pending")
  })

  // operator decision 2026-08-06: the first alert must fire at DETECTION (~1h), not at the old 24h threshold.
  // A referral under 24h carries urgency_tier 'new' (sweep-types.ts:83); before this change
  // referralReasonFromTier returned null for 'new' and buildReferralIntentForLedger skipped it,
  // so nothing was sent until hour 24. The two assertions below are a pair and must stay one
  // test: 'new' has to ALERT, and it has to alert under the SAME reason as 'alerted' so the
  // later 24h tick collapses onto this row's dedupe_key. Split them into distinct reasons and
  // every referral silently doubles its DM count.
  test("a sub-24h 'new' tier alerts immediately, under the same dedupe_key as the 24h tier", async () => {
    sb.selectScript.set("notification_outbox", () => sb.ok([]))
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([
        {
          application_id: 5001,
          sweep_type: "referral",
          greenhouse_stage_at_alert: "Application Review",
          first_alerted_at: "2026-05-27T00:00:00Z",
          last_alerted_at: "2026-05-27T00:00:00Z",
        },
      ])
    )
    sb.selectScript.set("sweep_items", () =>
      sb.ok([
        {
          application_id: 5001,
          candidate_id: 9001,
          job_id: 7001,
          candidate_name: "Jane Candidate",
          job_title: "Staff Engineer",
          source_name: "Referral",
          current_stage: "Application Review",
          // The whole point: one hour in stage, well under the old 24h gate.
          urgency_tier: "new",
          hours_in_current_stage: 1,
          last_activity_at: "2026-05-27T00:00:00Z",
          application_created_at: "2026-05-27T00:00:00Z",
          referrer_name: "Pat Referrer",
          recruiter_name: "Riley Recruiter",
          ownership_resolution_status: "resolved",
          conflict_detail: null,
          created_at: "2026-05-27T01:00:00Z",
        },
      ])
    )
    sb.upsertScript.set("notification_outbox", () =>
      sb.ok([{ id: "outbox-new", channel: "referral" }])
    )

    const result = await enqueuePending()

    expect(result.inserted, "a 1-hour-old referral must produce an alert").toBe(1)

    const upsert = sb.calls.find(
      (c) => c.table === "notification_outbox" && c.op === "upsert"
    )
    const rows = upsert!.payload as Array<{ dedupe_key: string; reason: string }>
    expect(rows[0].reason).toBe("sla_alerted")
    // Byte-identical to the key the 'alerted' tier produces (asserted in the test above), which
    // is what makes the 24h tick a no-op instead of a second DM.
    expect(rows[0].dedupe_key).toBe("referral:5001:sla_alerted")
  })

  // 015 — THE OWNER LIST MUST COME FROM THE HOURLY SWEEP, NOT THE DAILY TABLE.
  //
  // ytd_application_facts is written once a day by ytd-incremental (06:30 UTC). Reading only that
  // meant a referral arriving after 06:30 had no owners until the next morning, so its hour-1 alert
  // — the whole point of the feature — fell back to the head-of-TA. Measured live 2026-08-07: five
  // of six same-day alerts had no facts row at all.
  //
  // The fixture makes the two sources DISAGREE on purpose: the sweep knows two recruiters, the
  // daily table knows one different one. Fan-out must key on the sweep's pair. If this ever passes
  // with 5555 in the keys, the enqueuer has gone back to the stale source.
  test("015: fan-out uses the sweep's hourly owner list, not the daily facts list", async () => {
    vi.stubEnv("NOTIFY_RECIPIENT_MODE", "recruiter")
    vi.stubEnv("NOTIFY_RECRUITER_ROUTING_FROM", "2020-01-01T00:00:00Z")
    sb.selectScript.set("notification_outbox", () => sb.ok([]))
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([
        {
          application_id: 5003,
          sweep_type: "referral",
          greenhouse_stage_at_alert: "Application Review",
          first_alerted_at: "2026-05-27T00:00:00Z",
          last_alerted_at: "2026-05-27T00:00:00Z",
        },
      ])
    )
    sb.selectScript.set("sweep_items", () =>
      sb.ok([
        {
          application_id: 5003,
          candidate_id: 9003,
          job_id: 7003,
          candidate_name: "Fresh Referral",
          job_title: "Software Engineer",
          urgency_tier: "new",
          recruiter_ids: [1111, 2222], // the hourly truth
          recruiter_name: null,
          ownership_resolution_status: null,
          created_at: "2026-05-27T00:30:00Z",
        },
      ])
    )
    sb.selectScript.set("ytd_application_facts", () =>
      sb.ok([
        {
          application_id: 5003,
          primary_recruiter_id: 5555,
          primary_recruiter_name: "Stale Owner",
          recruiter_ids: [5555], // yesterday's answer — must NOT win
        },
      ])
    )
    sb.upsertScript.set("notification_outbox", () => sb.ok([{ id: "o-1", channel: "referral" }]))

    await enqueuePending()

    const upsert = sb.calls.find((c) => c.table === "notification_outbox" && c.op === "upsert")
    const rows = upsert!.payload as Array<{ dedupe_key: string; payload: { recruiter_id: number | null; recruiter_count: number | null } }>
    expect(rows.map((r) => r.dedupe_key).sort()).toEqual([
      "referral:5003:sla_alerted:1111",
      "referral:5003:sla_alerted:2222",
    ])
    expect(rows.map((r) => r.payload.recruiter_id).sort()).toEqual([1111, 2222])
    expect(rows[0].payload.recruiter_count).toBe(2)
  })

  // An EMPTY sweep list falls through to the daily table rather than being read as "no owners".
  // Empty is indistinguishable from a filtering bug in the sweep, and stale owners route better
  // than none. Locking the fallback so a future "simplification" cannot drop it.
  test("015: an empty sweep owner list falls back to the daily facts list", async () => {
    vi.stubEnv("NOTIFY_RECIPIENT_MODE", "recruiter")
    vi.stubEnv("NOTIFY_RECRUITER_ROUTING_FROM", "2020-01-01T00:00:00Z")
    sb.selectScript.set("notification_outbox", () => sb.ok([]))
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([
        {
          application_id: 5004,
          sweep_type: "referral",
          greenhouse_stage_at_alert: "Application Review",
          first_alerted_at: "2026-05-27T00:00:00Z",
          last_alerted_at: "2026-05-27T00:00:00Z",
        },
      ])
    )
    sb.selectScript.set("sweep_items", () =>
      sb.ok([
        {
          application_id: 5004,
          candidate_id: 9004,
          job_id: 7004,
          candidate_name: "Empty List",
          job_title: "Software Engineer",
          urgency_tier: "alerted",
          recruiter_ids: [],
          recruiter_name: null,
          ownership_resolution_status: null,
          created_at: "2026-05-27T00:30:00Z",
        },
      ])
    )
    sb.selectScript.set("ytd_application_facts", () =>
      sb.ok([
        { application_id: 5004, primary_recruiter_id: 7777, primary_recruiter_name: "Fallback Owner", recruiter_ids: [7777] },
      ])
    )
    sb.upsertScript.set("notification_outbox", () => sb.ok([{ id: "o-2", channel: "referral" }]))

    await enqueuePending()
    const upsert = sb.calls.find((c) => c.table === "notification_outbox" && c.op === "upsert")
    const rows = upsert!.payload as Array<{ dedupe_key: string }>
    expect(rows.map((r) => r.dedupe_key)).toEqual(["referral:5004:sla_alerted:7777"])
  })

  test("P2: recruiter owner name + routing metadata come from ytd_application_facts", async () => {
    sb.selectScript.set("notification_outbox", () => sb.ok([]))
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([
        {
          application_id: 5002,
          sweep_type: "referral",
          greenhouse_stage_at_alert: "Application Review",
          first_alerted_at: "2026-05-27T00:00:00Z",
          last_alerted_at: "2026-05-27T12:00:00Z",
        },
      ])
    )
    // sweep_items has NO recruiter (null name/status) — proving the owner comes from ytd, which
    // is the whole point of P2 (sweep_items.recruiter_id is dormant in prod).
    sb.selectScript.set("sweep_items", () =>
      sb.ok([
        {
          application_id: 5002,
          candidate_id: 9002,
          job_id: 7002,
          candidate_name: "the operator Candidate",
          job_title: "Staff Engineer",
          urgency_tier: "alerted",
          recruiter_name: null,
          ownership_resolution_status: null,
          created_at: "2026-05-27T12:00:00Z",
        },
      ])
    )
    sb.selectScript.set("ytd_application_facts", () =>
      sb.ok([
        {
          application_id: 5002,
          primary_recruiter_id: 4381126004,
          primary_recruiter_name: "Avery Collins",
          recruiter_ids: [4381126004],
        },
      ])
    )
    sb.upsertScript.set("notification_outbox", () => sb.ok([{ id: "outbox-2", channel: "referral" }]))

    await enqueuePending()
    const upsert = sb.calls.find((c) => c.table === "notification_outbox" && c.op === "upsert")
    const rows = upsert!.payload as Array<{
      payload: {
        recruiter_owner_name: string | null
        recruiter_id: number | null
        recruiter_count: number | null
      }
    }>
    expect(rows[0].payload.recruiter_owner_name).toBe("Avery Collins")
    expect(rows[0].payload.recruiter_id).toBe(4381126004)
    expect(rows[0].payload.recruiter_count).toBe(1)
  })

  // Idempotency made literal: the upsert ignoreDuplicates path returns ZERO rows when the
  // key already exists (PostgREST returns only actually-inserted rows). The SAME enqueue
  // run therefore reports inserted=0 even though it issued the upsert — re-enqueue does not
  // duplicate. This models the race the pre-filter cannot catch (two drains enqueueing at
  // once); the DB constraint is the backstop and inserted reflects it honestly.
  test("re-enqueue whose upsert hits the existing key inserts nothing (inserted = 0)", async () => {
    sb.selectScript.set("notification_outbox", () => sb.ok([])) // pre-filter sees nothing yet
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([
        {
          application_id: 5001,
          sweep_type: "referral",
          greenhouse_stage_at_alert: "Application Review",
          first_alerted_at: "2026-05-27T00:00:00Z",
          last_alerted_at: "2026-05-27T12:00:00Z",
        },
      ])
    )
    sb.selectScript.set("sweep_items", () =>
      sb.ok([
        {
          application_id: 5001,
          candidate_id: 9001,
          job_id: 7001,
          candidate_name: "Jane Candidate",
          job_title: "Staff Engineer",
          source_name: "Referral",
          current_stage: "Application Review",
          urgency_tier: "alerted",
          hours_in_current_stage: 26,
          last_activity_at: "2026-05-27T00:00:00Z",
          application_created_at: "2026-05-26T00:00:00Z",
          referrer_name: "Pat Referrer",
          recruiter_name: "Riley Recruiter",
          ownership_resolution_status: "resolved",
          conflict_detail: null,
          created_at: "2026-05-27T12:00:00Z",
        },
      ])
    )
    // ignoreDuplicates: the conflicting row is NOT returned -> empty result set.
    sb.upsertScript.set("notification_outbox", () => sb.ok([]))

    const result = await enqueuePending()

    // It DID attempt the write (the row looked new to the pre-filter)...
    expect(sb.calls.some((c) => c.table === "notification_outbox" && c.op === "upsert")).toBe(
      true
    )
    // ...but the duplicate was ignored, so nothing was inserted.
    expect(result.inserted).toBe(0)
    expect(result.byChannel.referral).toBe(0)
  })
})

// ===========================================================================
// (2) gate OFF (env unset) => suppressed 'policy_disabled', NO Slack send.
// ===========================================================================

describe("drain — gate OFF suppresses with policy_disabled and never calls Slack", () => {
  // The headline safety test. NOTIFY_REFERRAL_SEND is left UNSET (beforeEach unstubs all
  // env), so isChannelSendEnabled('referral') is false (notification-delivery.ts:100-103):
  // an unset/blank gate SUPPRESSES. drainOne therefore takes the policy_disabled branch
  // (notification-delivery.ts:642-646) BEFORE any Slack call — the deploy-behavior-neutral
  // contract (006 header). The recipient is fully resolved (head-of-TA), so this is the
  // gate firing, not a recipient defect.
  test("an unset gate suppresses the intent (policy_disabled) and makes no fetch call", async () => {
    const fetchSpy = installSlackOk() // wired, but must never be called
    expect(isChannelSendEnabled("referral")).toBe(false) // precondition: gate is OFF

    scriptDrain([claimedRow()])

    const result = await drain(50)

    // Outcome accounting: one claimed, one suppressed, zero sent/failed.
    expect(result.claimed).toBe(1)
    expect(result.suppressed).toBe(1)
    expect(result.sent).toBe(0)
    expect(result.failed).toBe(0)

    // THE assertion: Slack was never contacted.
    expect(fetchSpy).not.toHaveBeenCalled()

    // The attempt row is suppressed with the policy reason and carries no provider id.
    const attempt = attemptInsert()
    expect(attempt).toBeDefined()
    expect(attempt!.status).toBe("suppressed")
    expect(attempt!.suppression_reason).toBe("policy_disabled")
    expect(attempt!.provider_message_id).toBeNull()

    // The intent is stamped suppressed/policy_disabled — never 'sent'.
    const stamp = outboxStamps().at(-1)!
    expect(stamp.status).toBe("suppressed")
    expect(stamp.suppression_reason).toBe("policy_disabled")
    expect(stamp.sent_at).toBeUndefined()
  })

  // A blank gate is the SAME as unset (readEnv trims to undefined, env.ts:1-3): still
  // suppressed, still no send. Guards the "blank means suppress" clause explicitly, since
  // a deploy that sets the var to "" must not be read as enabling.
  test("a blank gate value also suppresses and makes no fetch call", async () => {
    vi.stubEnv("NOTIFY_REFERRAL_SEND", "   ")
    const fetchSpy = installSlackOk()
    expect(isChannelSendEnabled("referral")).toBe(false)

    scriptDrain([claimedRow()])
    const result = await drain(50)

    expect(result.suppressed).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(attemptInsert()!.suppression_reason).toBe("policy_disabled")
  })
})

// ===========================================================================
// (3) gate ON => Slack IS called and an attempt row records provider_message_id.
// ===========================================================================

describe("drain — gate ON sends and records provider_message_id", () => {
  // Flip NOTIFY_REFERRAL_SEND to the literal "true" (the only accepted value). drainOne
  // now reaches postSlackDm, which runs conversations.open + chat.postMessage over the
  // stubbed fetch and returns the chat.postMessage `ts`. recordSentAttempt
  // (notification-delivery.ts:721-750) writes a 'sent' attempt carrying that ts as
  // provider_message_id (the value 006:68 says slack-notify.ts currently discards) and the
  // SAME path stamps the intent terminal 'sent' with the attempt id.
  test("gate ON makes the Slack call and persists the returned ts as provider_message_id", async () => {
    vi.stubEnv("NOTIFY_REFERRAL_SEND", "true")
    const fetchSpy = installSlackOk()
    expect(isChannelSendEnabled("referral")).toBe(true) // precondition: gate is ON

    scriptDrain([claimedRow()])

    const result = await drain(50)

    expect(result.claimed).toBe(1)
    expect(result.sent).toBe(1)
    expect(result.suppressed).toBe(0)
    expect(result.failed).toBe(0)

    // Slack WAS contacted: both calls of the two-call DM shape fired.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const calledMethods = fetchSpy.mock.calls.map((c) =>
      String(c[0]).split("/api/")[1]?.split("?")[0]
    )
    expect(calledMethods).toContain("conversations.open")
    expect(calledMethods).toContain("chat.postMessage")

    // The attempt row records the physical send + the provider message id.
    const attempt = attemptInsert()
    expect(attempt).toBeDefined()
    expect(attempt!.status).toBe("sent")
    expect(attempt!.provider).toBe("slack")
    expect(attempt!.provider_message_id).toBe(SENT_TS)
    expect(attempt!.recipient_user_id).toBe(HEAD_OF_TA)
    expect(attempt!.outbox_ids).toEqual(["outbox-1"])
    expect(attempt!.intent_count).toBe(1)
    expect(attempt!.suppression_reason).toBeNull()

    // The intent is stamped 'sent' with the attempt id and a sent_at.
    const stamp = outboxStamps().at(-1)!
    expect(stamp.status).toBe("sent")
    expect(stamp.last_delivery_attempt_id).toBe("attempt-1")
    expect(stamp.sent_at).toEqual(expect.any(String))
    expect(stamp.suppression_reason).toBeNull()
  })

  // P4 RELAXED GATE: in recruiter mode, an intent whose recruiter has NO resolved slack id falls
  // back to head-of-TA with status 'unresolved' — and MUST still SEND (the old gate would have
  // suppressed it on status !== 'resolved'). This is the load-bearing guard: get it wrong and
  // recruiter mode silently drops the cold-start + ambiguous tail.
  test("recruiter mode, no slack id -> head-of-TA fallback SENDS, not suppressed", async () => {
    vi.stubEnv("NOTIFY_REFERRAL_SEND", "true")
    vi.stubEnv("NOTIFY_RECIPIENT_MODE", "recruiter")
    vi.stubEnv("NOTIFY_RECRUITER_ROUTING_FROM", "2020-01-01T00:00:00Z")
    const fetchSpy = installSlackOk()

    // The intent carries a recruiter_id, but recruiter_slack_directory is unscripted -> the lookup
    // returns no slack id -> resolveRecipient falls back to the real head-of-TA, 'unresolved'.
    // The dedupe_key must carry the 4th (recruiter) segment: only fan-out rows are eligible for
    // drain-time redirect, so a 3-segment key here would test the legacy path instead of this one.
    scriptDrain([
      claimedRow({
        dedupe_key: "referral:5001:sla_alerted:501",
        payload: referralPayload({ recruiter_id: 501, recruiter_count: 1 }),
      }),
    ])

    const result = await drain(50)

    expect(result.sent).toBe(1) // SENT despite 'unresolved' status — the relaxed gate
    expect(result.suppressed).toBe(0)
    const attempt = attemptInsert()
    expect(attempt!.status).toBe("sent")
    expect(attempt!.recipient_user_id).toBe("U00000000001") // real config head-of-TA fallback
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  // THE BACKLOG GUARANTEE, DRAIN SIDE (operator decision 2026-08-06: "They should ONLY receive messages that
  // send at some point after the capability is switched on").
  //
  // Suppressing the backlog at ENQUEUE is not sufficient on its own. Rows already sitting 'pending'
  // at the instant of the flip were written under the old 3-segment key for the head-of-TA, and
  // they are claimed AFTERWARDS — at which point loadRecipientRefresh would happily re-resolve
  // them to a recruiter and hand over a pre-switch-on alert through the back door. Only fan-out
  // rows (4-segment key) may be redirected at drain.
  //
  // This test exists because the guard was NOT covered: deleting the key-length condition left the
  // whole suite green in a mutation run. Without it, the leak ships silently.
  test("a legacy 3-part-key row is NEVER redirected to a recruiter, even with one resolved", async () => {
    vi.stubEnv("NOTIFY_REFERRAL_SEND", "true")
    vi.stubEnv("NOTIFY_RECIPIENT_MODE", "recruiter")
    vi.stubEnv("NOTIFY_RECRUITER_ROUTING_FROM", "2020-01-01T00:00:00Z")
    const fetchSpy = installSlackOk()

    // The directory DOES hold a slack id for this recruiter, so the only thing standing between
    // this pre-flip alert and recruiter 501's DMs is the key-shape guard.
    sb.selectScript.set("recruiter_slack_directory", () =>
      sb.ok([{ greenhouse_user_id: 501, slack_user_id: "U_RECRUITER_501" }])
    )
    scriptDrain([
      claimedRow({
        dedupe_key: "referral:5001:sla_alerted", // 3 segments => enqueued before the flip
        payload: referralPayload({ recruiter_id: 501, recruiter_count: 1 }),
      }),
    ])

    const result = await drain(50)

    expect(result.sent).toBe(1)
    const attempt = attemptInsert()
    // The row keeps the recipient FROZEN at enqueue (the head-of-TA it was built for), rather than
    // being re-resolved. Note this is the fixture's HEAD_OF_TA, not the SWEEP_CONFIG constant the
    // sibling test asserts — that one IS redirected, so its fallback is computed live; this one is
    // never redirected at all, which is the whole point.
    expect(
      attempt!.recipient_user_id,
      "a pre-switch-on alert must keep its head-of-TA recipient, never reach a recruiter"
    ).toBe(HEAD_OF_TA)
    expect(attempt!.recipient_user_id).not.toBe("U_RECRUITER_501")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  // A 4-segment key whose last part is NOT the payload's recruiter id is a legacy row, not a
  // fan-out row. Production holds two of these from a manual test in May 2026
  // (`referral:163643253004:sla_risk:test_v2` and `...:manual_test`). Counting segments would
  // classify them as fan-out and redirect them — the opposite of what the guard is for.
  test("a 4-segment key with a non-numeric suffix is treated as legacy, not fan-out", async () => {
    vi.stubEnv("NOTIFY_REFERRAL_SEND", "true")
    vi.stubEnv("NOTIFY_RECIPIENT_MODE", "recruiter")
    vi.stubEnv("NOTIFY_RECRUITER_ROUTING_FROM", "2020-01-01T00:00:00Z")
    const fetchSpy = installSlackOk()

    sb.selectScript.set("recruiter_slack_directory", () =>
      sb.ok([{ greenhouse_user_id: 501, slack_user_id: "U_RECRUITER_501" }])
    )
    scriptDrain([
      claimedRow({
        dedupe_key: "referral:163643253004:sla_risk:manual_test",
        payload: referralPayload({ recruiter_id: 501, recruiter_count: 1 }),
      }),
    ])

    const result = await drain(50)

    expect(result.sent).toBe(1)
    expect(
      attemptInsert()!.recipient_user_id,
      "a suffix that is not the payload's recruiter id must not make this a fan-out row"
    ).toBe(HEAD_OF_TA)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  // The gate is PER-CHANNEL: referral ON does not enable agency. An agency intent with the
  // agency gate still unset is suppressed (policy_disabled) and makes no send, even though
  // the referral gate is true. Pins isChannelSendEnabled's channel keying
  // (notification-delivery.ts:95-103) so a single-channel rollout can't leak the other.
  test("the gate is per-channel: referral ON does not send an agency intent", async () => {
    vi.stubEnv("NOTIFY_REFERRAL_SEND", "true") // referral on
    // NOTIFY_AGENCY_SEND left unset -> agency stays off.
    const fetchSpy = installSlackOk()
    expect(isChannelSendEnabled("agency")).toBe(false)

    scriptDrain([
      claimedRow({
        id: "outbox-agency-1",
        dedupe_key: "agency:6002:prior_history",
        channel: "agency",
        notification_type: "agency_conflict",
        reason: "prior_history",
        application_id: 6002,
        payload: referralPayload({
          agency_name: "Acme Staffing",
          prior_applications: [],
        }),
      }),
    ])

    const result = await drain(50)

    expect(result.suppressed).toBe(1)
    expect(result.sent).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(attemptInsert()!.suppression_reason).toBe("policy_disabled")
  })
})

// ===========================================================================
// (4) a failed send records status='failed' WITHOUT marking sent.
// ===========================================================================

describe("drain — a failed send records 'failed' and never stamps 'sent'", () => {
  // Gate ON so the send is actually attempted; Slack's chat.postMessage returns ok:false,
  // so slackCall throws and drainOne's catch runs recordFailedAttempt
  // (notification-delivery.ts:653-657, :752-792). The claimed row is at its LAST attempt
  // (attempt_count == max_attempts), so the intent terminates at 'failed' rather than
  // backing off to 'pending' — making the "not sent" assertion unambiguous on the outbox
  // stamp as well as the attempt row.
  test("a Slack failure writes a 'failed' attempt (no provider id) and never a 'sent' stamp", async () => {
    vi.stubEnv("NOTIFY_REFERRAL_SEND", "true")
    const fetchSpy = installSlackFail("channel_not_found")

    scriptDrain([claimedRow({ attempt_count: 5, max_attempts: 5 })]) // exhausted

    const result = await drain(50)

    expect(result.claimed).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.sent).toBe(0)
    expect(result.suppressed).toBe(0)

    // Slack was attempted (the failure is a real send outcome, not a suppression).
    expect(fetchSpy).toHaveBeenCalled()

    // The attempt row is 'failed', carries the error, and has NO provider_message_id.
    const attempt = attemptInsert()
    expect(attempt).toBeDefined()
    expect(attempt!.status).toBe("failed")
    expect(attempt!.provider_message_id).toBeNull()
    expect(attempt!.error_message).toContain("channel_not_found")
    expect(attempt!.sent_at).toBeNull()

    // CRITICAL: the intent was never marked 'sent'. Exhausted => terminal 'failed'.
    const stamps = outboxStamps()
    for (const s of stamps) expect(s.status).not.toBe("sent")
    const last = stamps.at(-1)!
    expect(last.status).toBe("failed")
    // A failed terminal stamp does not set sent_at.
    expect(last.sent_at).toBeUndefined()
  })

  // The non-terminal failure: a row with attempts remaining (attempt_count < max_attempts)
  // is NOT marked sent either — it goes back to 'pending' with a backoff next_attempt_at
  // for a later tick (notification-delivery.ts:784-791). Same invariant (never 'sent'),
  // different terminal, so the retry path is covered without a separate concern.
  test("a retriable failure returns the intent to 'pending' with backoff, still not 'sent'", async () => {
    vi.stubEnv("NOTIFY_REFERRAL_SEND", "true")
    installSlackFail("ratelimited")

    scriptDrain([claimedRow({ attempt_count: 1, max_attempts: 5 })]) // 4 attempts left

    const result = await drain(50)
    expect(result.failed).toBe(1)
    expect(result.sent).toBe(0)

    const last = outboxStamps().at(-1)!
    expect(last.status).toBe("pending")
    expect(last.status).not.toBe("sent")
    // Backoff scheduled a future retry; the lease was released.
    expect(last.next_attempt_at).toEqual(expect.any(String))
    expect(new Date(last.next_attempt_at as string).getTime()).toBeGreaterThan(Date.now())
    expect(last.leased_until).toBeNull()
  })
})

// ===========================================================================
// (5) the reaper returns a leaked 'sending' lease to pending.
// ===========================================================================

describe("reap — returns leaked 'sending' leases to pending", () => {
  // The state transition itself is SQL (reap_stale_notification_leases, 006:108-116) and is
  // not re-implemented in TS, so the unit seam is reap()'s contract: it INVOKES that RPC and
  // surfaces the integer count of leases it returned to 'pending'. A crashed drain that
  // leaked a 'sending' lease is healed by exactly this call; the count is what drain()
  // reports as `reaped`. We script the RPC to report one reaped lease and assert reap()
  // returns it.
  test("reap() calls reap_stale_notification_leases and returns the reaped count", async () => {
    let calledWith: unknown[] | undefined
    sb.rpcScript.set("reap_stale_notification_leases", (call) => {
      calledWith = call.args
      return sb.ok(1) // one leaked 'sending' lease returned to 'pending'
    })

    const reaped = await reap()

    expect(reaped).toBe(1)
    // It is the reaper RPC (not a table mutation the unit re-implements).
    expect(calledWith).toBeDefined()
  })

  // drain() SELF-HEALS before claiming: it reaps first, so a just-reaped intent is eligible
  // for the very next claim this same tick (notification-delivery.ts:575-583). We script one
  // leaked lease reaped and the claim to then lease it; drain reports the reaped count AND
  // delivers the reclaimed intent — proving reap precedes claim, not after.
  test("drain reaps leaked leases before claiming, surfacing the count and reclaiming the work", async () => {
    vi.stubEnv("NOTIFY_REFERRAL_SEND", "true")
    installSlackOk()

    // The reaper returns 1 leaked lease to 'pending'; the claim then leases that now-pending
    // intent. (Both are scripted independently — ordering is asserted via the count + send.)
    scriptDrain([claimedRow()], /* reaped */ 1)

    const result = await drain(50)

    expect(result.reaped).toBe(1) // the leaked 'sending' lease was returned to pending
    expect(result.claimed).toBe(1) // and reclaimed by this tick's claim
    expect(result.sent).toBe(1) // and delivered

    // The reaper RPC was actually invoked this tick.
    // (rpcScript holds both; assert the wrapper surfaced the reaped count above.)
    expect(result.reaped).toBeGreaterThan(0)
  })

  // A no-leak tick reaps nothing: reap_stale_notification_leases reports 0 and drain carries
  // 0 through. Guards against a phantom non-zero reaped count when no lease has leaked.
  test("a tick with no leaked leases reports reaped = 0", async () => {
    scriptDrain([], /* reaped */ 0)
    sb.rpcScript.set("claim_notification_outbox", () => sb.ok([]))

    const result = await drain(50)
    expect(result.reaped).toBe(0)
    expect(result.claimed).toBe(0)
  })
})

// ===========================================================================
// (a) Q1 escalation: an app already enqueued at sla_alerted escalates to breach.
// A DISTINCT breach intent IS enqueued — it would FAIL a channel:app pre-filter
// (the app is "already present") but PASSES the full-dedupe_key one, because the
// breach key differs from the sla_alerted key.
// ===========================================================================

describe("enqueuePending — tier escalation enqueues a distinct intent per tier (Q1)", () => {
  test("an app already enqueued at sla_alerted escalates to breach: a new breach intent is upserted", async () => {
    // Outbox already holds referral:5001 at the LOWER tier. A channel:app pre-filter
    // would treat 5001 as "done" and drop it — the bug. The full-key filter must NOT.
    sb.selectScript.set("notification_outbox", () =>
      sb.ok([{ application_id: 5001, channel: "referral", reason: "sla_alerted" }])
    )
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([
        {
          application_id: 5001,
          sweep_type: "referral",
          greenhouse_stage_at_alert: "Application Review",
          first_alerted_at: "2026-05-27T00:00:00Z",
          last_alerted_at: "2026-05-28T12:00:00Z",
          resolved_at: null,
        },
      ])
    )
    // The LIVE tier has worsened to 'breach' => reason 'breach' => key referral:5001:breach,
    // which is NOT in the outbox. This is the escalation the channel:app key would eat.
    sb.selectScript.set("sweep_items", () =>
      sb.ok([
        {
          application_id: 5001,
          candidate_id: 9001,
          job_id: 7001,
          candidate_name: "Jane Candidate",
          job_title: "Staff Engineer",
          source_name: "Referral",
          current_stage: "Application Review",
          urgency_tier: "breach",
          hours_in_current_stage: 60,
          last_activity_at: "2026-05-26T00:00:00Z",
          application_created_at: "2026-05-25T00:00:00Z",
          referrer_name: "Pat Referrer",
          recruiter_name: "Riley Recruiter",
          ownership_resolution_status: "resolved",
          conflict_detail: null,
          created_at: "2026-05-28T12:00:00Z",
        },
      ])
    )
    sb.upsertScript.set("notification_outbox", () =>
      sb.ok([{ id: "outbox-breach", channel: "referral" }])
    )

    const result = await enqueuePending()

    // The breach intent survived the pre-filter (the sla_alerted key did not match).
    expect(result.candidates).toBe(1)
    expect(result.inserted).toBe(1)

    const upsert = sb.calls.find(
      (c) => c.table === "notification_outbox" && c.op === "upsert"
    )
    expect(upsert, "the escalated breach intent must be upserted").toBeDefined()
    const rows = upsert!.payload as Array<{ dedupe_key: string; reason: string }>
    expect(rows).toHaveLength(1)
    // The DISTINCT key — proof it is a per-tier intent, not the original collapsed.
    expect(rows[0].dedupe_key).toBe("referral:5001:breach")
    expect(rows[0].reason).toBe("breach")
  })
})

// ===========================================================================
// (b) Q2 backfill: a pre-deploy ledger row enqueues already-suppressed
// (backfill_predates_log), born terminal so the first live drain never sends it.
// ===========================================================================

describe("enqueuePending — pre-cutover rows enqueue suppressed (Q2 backfill)", () => {
  test("a ledger row predating NOTIFY_DELIVERY_CUTOVER_AT is upserted suppressed/backfill_predates_log", async () => {
    // The cutover is the deploy boundary. This alert first fired BEFORE it.
    vi.stubEnv("NOTIFY_DELIVERY_CUTOVER_AT", "2026-05-27T00:00:00Z")

    sb.selectScript.set("notification_outbox", () => sb.ok([]))
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([
        {
          application_id: 5001,
          sweep_type: "referral",
          greenhouse_stage_at_alert: "Application Review",
          first_alerted_at: "2026-05-20T00:00:00Z", // a week before cutover
          last_alerted_at: "2026-05-20T12:00:00Z",
          resolved_at: null,
        },
      ])
    )
    sb.selectScript.set("sweep_items", () =>
      sb.ok([
        {
          application_id: 5001,
          candidate_id: 9001,
          job_id: 7001,
          candidate_name: "Jane Candidate",
          job_title: "Staff Engineer",
          source_name: "Referral",
          current_stage: "Application Review",
          urgency_tier: "breach",
          hours_in_current_stage: 200,
          last_activity_at: "2026-05-19T00:00:00Z",
          application_created_at: "2026-05-18T00:00:00Z",
          referrer_name: "Pat Referrer",
          recruiter_name: "Riley Recruiter",
          ownership_resolution_status: "resolved",
          conflict_detail: null,
          created_at: "2026-05-20T12:00:00Z",
        },
      ])
    )
    sb.upsertScript.set("notification_outbox", () =>
      sb.ok([{ id: "outbox-backfill", channel: "referral" }])
    )

    await enqueuePending()

    const upsert = sb.calls.find(
      (c) => c.table === "notification_outbox" && c.op === "upsert"
    )
    expect(upsert, "the backfill row must still be enqueued (as a suppressed audit row)").toBeDefined()
    const rows = upsert!.payload as Array<{
      status: string
      suppression_reason: string | null
    }>
    expect(rows).toHaveLength(1)
    // Born terminal: status 'suppressed', reason 'backfill_predates_log'. It can never
    // be claimed by claim_notification_outbox (which only leases 'pending').
    expect(rows[0].status).toBe("suppressed")
    expect(rows[0].suppression_reason).toBe("backfill_predates_log")
  })

  test("with no cutover configured the same row enqueues 'pending' (no retroactive suppression)", async () => {
    // No NOTIFY_DELIVERY_CUTOVER_AT => no boundary => the channel send-gate is the safety
    // net, not a backfill suppression. The row enqueues pending.
    sb.selectScript.set("notification_outbox", () => sb.ok([]))
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([
        {
          application_id: 5001,
          sweep_type: "referral",
          greenhouse_stage_at_alert: "Application Review",
          first_alerted_at: "2026-05-20T00:00:00Z",
          last_alerted_at: "2026-05-20T12:00:00Z",
          resolved_at: null,
        },
      ])
    )
    sb.selectScript.set("sweep_items", () =>
      sb.ok([
        {
          application_id: 5001,
          candidate_id: 9001,
          job_id: 7001,
          candidate_name: "Jane Candidate",
          job_title: "Staff Engineer",
          source_name: "Referral",
          current_stage: "Application Review",
          urgency_tier: "alerted",
          hours_in_current_stage: 26,
          last_activity_at: "2026-05-19T00:00:00Z",
          application_created_at: "2026-05-18T00:00:00Z",
          referrer_name: "Pat Referrer",
          recruiter_name: "Riley Recruiter",
          ownership_resolution_status: "resolved",
          conflict_detail: null,
          created_at: "2026-05-20T12:00:00Z",
        },
      ])
    )
    sb.upsertScript.set("notification_outbox", () =>
      sb.ok([{ id: "outbox-pending", channel: "referral" }])
    )

    await enqueuePending()

    const upsert = sb.calls.find(
      (c) => c.table === "notification_outbox" && c.op === "upsert"
    )
    const rows = upsert!.payload as Array<{
      status: string
      suppression_reason: string | null
    }>
    expect(rows[0].status).toBe("pending")
    expect(rows[0].suppression_reason).toBeNull()
  })
})

// ===========================================================================
// (c) Q3 resolve-time suppression: a pending intent whose alert_ledger row is now
// resolved is suppressed (resolved_before_send) and NEVER sent — even gate-ON.
// ===========================================================================

describe("drain — a resolved alert suppresses the pending intent (Q3)", () => {
  test("a claimed intent whose alert_ledger row is resolved is suppressed resolved_before_send, no send", async () => {
    vi.stubEnv("NOTIFY_REFERRAL_SEND", "true") // gate ON: proves it's the resolve check, not the gate
    const fetchSpy = installSlackOk()

    scriptDrain([claimedRow()]) // referral:5001, fully resolved recipient

    // The alert_ledger row for this app is now RESOLVED (resolved_at set). loadResolvedLedgerKeys
    // reads it; drainOne suppresses before any Slack call.
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([
        {
          application_id: 5001,
          sweep_type: "referral",
          resolved_at: "2026-05-28T09:00:00Z",
        },
      ])
    )

    const result = await drain(50)

    expect(result.claimed).toBe(1)
    expect(result.suppressed).toBe(1)
    expect(result.sent).toBe(0)
    expect(result.failed).toBe(0)

    // Stale alert => no Slack contact at all.
    expect(fetchSpy).not.toHaveBeenCalled()

    const attempt = attemptInsert()
    expect(attempt).toBeDefined()
    expect(attempt!.status).toBe("suppressed")
    expect(attempt!.suppression_reason).toBe("resolved_before_send")
    expect(attempt!.provider_message_id).toBeNull()

    const stamp = outboxStamps().at(-1)!
    expect(stamp.status).toBe("suppressed")
    expect(stamp.suppression_reason).toBe("resolved_before_send")
    expect(stamp.sent_at).toBeUndefined()
  })

  test("an UNresolved alert (resolved_at null) still sends when the gate is ON", async () => {
    // Guard the complement: the resolve check must not suppress a live alert.
    vi.stubEnv("NOTIFY_REFERRAL_SEND", "true")
    const fetchSpy = installSlackOk()

    scriptDrain([claimedRow()])
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([
        { application_id: 5001, sweep_type: "referral", resolved_at: null },
      ])
    )

    const result = await drain(50)

    expect(result.sent).toBe(1)
    expect(result.suppressed).toBe(0)
    expect(fetchSpy).toHaveBeenCalled()
  })
})

// ===========================================================================
// (d) Q4 dual_agency shape: a conflict_detail carrying prior_submissions (the
// local-state shape) — and NOT prior_applications — still renders Agency 1 / Agency 2.
// ===========================================================================

describe("enqueuePending — dual_agency maps prior_submissions to the render shape (Q4)", () => {
  test("prior_submissions are mapped so the rendered text shows both Agency 1 and Agency 2", async () => {
    sb.selectScript.set("notification_outbox", () => sb.ok([]))
    sb.selectScript.set("alert_ledger", () =>
      sb.ok([
        {
          application_id: 6002,
          sweep_type: "agency",
          greenhouse_stage_at_alert: "Application Review",
          first_alerted_at: "2026-05-28T00:00:00Z",
          last_alerted_at: "2026-05-28T00:00:00Z",
          resolved_at: null,
        },
      ])
    )
    // sweep_items carries the dual_agency conflict_detail in the LOCAL-state shape:
    // prior_submissions (NO prior_applications). This is what sweep-agency.ts writes
    // for a cross-agency conflict found from agency_submissions.
    sb.selectScript.set("sweep_items", () =>
      sb.ok([
        {
          application_id: 6002,
          candidate_id: 9002,
          job_id: 7002,
          candidate_name: "Dana Dual",
          job_title: "Senior Designer",
          source_name: null,
          current_stage: "Application Review",
          urgency_tier: null,
          hours_in_current_stage: null,
          last_activity_at: null,
          application_created_at: null,
          referrer_name: null,
          recruiter_name: "Riley Recruiter",
          ownership_resolution_status: "resolved",
          conflict_detail: {
            conflict_type: "dual_agency",
            prior_submissions: [
              {
                application_id: 6002,
                agency: "Acme Staffing",
                job_title: "Senior Designer",
                submitted_at: "2026-05-20",
              },
              {
                application_id: 5500,
                agency: "Globex Talent",
                job_title: "Senior Designer",
                submitted_at: "2026-05-22",
              },
            ],
          },
          created_at: "2026-05-28T00:00:00Z",
        },
      ])
    )
    // agency_submissions has the conflict_type but no usable detail of its own here.
    sb.selectScript.set("agency_submissions", () =>
      sb.ok([
        {
          application_id: 6002,
          agency_source_name: null,
          job_title: "Senior Designer",
          recruiter_name: "Riley Recruiter",
          conflict_type: "dual_agency",
          conflict_detail: null,
          source_resolution_status: "unresolved",
        },
      ])
    )

    let captured: Array<{ payload: OutboxPayload; reason: string }> = []
    sb.upsertScript.set("notification_outbox", (call) => {
      captured = (call.args[0] as Array<{ payload: OutboxPayload; reason: string }>) ?? []
      return sb.ok([{ id: "outbox-dual", channel: "agency" }])
    })

    await enqueuePending()

    expect(captured).toHaveLength(1)
    const row = captured[0]
    expect(row.reason).toBe("dual_agency")
    // The mapped prior_applications: agency -> source_name, submitted_at -> applied_at.
    const priors = (row.payload as { prior_applications?: unknown[] }).prior_applications
    expect(priors).toHaveLength(2)

    // Render the frozen intent the drain would: the dual_agency body must carry both
    // agencies on the Agency 1 / Agency 2 lines (notification-render.ts:257-265).
    const built = buildNotification({
      channel: "agency",
      notification_type: "agency_dual_agency",
      reason: "dual_agency",
      application_id: 6002,
      ...(row.payload as object),
    } as Parameters<typeof buildNotification>[0])

    expect(built.text).toContain("Dual Agency Submission Detected")
    expect(built.text).toContain("*Agency 1:* Acme Staffing")
    expect(built.text).toContain("*Agency 2:* Globex Talent")
  })
})
