import { describe, expect, test } from "vitest"

import { deriveWeeklyLeadershipRows } from "../lib/recruiting-ops/modules/t01-weekly-leadership"
import type { FinalOfferRow } from "../lib/recruiting-ops/modules/t07-final-offer"

// REGRESSION LOCK (was RED SPEC) — T01-weekly-offer (SHADOW-MODULES-1).
// (the internal control-plane excavation audit (2026-06-26).)
//
// deriveWeeklyLeadershipRows counts offers per WEEK bucket, but the offer filter at
// t01-weekly-leadership.ts:99 matches on `row.month_bucket === input.weekBucket.slice(0,7)`.
// slice(0,7) collapses any week of a month down to that month, so a single monthly offer
// is counted into EVERY week bucket that falls in that month. A weekly leadership rollup
// that double-, triple-, quadruple-counts the same offer is a real reporting defect:
// summed across the weeks of June, one offer reports as four offers.
//
// FIX: a monthly fact cannot be summed across weekly buckets — either attribute the offer
// to a single week (e.g. by an offer date), or surface offers at the month grain instead
// of replicating the monthly count into each week.
//
// CORRECT expectation (NOT the existing green test, which asserts offer_count: 1 for a
// single week and never sums across weeks): one offer, counted exactly once total.

const offer: FinalOfferRow = {
  application_id: "app_offer",
  job_id: "job_1",
  offer_id: "offer_1",
  offer_status: "accepted",
  month_bucket: "2026-06",
  recruiter_name: "Recruiter One",
  sourcer_name: "Sourcer One",
  team_name: "Engineering",
  hod_name: "HOD One",
}

function offerCountForWeek(weekBucket: string): number {
  const rows = deriveWeeklyLeadershipRows({
    weekBucket,
    finalOfferRows: [offer],
    rpsRows: [],
    pipelineRows: [],
    ownershipRows: [],
  })
  const row = rows.find((candidate) => candidate.job_id === "job_1")
  return row?.offer_count ?? 0
}

describe("T01: a monthly offer is counted once across the weeks of its month, not in every week", () => {
  test("one June offer sums to exactly 1 across two June week buckets", () => {
    const week1 = offerCountForWeek("2026-06-15")
    const week2 = offerCountForWeek("2026-06-22")

    // Pre-fix: slice(0,7) of each week === '2026-06' matched the lone offer, so each week
    // reported offer_count 1 and the sum was 2 (the same offer counted twice).
    expect(week1 + week2).toBe(1)
  })

  test("a blank offer_created_at falls back to the mid-month anchor, never to zero weeks", () => {
    const rows = deriveWeeklyLeadershipRows({
      weekBucket: "2026-06-15",
      finalOfferRows: [{ ...offer, offer_created_at: "" }],
      rpsRows: [],
      pipelineRows: [],
      ownershipRows: [],
    })
    expect(rows.find((candidate) => candidate.job_id === "job_1")?.offer_count).toBe(1)
  })
})
