import { describe, expect, test, vi } from "vitest"

import type { RecruiterTeamHodEntry } from "../lib/recruiting-ops/dimensions/config/recruiter-team-hod.v1"
import {
  legacyBicCompatibleReportingTimestamp,
  type ScorecardSubmissionRow,
} from "../lib/recruiting-ops/delivery-source/scorecard-submission"
import {
  projectDeliveryRoleRps,
  projectRpsTrackingSheet,
} from "../lib/recruiting-ops/delivery/rps-sheet-projections"
import {
  DELIVERY_RPS_DATED_HEADERS,
  DELIVERY_RPS_HEADERS,
  RPS_HEADERS,
} from "../lib/recruiting-ops/delivery/staging-sheet-contracts"

const roster: readonly RecruiterTeamHodEntry[] = [
  {
    recruiterName: "Scorecard Submitter",
    teamId: "team_platform",
    teamName: "Team Platform",
    hodName: "Platform HOD",
  },
]

const DAY_MS = 86_400_000
const GOOGLE_SHEETS_UNIX_EPOCH_DAYS = 25_569

function indiaWallClockSerial(timestamp: string): number {
  return (Date.parse(timestamp) + 330 * 60_000) / DAY_MS + GOOGLE_SHEETS_UNIX_EPOCH_DAYS
}

function row(overrides: Partial<ScorecardSubmissionRow> = {}): ScorecardSubmissionRow {
  const result: ScorecardSubmissionRow = {
    scorecard_id: "9001",
    application_id: "100",
    candidate_id: "200",
    candidate_name: "Casey Candidate",
    application_status: "rejected",
    job_id: "300",
    requisition_id: "890",
    job_name: "Principal Engineer",
    job_status: "open",
    recruiter_names: ["Primary Recruiter", "Backup Recruiter"],
    sourcer_names: ["Primary Sourcer"],
    interview_kit_id: "600",
    job_interview_id: "400",
    interview_name: "Recruiter Phone Screen",
    interviewer_id: "700",
    interviewer_name: "Interview Owner",
    scheduled_interview_ended_at: "2026-07-08T18:00:00.000Z",
    interviewed_at: "2026-07-08T17:00:00.000Z",
    created_at: null,
    updated_at: null,
    submitted_at: "2026-07-08T19:00:00.000Z",
    legacy_bic_reporting_at: "2026-07-08T19:00:00.000Z",
    submitter_id: "701",
    submitter_name: "Scorecard Submitter",
    scorecard_status: "complete",
    candidate_rating: "strong_yes",
    overall_recommendation: "strong_yes",
    match_mismatch: "mismatch",
    month_bucket: "2026-07",
    month_ordinal: 24318,
    week_bucket: "2026-07-06",
    week_ordinal: 2948,
    qa_summary: "Complete and internally consistent.",
    key_takeaways: "Clear systems reasoning.",
    ...overrides,
  }
  if (!("legacy_bic_reporting_at" in overrides)) {
    result.legacy_bic_reporting_at = legacyBicCompatibleReportingTimestamp(result)
  }
  return result
}

describe("RPS staging sheet projections", () => {
  test("renders exact RPS Tracking A:R values and governed team/HOD metadata", () => {
    const projection = projectRpsTrackingSheet({
      rows: [row()],
      roster,
      periodStartMonday: "2026-03-02",
      submittedAtStart: "2026-03-02",
      submittedAtEndExclusive: "2026-07-10",
    })

    expect(projection.headers).toEqual(RPS_HEADERS)
    expect(projection.rows[0]).toEqual({
      scorecardId: "9001",
      upsertKey: "890\u00002026-07-08T19:00:00.000Z\u0000Scorecard Submitter\u0000Recruiter Phone Screen",
      values: [
        "Casey Candidate",
        "Principal Engineer",
        "890",
        "rejected",
        "Primary Recruiter, Backup Recruiter",
        "Primary Sourcer",
        "Recruiter Phone Screen",
        "Interview Owner",
        "2026-07-08 18:00:00.000",
        "2026-07-08 19:00:00.000",
        "Scorecard Submitter",
        "Mismatch",
        "July",
        "Team Platform",
        "Jul 06 – Jul 12",
        19,
        "Complete and internally consistent.",
        "Clear systems reasoning.",
      ],
      submitterTeamId: "team_platform",
      submitterTeamName: "Team Platform",
      submitterHodName: "Platform HOD",
      submitterTeamResolutionStatus: "resolved",
    })
    expect(projection.rows[0].values).toHaveLength(18)
    expect(projection.scope).toEqual({
      periodStartMonday: "2026-03-02",
      submittedAtStart: "2026-03-02",
      submittedAtEndExclusive: "2026-07-10",
      sourceRowCount: 1,
      includedRowCount: 1,
      excludedRowCount: 0,
      excludedReasonCounts: {
        missing_or_invalid_submitted_at: 0,
        submitted_before_period: 0,
        submitted_at_or_after_period_end: 0,
      },
    })
    expect(projection.excludedRows).toEqual([])
  })

  test("uses submitted_at for the continuous 02 Mar RPS ledger and accounts for every boundary exclusion", () => {
    const projection = projectRpsTrackingSheet({
      rows: [
        row({
          scorecard_id: "1",
          scheduled_interview_ended_at: "2026-03-03T18:00:00.000Z",
          submitted_at: "2026-03-01T23:59:59.999Z",
        }),
        row({
          scorecard_id: "2",
          scheduled_interview_ended_at: "2026-02-20T18:00:00.000Z",
          submitted_at: "2026-03-02T00:00:00.000Z",
        }),
        row({ scorecard_id: "3", submitted_at: "2026-07-05T23:59:59.999Z" }),
        row({ scorecard_id: "4", submitted_at: "2026-07-06T00:00:00.000Z" }),
        row({ scorecard_id: "5", submitted_at: "2026-07-09T23:59:59.999Z" }),
        row({ scorecard_id: "6", submitted_at: "2026-07-10T00:00:00.000Z" }),
        row({ scorecard_id: "7", submitted_at: null }),
      ],
      roster,
      periodStartMonday: "2026-03-02",
      submittedAtStart: "2026-03-02",
      submittedAtEndExclusive: "2026-07-10",
    })

    expect(projection.rows.map((rendered) => [
      rendered.scorecardId,
      rendered.values[12],
      rendered.values[14],
      rendered.values[15],
    ])).toEqual([
      ["2", "March", "Mar 02 – Mar 08", 1],
      ["3", "July", "Jun 29 – Jul 05", 18],
      ["4", "July", "Jul 06 – Jul 12", 19],
      ["5", "July", "Jul 06 – Jul 12", 19],
    ])
    expect(projection.scope).toEqual({
      periodStartMonday: "2026-03-02",
      submittedAtStart: "2026-03-02",
      submittedAtEndExclusive: "2026-07-10",
      sourceRowCount: 7,
      includedRowCount: 4,
      excludedRowCount: 3,
      excludedReasonCounts: {
        missing_or_invalid_submitted_at: 1,
        submitted_before_period: 1,
        submitted_at_or_after_period_end: 1,
      },
    })
    expect(projection.excludedRows).toEqual([
      { scorecardId: "1", reason: "submitted_before_period" },
      { scorecardId: "6", reason: "submitted_at_or_after_period_end" },
      { scorecardId: "7", reason: "missing_or_invalid_submitted_at" },
    ])
  })

  test("keeps RPS week ordinals continuous across Dec to Jan", () => {
    const projection = projectRpsTrackingSheet({
      rows: [
        row({ scorecard_id: "dec", submitted_at: "2026-12-27T12:00:00.000Z" }),
        row({ scorecard_id: "boundary", submitted_at: "2027-01-01T12:00:00.000Z" }),
        row({ scorecard_id: "jan", submitted_at: "2027-01-04T12:00:00.000Z" }),
      ],
      roster,
      periodStartMonday: "2026-12-21",
      submittedAtStart: "2026-12-21",
      submittedAtEndExclusive: "2027-01-11",
    })

    expect(projection.rows.map((rendered) => [
      rendered.scorecardId,
      rendered.values[12],
      rendered.values[14],
      rendered.values[15],
    ])).toEqual([
      ["dec", "December", "Dec 21 – Dec 27", 1],
      ["boundary", "January", "Dec 28 – Jan 03", 2],
      ["jan", "January", "Jan 04 – Jan 10", 3],
    ])
  })

  test("uses the explicit full-ledger legacy BIC clock without overwriting native submitted_at", () => {
    const laterLedger = row({
      scorecard_id: "later-ledger",
      created_at: "2026-07-08T16:00:00.000Z",
      submitted_at: "2026-07-09T19:00:00.000Z",
      legacy_bic_reporting_at: "2026-07-08T16:00:00.000Z",
    })
    const projection = projectRpsTrackingSheet({
      rows: [
        row({
          scorecard_id: "early-ledger",
          created_at: "2026-05-27T23:00:00.000Z",
          submitted_at: "2026-05-29T10:00:00.000Z",
          legacy_bic_reporting_at: "2026-05-27T23:00:00.000Z",
        }),
        laterLedger,
      ],
      roster,
      periodStartMonday: "2026-03-02",
      submittedAtStart: "2026-03-02",
      submittedAtEndExclusive: "2026-07-10",
    })

    expect(projection.rows.map((rendered) => [rendered.scorecardId, rendered.values[9]])).toEqual([
      ["early-ledger", "2026-05-27 23:00:00.000"],
      ["later-ledger", "2026-07-08 16:00:00.000"],
    ])
    expect(projection.rows.find((rendered) => rendered.scorecardId === "later-ledger")?.upsertKey).toContain(
      "2026-07-08T16:00:00.000Z"
    )

    const delivery = projectDeliveryRoleRps({
      rows: [laterLedger],
      roster,
      isDeliveryRole: () => true,
      dateOrderStart: "2026-03-13",
      submittedAtStart: "2026-07-03",
      submittedAtEndExclusive: "2026-07-10",
      reportDate: "2026-07-08",
    })
    expect(delivery.raw.rows[0].upsertKey).toBe(
      "890\u00002026-07-08T16:00:00.000Z\u0000Scorecard Submitter\u0000Recruiter Phone Screen"
    )
    expect(delivery.raw.rows[0].values[9]).toBe("2026-07-08T16:00:00.000+00:00")
    expect(delivery.raw.rows[0].values[10]).toBe(46_211)
    expect(delivery.scope.datedIncludedRowCount).toBe(1)
    expect(laterLedger.submitted_at).toBe("2026-07-09T19:00:00.000Z")
  })

  test("uses only the explicit platform job classifier for the Delivery subset", () => {
    const classifier = vi.fn(({ jobId }: { jobId: string | null }) => jobId === "new-delivery-job")
    const projection = projectDeliveryRoleRps({
      rows: [
        row({ scorecard_id: "1", job_id: "old-hardcoded-looking-job", requisition_id: "907" }),
        row({ scorecard_id: "2", job_id: "new-delivery-job", requisition_id: "9999" }),
      ],
      roster,
      isDeliveryRole: classifier,
      dateOrderStart: "2026-03-13",
      submittedAtStart: "2026-07-03",
      submittedAtEndExclusive: "2026-07-10",
      reportDate: "2026-07-09",
    })

    expect(classifier).toHaveBeenCalledTimes(2)
    expect(projection.raw.rows.map((rendered) => rendered.scorecardId)).toEqual(["2"])
    expect(projection.clean.rows.map((rendered) => rendered.scorecardId)).toEqual(["2"])
  })

  test("renders exact Delivery Raw/Clean A:T values and deterministic legacy date/week ordinals", () => {
    const projection = projectDeliveryRoleRps({
      rows: [row()],
      roster,
      isDeliveryRole: () => true,
      dateOrderStart: "2026-03-13",
      submittedAtStart: "2026-07-03",
      submittedAtEndExclusive: "2026-07-10",
      reportDate: "2026-07-09",
    })
    const expectedRaw = [
      "Casey Candidate",
      "Principal Engineer",
      "890",
      "rejected",
      "Primary Recruiter, Backup Recruiter",
      "Primary Sourcer",
      "Recruiter Phone Screen",
      "Interview Owner",
      "2026-07-08T18:00:00.000+00:00",
      "2026-07-08T19:00:00.000+00:00",
      46_211,
      118,
      "Scorecard Submitter",
      "Strong Yes",
      "Mismatch",
      "July",
      "Team Platform",
      "Jul 06 – Jul 12",
      28,
      "Clear systems reasoning.",
    ]
    const expectedClean = [
      ...expectedRaw.slice(0, 8),
      indiaWallClockSerial("2026-07-08T18:00:00.000Z"),
      indiaWallClockSerial("2026-07-08T19:00:00.000Z"),
      "Wed Jul 08 2026 00:00:00 GMT+0530 (India Standard Time)",
      ...expectedRaw.slice(11),
    ]

    expect(projection.raw.headers).toEqual(DELIVERY_RPS_HEADERS)
    expect(projection.clean.headers).toEqual(DELIVERY_RPS_HEADERS)
    expect(projection.raw.rows[0].values).toEqual(expectedRaw)
    expect(projection.clean.rows[0].values).toEqual(expectedClean)
    // The 19:00 UTC instant crosses midnight in India, while the legacy
    // submitted_date_formatted column intentionally retains the UTC date.
    expect(projection.clean.rows[0].values[9]).toBeGreaterThan(46_212)
    expect(projection.clean.rows[0].values[10]).toContain("Jul 08 2026")
    expect(projection.raw.rows[0].values).toHaveLength(20)
  })

  test("reproduces the observed millisecond India-wall-clock serial and preserves a missing interview sentinel", () => {
    const projection = projectDeliveryRoleRps({
      rows: [row({
        scheduled_interview_ended_at: null,
        submitted_at: "2026-07-08T21:18:27.343Z",
      })],
      roster,
      isDeliveryRole: () => true,
      dateOrderStart: "2026-03-13",
      submittedAtStart: "2026-07-03",
      submittedAtEndExclusive: "2026-07-10",
      reportDate: "2026-07-08",
    })

    expect(projection.raw.rows[0].values.slice(8, 11)).toEqual([
      "∅",
      "2026-07-08T21:18:27.343+00:00",
      46_211,
    ])
    expect(projection.clean.rows[0].values.slice(8, 11)).toEqual([
      "∅",
      46_212.11698313657,
      "Wed Jul 08 2026 00:00:00 GMT+0530 (India Standard Time)",
    ])
  })

  test("scopes Delivery to submitted Fri-Thu rows and keeps the governed March date-order anchor", () => {
    const projection = projectDeliveryRoleRps({
      rows: [
        row({ scorecard_id: "1", job_id: "non-delivery" }),
        row({ scorecard_id: "2", submitted_at: "2026-07-02T23:59:59.999Z" }),
        row({
          scorecard_id: "3",
          scheduled_interview_ended_at: "2026-06-20T18:00:00.000Z",
          submitted_at: "2026-07-03T00:00:00.000Z",
        }),
        row({ scorecard_id: "4", submitted_at: "2026-07-09T23:59:59.999Z" }),
        row({ scorecard_id: "5", submitted_at: "2026-07-10T00:00:00.000Z" }),
        row({ scorecard_id: "6", submitted_at: null }),
      ],
      roster,
      isDeliveryRole: ({ jobId }) => jobId !== "non-delivery",
      dateOrderStart: "2026-03-13",
      submittedAtStart: "2026-07-03",
      submittedAtEndExclusive: "2026-07-10",
      reportDate: "2026-07-09",
    })

    expect(projection.raw.rows.map((rendered) => [
      rendered.scorecardId,
      rendered.values[8],
      rendered.values[10],
      rendered.values[11],
      rendered.values[15],
      rendered.values[17],
      rendered.values[18],
    ])).toEqual([
      ["3", "2026-06-20T18:00:00.000+00:00", 46_206, 113, "July", "Jun 29 – Jul 05", 27],
      ["4", "2026-07-08T18:00:00.000+00:00", 46_212, 119, "July", "Jul 06 – Jul 12", 28],
    ])
    expect(projection.scope).toEqual({
      dateOrderStart: "2026-03-13",
      reportDate: "2026-07-09",
      submittedAtStart: "2026-07-03",
      submittedAtEndExclusive: "2026-07-10",
      sourceRowCount: 6,
      classifiedRowCount: 5,
      unclassifiedRowCount: 1,
      includedRowCount: 2,
      datedIncludedRowCount: 1,
      excludedRowCount: 3,
      excludedReasonCounts: {
        missing_or_invalid_submitted_at: 1,
        submitted_before_period: 1,
        submitted_at_or_after_period_end: 1,
      },
    })
    expect(projection.excludedRows).toEqual([
      { scorecardId: "2", reason: "submitted_before_period" },
      { scorecardId: "5", reason: "submitted_at_or_after_period_end" },
      { scorecardId: "6", reason: "missing_or_invalid_submitted_at" },
    ])
    expect(projection.dated.rows[0].values[1]).toBe(1)
  })

  test("renders the exact dated title/merge/header contract and eight-column team aggregate", () => {
    const projection = projectDeliveryRoleRps({
      rows: [
        row({ scorecard_id: "1", submitted_at: "2026-07-09T01:00:00.000Z", match_mismatch: "match", overall_recommendation: "strong_yes" }),
        row({ scorecard_id: "2", submitted_at: "2026-07-09T12:00:00.000Z", match_mismatch: "mismatch", overall_recommendation: "yes" }),
        row({ scorecard_id: "3", submitted_at: "2026-07-09T23:59:59.999Z", match_mismatch: "unknown", overall_recommendation: "definitely_not" }),
        row({ scorecard_id: "4", submitted_at: "2026-07-09T18:00:00.000Z", match_mismatch: "match", overall_recommendation: "no" }),
        row({ scorecard_id: "5", submitted_at: "2026-07-08T23:59:59.999Z", match_mismatch: "match", overall_recommendation: "strong_yes" }),
      ],
      roster,
      isDeliveryRole: () => true,
      dateOrderStart: "2026-03-13",
      submittedAtStart: "2026-07-03",
      submittedAtEndExclusive: "2026-07-10",
      reportDate: "2026-07-09",
    })

    expect(projection.dated).toMatchObject({
      sheetTitle: "09 Jul 2026",
      titleCell: "A1",
      titleValue: "Recruiter Role Report - 09 Jul 2026",
      mergeRanges: ["A1:N1"],
      sectionLabelCell: "A3",
      sectionLabel: "Summary by Team",
      headerRow: 4,
      headers: DELIVERY_RPS_DATED_HEADERS,
      dataStartRow: 5,
    })
    expect(projection.dated.rows).toEqual([
      {
        teamName: "Team Platform",
        hodName: "Platform HOD",
        values: ["Team Platform", 4, 2, 1, 1, 1, 1, 1],
      },
    ])
    expect(projection.raw.rows).toHaveLength(5)
    expect(projection.scope.datedIncludedRowCount).toBe(4)
  })

  test("keeps unresolved roster identity blank/null and validates ordinal anchors", () => {
    const projection = projectRpsTrackingSheet({
      rows: [row({ submitter_name: "Not In Roster" })],
      roster,
      periodStartMonday: "2026-06-29",
      submittedAtStart: "2026-07-01",
      submittedAtEndExclusive: "2026-10-01",
    })
    expect(projection.rows[0]).toMatchObject({
      submitterTeamName: null,
      submitterHodName: null,
      submitterTeamResolutionStatus: "unresolved",
    })
    expect(projection.rows[0].values[13]).toBe("")

    expect(() => projectRpsTrackingSheet({
      rows: [],
      roster,
      periodStartMonday: "2026-07-01",
      submittedAtStart: "2026-07-01",
      submittedAtEndExclusive: "2026-10-01",
    })).toThrow(
      "must be a Monday"
    )
    expect(() => projectRpsTrackingSheet({
      rows: [],
      roster,
      periodStartMonday: "2026-06-29",
      submittedAtStart: "2026-07-06",
      submittedAtEndExclusive: "2026-10-01",
    })).toThrow("must fall within the week")
    expect(() => projectRpsTrackingSheet({
      rows: [],
      roster,
      periodStartMonday: "2026-06-29",
      submittedAtStart: "2026-07-01",
      submittedAtEndExclusive: "2026-07-01",
    })).toThrow("must be after")
    expect(() => projectDeliveryRoleRps({
      rows: [row()],
      roster,
      isDeliveryRole: () => true,
      dateOrderStart: "2026-07-09",
      submittedAtStart: "2026-07-03",
      submittedAtEndExclusive: "2026-07-10",
      reportDate: "2026-07-09",
    })).toThrow("dateOrderStart must be on or before submittedAtStart")
  })
})
