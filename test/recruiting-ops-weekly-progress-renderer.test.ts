import { describe, expect, test } from "vitest"

import {
  renderWeeklyProgressQuarterClosingOffsets,
  renderWeeklyProgressQuarterOpeningOffsets,
  renderWeeklyProgressValues,
} from "../lib/recruiting-ops/delivery/weekly-progress-renderer"
import type { CandidateStageEventRow } from "../lib/recruiting-ops/delivery-source/candidate-stage-events"
import type { OfferLifecycleExportRow } from "../lib/recruiting-ops/delivery-source/offer-lifecycle-export"
import type { ScorecardSubmissionRow } from "../lib/recruiting-ops/delivery-source/scorecard-submission"

const candidate = {
  event_key: "event",
  source_kind: "application_stage",
  source_stage_event_id: "stage",
  source_outcome_id: null,
  week_order: 32,
  week: "Jul 3 - Jul 9",
  week_label: "Jul 3, 2026 - Jul 9, 2026",
  reporting_week_friday: "2026-07-03",
  reporting_week_thursday: "2026-07-09",
  job_id: "job",
  requisition_id: "890",
  job_name: "Job",
  application_id: "app",
  candidate_id: "candidate",
  candidate_name: "Candidate",
  recruiter_id: "recruiter",
  recruiter_name: "Recruiter",
  raw_stage_id: "stage",
  stage_name: "Onsite",
  core_stage: "Onsite Interview",
  core_stage_order: 6,
  stage_resolution_source: "governed",
  event_type: "passed",
  event_ts: "2026-07-06T00:00:00Z",
  application_status: "in_process",
  current_stage_id: "stage",
  current_stage_name: "Onsite",
  current_core_stage: "Onsite Interview",
  current_core_stage_order: 6,
  rejected_at: null,
  withdrew: null,
  rejected_by: null,
  rejection_reason_id: null,
  rejection_reason: null,
  outcome_direction: null,
} satisfies CandidateStageEventRow

const offer = {
  offer_id: "offer",
  offer_status: "accepted",
  requisition_id: "890",
  created_at: "2026-07-05T00:00:00Z",
  resolved_at: "2026-07-08T00:00:00Z",
} as OfferLifecycleExportRow

const scorecard = {
  scorecard_id: "scorecard",
  requisition_id: "890",
  interview_name: "Recruiter Phone Screen",
  scheduled_interview_ended_at: "2026-07-07T00:00:00Z",
} as ScorecardSubmissionRow

describe("weekly progress renderer", () => {
  test("uses offer, true-pass and scorecard-grain evidence for exact stage rows", () => {
    const result = renderWeeklyProgressValues({
      bucket: "fde_pe",
      reportingWeekFriday: "2026-07-03",
      candidateEvents: [candidate, { ...candidate, event_key: "duplicate", application_id: "app" }],
      offers: [offer],
      scorecards: [scorecard],
    })
    expect(result.rowLabels).toEqual([
      "Offer Accepted",
      "Offer",
      "Onsite Interview",
      "Manager / Tech Screen",
      "Hiring Manager Resume Review",
      "Recruiter Phone Screen Conducted",
    ])
    expect(result.values).toEqual([[1], [1], [1], [0], [0], [1]])
  })

  test("keeps buckets and Fri-Thu periods isolated", () => {
    const result = renderWeeklyProgressValues({
      bucket: "code_rl",
      reportingWeekFriday: "2026-07-03",
      candidateEvents: [candidate],
      offers: [offer],
      scorecards: [scorecard],
    })
    expect(result.values.every(([value]) => value === 0)).toBe(true)
  })

  test("does not apply the legacy BIC copy-staging clock to weekly progress", () => {
    const result = renderWeeklyProgressValues({
      bucket: "fde_pe",
      reportingWeekFriday: "2026-07-03",
      candidateEvents: [],
      offers: [],
      scorecards: [{
        ...scorecard,
        scheduled_interview_ended_at: null,
        interviewed_at: null,
        submitted_at: "2026-07-07T00:00:00.000Z",
        legacy_bic_reporting_at: "2026-08-07T00:00:00.000Z",
      } as ScorecardSubmissionRow],
    })

    expect(result.values.at(-1)).toEqual([1])
  })

  test("derives exact calendar-quarter opening offsets before the first Friday", () => {
    const offsets = renderWeeklyProgressQuarterOpeningOffsets({
      reportingWeekFriday: "2026-07-10",
      candidateEvents: [],
      offers: [],
      scorecards: [
        {
          ...scorecard,
          scorecard_id: "opening-1",
          scheduled_interview_ended_at: "2026-07-01T12:00:00.000Z",
        } as ScorecardSubmissionRow,
        {
          ...scorecard,
          scorecard_id: "opening-2",
          scheduled_interview_ended_at: "2026-07-02T23:59:59.000Z",
        } as ScorecardSubmissionRow,
        {
          ...scorecard,
          scorecard_id: "first-full-week",
          scheduled_interview_ended_at: "2026-07-03T00:00:00.000Z",
        } as ScorecardSubmissionRow,
      ],
    })

    expect(offsets.fde_pe).toEqual([0, 0, 0, 0, 0, 2])
    expect(offsets.code_rl).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(offsets.brazil_colombia).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  test("uses zero opening offsets when the calendar quarter starts Friday", () => {
    const offsets = renderWeeklyProgressQuarterOpeningOffsets({
      reportingWeekFriday: "2027-01-08",
      candidateEvents: [],
      offers: [],
      scorecards: [{
        ...scorecard,
        scheduled_interview_ended_at: "2027-01-01T12:00:00.000Z",
      } as ScorecardSubmissionRow],
    })

    expect(offsets.fde_pe).toEqual([0, 0, 0, 0, 0, 0])
  })

  test("derives exact quarter-closing offsets from a straddling Fri-Thu week", () => {
    const offsets = renderWeeklyProgressQuarterClosingOffsets({
      reportingWeekFriday: "2026-09-25",
      candidateEvents: [
        {
          ...candidate,
          event_key: "same-app-in-quarter",
          application_id: "same-app",
          reporting_week_friday: "2026-09-25",
          event_ts: "2026-09-30T12:00:00.000Z",
          core_stage: "Manager / Tech Screen",
        } as CandidateStageEventRow,
        {
          ...candidate,
          event_key: "same-app-next-quarter",
          application_id: "same-app",
          reporting_week_friday: "2026-09-25",
          event_ts: "2026-10-01T08:00:00.000Z",
          core_stage: "Manager / Tech Screen",
        } as CandidateStageEventRow,
        {
          ...candidate,
          event_key: "new-app-next-quarter",
          application_id: "new-app",
          reporting_week_friday: "2026-09-25",
          event_ts: "2026-10-01T09:00:00.000Z",
          core_stage: "Manager / Tech Screen",
        } as CandidateStageEventRow,
      ],
      offers: [],
      scorecards: [
        {
          ...scorecard,
          scorecard_id: "quarter-last-day",
          scheduled_interview_ended_at: "2026-09-30T23:59:59.000Z",
        } as ScorecardSubmissionRow,
        {
          ...scorecard,
          scorecard_id: "next-quarter-day",
          scheduled_interview_ended_at: "2026-10-01T12:00:00.000Z",
        } as ScorecardSubmissionRow,
      ],
    })

    expect(offsets.fde_pe).toEqual([0, 0, 0, 1, 0, 1])
    expect(offsets.code_rl).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(offsets.brazil_colombia).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  test("uses zero closing offsets for a week contained inside its quarter", () => {
    const offsets = renderWeeklyProgressQuarterClosingOffsets({
      reportingWeekFriday: "2026-07-10",
      candidateEvents: [],
      offers: [],
      scorecards: [{
        ...scorecard,
        scheduled_interview_ended_at: "2026-07-16T12:00:00.000Z",
      } as ScorecardSubmissionRow],
    })

    expect(offsets.fde_pe).toEqual([0, 0, 0, 0, 0, 0])
  })
})
