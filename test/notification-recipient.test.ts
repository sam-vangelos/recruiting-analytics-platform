// P4 — resolveRecipient routing. The six mode×ctx cases + the load-bearing invariant that EVERY
// recruiter-mode fallback carries a non-null id (so the relaxed drain gate still SENDS them).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { resolveRecipient } from "../lib/notification-delivery"

const HEAD = "U00000000001" // SWEEP_CONFIG.slack.headOfTaUserId

describe("resolveRecipient (P4)", () => {
  afterEach(() => vi.unstubAllEnvs())

  test("head_of_ta mode (default) always routes to head-of-TA, even with a recruiter ctx", () => {
    vi.stubEnv("NOTIFY_RECIPIENT_MODE", "")
    expect(resolveRecipient()).toEqual({
      recipient_user_id: HEAD,
      recipient_resolution_status: "resolved",
    })
    expect(
      resolveRecipient({ recruiterId: 1, recruiterSlackId: "U999", recruiterCount: 1 })
    ).toEqual({ recipient_user_id: HEAD, recipient_resolution_status: "resolved" })
  })

  describe("recruiter mode", () => {
    // Recruiter mode FAILS CLOSED without a switch-on instant (recipientMode), so every
    // recruiter-mode case must declare one. Dated far in the past so the fixtures' alerts all
    // count as raised after routing went live; the guard itself is locked separately below.
    beforeEach(() => {
      vi.stubEnv("NOTIFY_RECIPIENT_MODE", "recruiter")
      vi.stubEnv("NOTIFY_RECRUITER_ROUTING_FROM", "2020-01-01T00:00:00Z")
    })

    test("resolved recruiter slack id -> DM the recruiter", () => {
      expect(
        resolveRecipient({ recruiterId: 1, recruiterSlackId: "U999", recruiterCount: 1 })
      ).toEqual({ recipient_user_id: "U999", recipient_resolution_status: "resolved" })
    })

    // REPLACES "shared job (count > 1) -> head-of-TA, ambiguous". That rule existed to avoid
    // DMing an arbitrary owner, but it diverted 103 of 202 live alerts back to the head-of-TA.
    // Fan-out removes the arbitrary choice instead of routing around it: recruiter mode emits one
    // outbox row per recruiter on the req, each carrying its own recruiter_id, so a row with
    // recruiterCount > 1 is now a fan-out row that must route to ITS recruiter. The true owner
    // count still rides the payload for the audit, which is why it is 2 here and must be ignored.
    test("shared job (count > 1) -> DM this row's recruiter; 'ambiguous' no longer exists", () => {
      expect(
        resolveRecipient({ recruiterId: 1, recruiterSlackId: "U999", recruiterCount: 2 })
      ).toEqual({ recipient_user_id: "U999", recipient_resolution_status: "resolved" })
    })

    test("recruiter known but no slack id -> head-of-TA, unresolved", () => {
      expect(
        resolveRecipient({ recruiterId: 1, recruiterSlackId: null, recruiterCount: 1 })
      ).toEqual({ recipient_user_id: HEAD, recipient_resolution_status: "unresolved" })
    })

    test("no recruiter -> head-of-TA, unresolved", () => {
      expect(
        resolveRecipient({ recruiterId: null, recruiterSlackId: null, recruiterCount: null })
      ).toEqual({ recipient_user_id: HEAD, recipient_resolution_status: "unresolved" })
    })

    test("INVARIANT: every fallback carries a non-null id, so the relaxed gate still sends", () => {
      // The count > 1 case is no longer a fallback — fan-out routes it to its own recruiter — so
      // only the two genuine fallbacks remain. Both still carry a non-null id: an alert nobody
      // can be routed to must reach the head-of-TA, never vanish.
      const fallbacks = [
        { recruiterId: 1, recruiterSlackId: null, recruiterCount: 1 }, // departed / no slack account
        { recruiterId: null, recruiterSlackId: null, recruiterCount: null }, // no owner at all
      ]
      for (const ctx of fallbacks) {
        expect(resolveRecipient(ctx).recipient_user_id).toBe(HEAD)
      }
    })
  })
})
