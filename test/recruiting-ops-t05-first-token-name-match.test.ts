import { describe, expect, test } from "vitest"

import { computeMatchMismatch, normalizeRpsRows, type GreenhouseRpsFact } from "../lib/recruiting-ops/modules/t05-rps"

// REGRESSION LOCK (was RED SPEC) — T05 SHADOW-MODULES-7: first-token substring match returns a false "match"
// for two DIFFERENT people who happen to share a first name.
// (the internal control-plane excavation audit (2026-06-26), T05 RPS scorecard accountability.)
//
// computeMatchMismatch (lib/recruiting-ops/modules/t05-rps.ts:97-107) decides whether the
// scorecard submitter also conducted the interview. Its rule is:
//   s === i || s.includes(firstToken(i)) || i.includes(firstToken(s))  -> "match"
// The two .includes() branches make the comparison a first-name substring test: any two
// people sharing a first name collapse to "match", certifying interviewer == submitter when
// they are demonstrably different humans. That is a false accountability signal — the whole
// point of match_mismatch is to catch a submitter rubber-stamping someone else's interview.
//
// FIX: require a real same-person comparison (full normalized name equality, or a
// last-name-aware match), NOT a shared first token. When fixed, distinct people who only
// share a first name resolve to "mismatch" and this file goes green / moves to test/.
//
// computeMatchMismatch takes (string | undefined, string | undefined); these calls are
// type-valid and FAIL on HEAD by assertion (HEAD returns "match").

describe("T05: shared first name is NOT the same person — must be a mismatch", () => {
  const sharedFirstNamePairs: Array<{ submitter: string; interviewer: string }> = [
    { submitter: "Priya Sharma", interviewer: "Priya Venkatesan" },
    { submitter: "Marcus Webb", interviewer: "Marcus Trent" },
    { submitter: "Avery Park", interviewer: "Avery Okafor" },
  ]

  for (const { submitter, interviewer } of sharedFirstNamePairs) {
    test(`computeMatchMismatch("${submitter}", "${interviewer}") is a mismatch, not a match`, () => {
      // HEAD: returns "match" (firstToken substring collision). Desired: "mismatch".
      expect(computeMatchMismatch(submitter, interviewer)).toBe("mismatch")
    })
  }

  test("a genuine same-person match still resolves to match (guards against over-correcting)", () => {
    expect(computeMatchMismatch("Priya Sharma", "Priya Sharma")).toBe("match")
  })

  test("the false match flows through normalizeRpsRows into the row's match_mismatch", () => {
    const fact: GreenhouseRpsFact = {
      applicationId: "app-1",
      jobId: "job-1",
      interviewId: "int-1",
      stageName: "RPS Phone Screen",
      scheduledAt: "2026-06-01T15:00:00.000Z",
      scorecardStatus: "submitted",
      submitterName: "Priya Sharma",
      interviewerName: "Priya Venkatesan",
    }
    const [row] = normalizeRpsRows([fact])
    // HEAD: row.match_mismatch === "match". Desired: "mismatch" — two different people.
    expect(row.match_mismatch).toBe("mismatch")
  })
})
