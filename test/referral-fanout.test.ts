import { describe, expect, test, vi, afterEach } from "vitest"

import { dedupeKey } from "../lib/notification-render"
import { resolveRecipient, recruiterRoutingFromMs } from "../lib/notification-delivery"

// Fan-out regression locks (operator decision 2026-08-06).
//
// A referral landing on a requisition is news for EVERY recruiter on that req's hiring team, so
// recruiter mode emits one DM per recruiter. Live shape from req 1206 (AI Engineering Lead, NY):
// Greenhouse lists Ravi Pillai, Victor Reyes and Margot Ellis all as Recruiters. The
// "(Recruiting tasks)" marker on Ravi is a default task-assignment flag, not a claim that the
// other two are uninvolved — an earlier version of this system read it that way and routed
// everything to one person.
//
// The property these tests exist to protect is INDEPENDENT PER-RECIPIENT IDEMPOTENCY. The whole
// outbox is built on "never send the same thing twice"; fan-out is the first feature that could
// break it, because three recipients behind one row means a single failure retries all three.

const RAVI = 4000000104
const VICTOR = 5101879004
const MARGOT = 5103434004

const base = { channel: "referral" as const, application_id: 170617746, reason: "sla_alerted" as const }

describe("fan-out dedupe keys", () => {
  test("each recruiter on the req gets a distinct key, so each send is retried independently", () => {
    const keys = [RAVI, VICTOR, MARGOT].map((id) =>
      dedupeKey({ ...base, recipient_recruiter_id: id })
    )
    expect(new Set(keys).size).toBe(3)
    expect(keys).toEqual([
      "referral:170617746:sla_alerted:4000000104",
      "referral:170617746:sla_alerted:5101879004",
      "referral:170617746:sla_alerted:5103434004",
    ])
  })

  test("a redelivery for ONE recruiter cannot collide with another's", () => {
    // The failure this prevents: Ravi and Victor's DMs succeed, Margot's fails, the drain retries.
    // With a shared key the retry re-sends to all three. With per-recruiter keys only Margot's row
    // is still pending, so only Margot is retried.
    const margotFirst = dedupeKey({ ...base, recipient_recruiter_id: MARGOT })
    const margotRetry = dedupeKey({ ...base, recipient_recruiter_id: MARGOT })
    expect(margotRetry).toBe(margotFirst)
    expect(margotRetry).not.toBe(dedupeKey({ ...base, recipient_recruiter_id: RAVI }))
  })

  test("head_of_ta mode keeps the original 3-part key byte-for-byte", () => {
    // Pre-fan-out rows must not churn. Anything else re-enqueues the entire live backlog.
    expect(dedupeKey(base)).toBe("referral:170617746:sla_alerted")
    expect(dedupeKey({ ...base, recipient_recruiter_id: null })).toBe(
      "referral:170617746:sla_alerted"
    )
    expect(dedupeKey({ ...base, recipient_recruiter_id: undefined })).toBe(
      "referral:170617746:sla_alerted"
    )
  })

  test("the tier still segments the key, so a 36h reminder is a separate send", () => {
    expect(dedupeKey({ ...base, reason: "sla_risk", recipient_recruiter_id: RAVI })).not.toBe(
      dedupeKey({ ...base, recipient_recruiter_id: RAVI })
    )
  })
})

describe("resolveRecipient under fan-out", () => {
  afterEach(() => vi.unstubAllEnvs())

  test("a shared req no longer diverts to head-of-TA — each row routes to its own recruiter", () => {
    // THE REGRESSION THIS LOCKS: the old rule returned 'ambiguous' -> head-of-TA whenever
    // recruiterCount > 1, which sent 103 of 202 live alerts back to the operator. recruiterCount is
    // deliberately 3 here (the true owner count still rides the payload for the audit) while the
    // row targets one recruiter.
    vi.stubEnv("NOTIFY_RECIPIENT_MODE", "recruiter")
    vi.stubEnv("NOTIFY_RECRUITER_ROUTING_FROM", "2020-01-01T00:00:00Z")
    const r = resolveRecipient({
      recruiterId: VICTOR,
      recruiterSlackId: "U085FQSKT0D",
      recruiterCount: 3,
    })
    expect(r.recipient_user_id).toBe("U085FQSKT0D")
    expect(r.recipient_resolution_status).toBe("resolved")
  })

  test("a departed recruiter falls back to head-of-TA and still SENDS", () => {
    // The seven confirmed-departed recruiters carry 'deactivated' in the directory, so their
    // slack id is null. The alert must still reach someone, flagged as unresolved.
    vi.stubEnv("NOTIFY_RECIPIENT_MODE", "recruiter")
    vi.stubEnv("NOTIFY_RECRUITER_ROUTING_FROM", "2020-01-01T00:00:00Z")
    const r = resolveRecipient({ recruiterId: 999, recruiterSlackId: null, recruiterCount: 1 })
    expect(r.recipient_user_id).toBe("U00000000001")
    expect(r.recipient_resolution_status).toBe("unresolved")
  })

  test("head_of_ta mode ignores the recruiter entirely", () => {
    vi.stubEnv("NOTIFY_RECIPIENT_MODE", "head_of_ta")
    const r = resolveRecipient({ recruiterId: RAVI, recruiterSlackId: "U00000000002", recruiterCount: 3 })
    expect(r.recipient_user_id).toBe("U00000000001")
  })
})

describe("no recruiter may receive a pre-switch-on alert (the operator, binding)", () => {
  afterEach(() => vi.unstubAllEnvs())

  // operator decision 2026-08-06: "I do NOT want people to get this huge backlog of messages. They should ONLY
  // receive messages that send at some point after the capability is switched on."
  //
  // Turning on fan-out re-keys every referral, so all 202 already-open alerts would re-enqueue and
  // fire at once — 68 of them at one recruiter. The guarantee must not rest on an operator setting
  // a second variable in the right order, so recruiter mode is welded to a declared start line.

  test("recruiter mode WITHOUT a start line falls back to head-of-TA — the unsafe state cannot exist", () => {
    vi.stubEnv("NOTIFY_RECIPIENT_MODE", "recruiter")
    // NOTIFY_RECRUITER_ROUTING_FROM deliberately unset.
    const r = resolveRecipient({ recruiterId: RAVI, recruiterSlackId: "U00000000002", recruiterCount: 3 })
    expect(
      r.recipient_user_id,
      "flipping the mode alone must NOT start DMing recruiters"
    ).toBe("U00000000001")
  })

  test("an unparseable start line is treated as absent, not as the epoch", () => {
    // A typo'd timestamp parsing to NaN must fail closed. Reading it as 0 would place every alert
    // ever raised AFTER the start line and release the whole backlog.
    vi.stubEnv("NOTIFY_RECIPIENT_MODE", "recruiter")
    vi.stubEnv("NOTIFY_RECRUITER_ROUTING_FROM", "not-a-timestamp")
    const r = resolveRecipient({ recruiterId: RAVI, recruiterSlackId: "U00000000002", recruiterCount: 3 })
    expect(r.recipient_user_id).toBe("U00000000001")
  })

  test("a start line in the future keeps everything on the head-of-TA", () => {
    vi.stubEnv("NOTIFY_RECIPIENT_MODE", "recruiter")
    vi.stubEnv("NOTIFY_RECRUITER_ROUTING_FROM", "2999-01-01T00:00:00Z")
    // The mode IS active (the instant parses), so routing itself works...
    const r = resolveRecipient({ recruiterId: RAVI, recruiterSlackId: "U00000000002", recruiterCount: 3 })
    expect(r.recipient_user_id).toBe("U00000000002")
    // ...but predatesRecruiterRouting suppresses every alert at enqueue, which is the enqueue-side
    // half of the guarantee and is exercised through enqueuePending in notification-delivery.test.
    expect(recruiterRoutingFromMs()).toBeGreaterThan(Date.now())
  })
})
