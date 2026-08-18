import { describe, expect, test } from "vitest"

import {
  deriveScorecardSubmissionRows,
  legacyBicCompatibleReportingTimestamp,
  type ScorecardSubmissionSources,
} from "../lib/recruiting-ops/delivery-source/scorecard-submission"

function completeSources(): ScorecardSubmissionSources {
  return {
    scorecards: [
      {
        id: 9001,
        application_id: 100,
        interview_kit_id: 600,
        interviewer_id: 700,
        submitter_id: 701,
        status: "complete",
        created_at: "2026-07-09T16:45:00Z",
        updated_at: "2026-07-09T19:05:00Z",
        interviewed_at: "2026-07-09T17:00:00Z",
        submitted_at: "2026-07-09T19:00:00Z",
        candidate_rating: "strong_yes",
        overall_recommendation: "yes",
        qa_summary: "Complete and internally consistent.",
        questions: [{ question: "Key Take-Aways", answer: "Clear systems reasoning." }],
      },
    ],
    applications: [
      {
        id: 100,
        candidate_id: 200,
        job_id: 300,
        status: "rejected",
      },
    ],
    candidates: [{ id: 200, first_name: "Casey", last_name: "Candidate" }],
    jobs: [
      {
        id: 300,
        requisition_id: 890,
        name: "Principal Engineer",
        status: "open",
        recruiter: { id: 10, name: "Primary Recruiter" },
        sourcer: { id: 20, name: "Primary Sourcer" },
        hiring_team: {
          recruiters: [
            { id: 10, name: "Primary Recruiter" },
            { id: 11, name: "Backup Recruiter" },
          ],
          sourcers: [{ id: 20, name: "Primary Sourcer" }],
        },
      },
    ],
    interviewKits: [{ id: 600, job_id: 300, job_interview_id: 400 }],
    jobInterviews: [{ id: 400, job_id: 300, name: "Recruiter Phone Screen" }],
    scheduledInterviews: [
      {
        id: 500,
        application_id: 100,
        job_interview_id: 400,
        ends_at: "2026-07-09T18:00:00Z",
        interviewers: [{ id: 700, name: "Interview Owner" }],
      },
    ],
    users: [
      { id: 700, name: "Interview Owner" },
      { id: 701, first_name: "Scorecard", last_name: "Submitter" },
    ],
  }
}

describe("scorecard-submission delivery source", () => {
  test("emits one fully enriched artifact-agnostic row at scorecard grain", () => {
    expect(deriveScorecardSubmissionRows(completeSources())).toEqual([
      {
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
        scheduled_interview_ended_at: "2026-07-09T18:00:00.000Z",
        interviewed_at: "2026-07-09T17:00:00.000Z",
        created_at: "2026-07-09T16:45:00.000Z",
        updated_at: "2026-07-09T19:05:00.000Z",
        submitted_at: "2026-07-09T19:00:00.000Z",
        legacy_bic_reporting_at: "2026-07-09T16:45:00.000Z",
        submitter_id: "701",
        submitter_name: "Scorecard Submitter",
        scorecard_status: "complete",
        candidate_rating: "strong_yes",
        overall_recommendation: "yes",
        match_mismatch: "mismatch",
        month_bucket: "2026-07",
        month_ordinal: 24318,
        week_bucket: "2026-07-06",
        week_ordinal: 2948,
        qa_summary: "Complete and internally consistent.",
        key_takeaways: "Clear systems reasoning.",
      },
    ])
  })

  test("keeps native clocks distinct and applies the legacy BIC created-at preference explicitly", () => {
    expect(legacyBicCompatibleReportingTimestamp({
      created_at: "2026-05-27T23:59:59.999Z",
      submitted_at: "2026-05-29T10:00:00.000Z",
    })).toBe("2026-05-27T23:59:59.999Z")
    expect(legacyBicCompatibleReportingTimestamp({
      created_at: "not-a-clock",
      submitted_at: "2026-05-29T10:00:00.000Z",
    })).toBe("2026-05-29T10:00:00.000Z")
    expect(legacyBicCompatibleReportingTimestamp({
      created_at: null,
      submitted_at: "2026-03-03T10:00:00.000Z",
    })).toBe("2026-03-03T10:00:00.000Z")

    const [row] = deriveScorecardSubmissionRows({
      scorecards: [{
        id: "clock-contract",
        created_at: "2026-06-01T08:00:00.123Z",
        updated_at: "2026-06-01T09:00:00.456Z",
        submitted_at: "2026-06-01T10:00:00.789Z",
      }],
    })
    expect(row).toMatchObject({
      created_at: "2026-06-01T08:00:00.123Z",
      updated_at: "2026-06-01T09:00:00.456Z",
      submitted_at: "2026-06-01T10:00:00.789Z",
      legacy_bic_reporting_at: "2026-06-01T08:00:00.123Z",
    })
  })

  test("uses direct actors, rating aliases, question feedback, and name equality fallbacks", () => {
    const rows = deriveScorecardSubmissionRows({
      scorecards: [
        {
          id: "2",
          application_id: "100",
          interviewer: { name: "Same Person" },
          submitted_by: { name: " same   person " },
          overall_rating: "yes",
          submitted_at: "2026-01-04T23:59:59Z",
          questions: [
            { question: "QA Summary", answer: "QA answer" },
            { question: "key takeaways", answer: "Takeaway answer" },
          ],
        },
      ],
    })

    expect(rows[0]).toMatchObject({
      scorecard_id: "2",
      interviewer_name: "Same Person",
      submitter_name: "same   person",
      candidate_rating: "yes",
      overall_recommendation: "yes",
      match_mismatch: "match",
      month_bucket: "2026-01",
      week_bucket: "2025-12-29",
      qa_summary: "QA answer",
      key_takeaways: "Takeaway answer",
    })
  })

  test("selects the scheduled interview nearest the scorecard clock", () => {
    const source = completeSources()
    const rows = deriveScorecardSubmissionRows({
      ...source,
      scheduledInterviews: [
        {
          id: 1,
          application_id: 100,
          job_interview_id: 400,
          ends_at: "not-a-date",
        },
        {
          id: 2,
          application_id: 100,
          job_interview_id: 400,
          ends_at: "2026-07-09T17:15:00Z",
        },
      ],
    })

    expect(rows[0].scheduled_interview_ended_at).toBe("2026-07-09T17:15:00.000Z")
  })

  test("resolves every recruiter and sourcer through live v3 job owners when jobs have no embedded team", () => {
    const source = completeSources()
    const rows = deriveScorecardSubmissionRows({
      ...source,
      jobs: [{ id: 300, requisition_id: 890, name: "Principal Engineer", status: "open" }],
      jobOwners: [
        { id: 1, job_id: 300, user_id: 11, type: "recruiter", responsible: false },
        { id: 2, job_id: 300, user_id: 10, type: "Recruiter", responsible: true },
        { id: 3, job_id: 300, user_id: 20, type: "sourcer", responsible: true },
        { id: 4, job_id: 300, user_id: 30, type: "coordinator", responsible: true },
      ],
      users: [
        ...(source.users ?? []),
        { id: 10, name: "Responsible Recruiter" },
        { id: 11, name: "Additional Recruiter" },
        { id: 20, name: "Responsible Sourcer" },
        { id: 30, name: "Coordinator Not Included" },
      ],
    })

    expect(rows[0]).toMatchObject({
      recruiter_names: ["Responsible Recruiter", "Additional Recruiter"],
      sourcer_names: ["Responsible Sourcer"],
    })
  })

  test("preserves scorecard grain, sorts IDs deterministically, and fails closed on bad grain", () => {
    const rows = deriveScorecardSubmissionRows({
      scorecards: [{ id: 10 }, { id: 2 }, { id: "alpha" }],
    })
    expect(rows.map((row) => row.scorecard_id)).toEqual(["2", "10", "alpha"])

    expect(() => deriveScorecardSubmissionRows({ scorecards: [{ status: "draft" }] })).toThrow(
      "missing scorecard id"
    )
    expect(() => deriveScorecardSubmissionRows({ scorecards: [{ id: 1 }, { id: "1" }] })).toThrow(
      "duplicate scorecard id 1"
    )
  })

  test("emits null enrichment without inventing timestamps or display fields", () => {
    expect(deriveScorecardSubmissionRows({ scorecards: [{ id: 1, submitted_at: "not-a-date" }] })[0]).toMatchObject({
      scorecard_id: "1",
      application_id: null,
      candidate_name: null,
      recruiter_names: [],
      sourcer_names: [],
      scheduled_interview_ended_at: null,
      created_at: null,
      updated_at: null,
      submitted_at: null,
      legacy_bic_reporting_at: null,
      match_mismatch: "unknown",
      month_bucket: null,
      month_ordinal: null,
      week_bucket: null,
      week_ordinal: null,
      qa_summary: null,
      key_takeaways: null,
    })
  })
})
