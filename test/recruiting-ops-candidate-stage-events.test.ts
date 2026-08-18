import { describe, expect, test } from "vitest"

import { buildGovernedFunnelMap } from "../lib/recruiting-ops/exec-definitions"
import {
  CANDIDATE_STAGE_EVENT_WEEK_ORDER_EPOCH,
  emitCandidateStageEventRows,
  type EmitCandidateStageEventRowsInput,
} from "../lib/recruiting-ops/delivery-source/candidate-stage-events"

const governedFunnel = buildGovernedFunnelMap([
  { stageLabel: "Phone Chat", funnelStage: "Recruiter Phone Screen" },
  { stageLabel: "RPS Debrief", funnelStage: "Recruiter Phone Screen" },
  { stageLabel: "HM Review Custom", funnelStage: "Hiring Manager Review" },
  { stageLabel: "Final Loop", funnelStage: "Onsite Interview" },
])

function fixture(overrides: Partial<EmitCandidateStageEventRowsInput> = {}): EmitCandidateStageEventRowsInput {
  return {
    applications: [
      {
        id: 1001,
        job_id: 10,
        candidate_id: 9001,
        status: "in_process",
        stage_id: 104,
        stage_name: "Final Loop",
      },
    ],
    applicationStages: [
      {
        id: 5001,
        application_id: 1001,
        job_interview_stage_id: 101,
        entered_at: "2026-07-02T23:00:00.000Z",
        exited_at: "2026-07-03T00:00:00.000Z",
        current: false,
      },
      {
        id: 5002,
        application_id: 1001,
        job_interview_stage_id: 104,
        entered_at: "2026-07-03T00:00:00.000Z",
        exited_at: null,
        current: true,
      },
    ],
    jobInterviewStages: [
      { id: 101, job_id: 10, name: "Phone Chat" },
      { id: 102, job_id: 10, name: "RPS Debrief" },
      { id: 103, job_id: 10, name: "HM Review Custom" },
      { id: 104, job_id: 10, name: "Final Loop" },
    ],
    jobs: [{ id: 10, requisition_id: 907, name: "Research Engineer" }],
    candidates: [{ id: 9001, first_name: "Private", last_name: "Candidate" }],
    jobOwners: [{ id: 7001, job_id: 10, user_id: 8001, type: "recruiter", responsible: true }],
    users: [{ id: 8001, name: "Recruiter One" }],
    governedFunnel,
    ...overrides,
  }
}

describe("emitCandidateStageEventRows", () => {
  test("attributes a jump pass to the true exited origin stage and uses governed Fri-Thu weeks", () => {
    const rows = emitCandidateStageEventRows(fixture())

    expect(CANDIDATE_STAGE_EVENT_WEEK_ORDER_EPOCH).toBe("2025-11-28")
    expect(rows).toHaveLength(3)
    const enteredRps = rows.find((row) => row.source_stage_event_id === "5001" && row.event_type === "entered")!
    const passedRps = rows.find((row) => row.source_stage_event_id === "5001" && row.event_type === "passed")!
    const enteredOnsite = rows.find((row) => row.source_stage_event_id === "5002" && row.event_type === "entered")!

    expect(enteredRps).toMatchObject({
      week_order: 31,
      week: "Jun 26 - Jul 2",
      week_label: "Jun 26, 2026 - Jul 2, 2026",
      reporting_week_friday: "2026-06-26",
      reporting_week_thursday: "2026-07-02",
      requisition_id: "907",
      job_name: "Research Engineer",
      application_id: "1001",
      candidate_id: "9001",
      candidate_name: "Private Candidate",
      recruiter_id: "8001",
      recruiter_name: "Recruiter One",
      stage_name: "Phone Chat",
      core_stage: "Recruiter Phone Screen",
      event_ts: "2026-07-02T23:00:00.000Z",
      application_status: "in_process",
      current_stage_name: "Final Loop",
      current_core_stage: "Onsite Interview",
    })
    expect(passedRps).toMatchObject({
      week_order: 32,
      week: "Jul 3 - Jul 9",
      stage_name: "Phone Chat",
      core_stage: "Recruiter Phone Screen",
      event_type: "passed",
      event_ts: "2026-07-03T00:00:00.000Z",
    })
    expect(enteredOnsite).toMatchObject({
      week_order: 32,
      stage_name: "Final Loop",
      core_stage: "Onsite Interview",
      event_type: "entered",
    })
    expect(rows.some((row) => row.event_type === "passed" && row.core_stage === "Skills Assessment")).toBe(false)
  })

  test("does not call an exit a pass unless the next occupied row is a higher canonical stage", () => {
    const rows = emitCandidateStageEventRows(
      fixture({
        applicationStages: [
          {
            id: 5001,
            application_id: 1001,
            job_interview_stage_id: 101,
            entered_at: "2026-03-13T09:00:00Z",
            exited_at: "2026-03-14T09:00:00Z",
          },
          {
            id: 5002,
            application_id: 1001,
            job_interview_stage_id: 102,
            entered_at: "2026-03-14T09:00:00Z",
            exited_at: "2026-03-15T09:00:00Z",
          },
          {
            id: 5003,
            application_id: 1001,
            job_interview_stage_id: 103,
            entered_at: "2026-03-15T09:00:00Z",
            exited_at: "2026-03-16T09:00:00Z",
          },
        ],
      })
    )

    const passRows = rows.filter((row) => row.event_type === "passed")
    expect(passRows).toHaveLength(1)
    expect(passRows[0]).toMatchObject({
      source_stage_event_id: "5002",
      stage_name: "RPS Debrief",
      core_stage: "Recruiter Phone Screen",
      event_ts: "2026-03-15T09:00:00.000Z",
    })
    expect(rows.some((row) => row.source_stage_event_id === "5003" && row.event_type === "passed")).toBe(false)
  })

  test("emits explicit rejected and withdrawn outcomes with terminal direction fields", () => {
    const rows = emitCandidateStageEventRows(
      fixture({
        applications: [
          { id: 1001, job_id: 10, candidate_id: 9001, status: "rejected", stage_id: 101, stage_name: "Phone Chat" },
          { id: 1002, job_id: 10, candidate_id: 9002, status: "rejected", stage_id: 103, stage_name: "HM Review Custom" },
        ],
        applicationStages: [],
        candidates: [
          { id: 9001, first_name: "First", last_name: "Person" },
          { id: 9002, first_name: "Second", last_name: "Person" },
        ],
        outcomes: [
          {
            id: "outcome-1",
            application_id: 1001,
            event_type: "rejected",
            event_at: "2026-03-19T23:59:59Z",
            rejection_reason_id: 44,
            rejection_reason: "Skills mismatch",
            rejected_by: "Recruiter One",
          },
          {
            id: "outcome-2",
            application_id: 1002,
            event_type: "withdrawn",
            event_at: "2026-03-20T00:00:00Z",
            rejection_reason: "Candidate withdrew",
            withdrew: "Withdrew from Hiring Manager Review",
          },
        ],
      })
    )

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      source_outcome_id: "outcome-1",
      week_order: 16,
      week: "Mar 13 - Mar 19",
      event_type: "rejected",
      rejected_at: "2026-03-19T23:59:59.000Z",
      withdrew: null,
      rejected_by: "Recruiter One",
      rejection_reason_id: "44",
      rejection_reason: "Skills mismatch",
      outcome_direction: "company_rejected",
    })
    expect(rows[1]).toMatchObject({
      source_outcome_id: "outcome-2",
      week_order: 17,
      week: "Mar 20 - Mar 26",
      event_type: "withdrawn",
      rejected_at: "2026-03-20T00:00:00.000Z",
      withdrew: "Withdrew from Hiring Manager Review",
      rejected_by: null,
      rejection_reason: "Candidate withdrew",
      outcome_direction: "candidate_withdrew",
    })
  })

  test("keeps event keys and output order stable across overlapping, differently ordered pulls", () => {
    const input = fixture()
    const first = emitCandidateStageEventRows(input)
    const second = emitCandidateStageEventRows({
      ...input,
      applications: [...input.applications].reverse(),
      applicationStages: [
        ...input.applicationStages,
        { ...input.applicationStages[0], exited_at: null },
      ].reverse(),
      jobInterviewStages: [...input.jobInterviewStages].reverse(),
      jobs: [...input.jobs].reverse(),
    })

    expect(second).toEqual(first)
    expect(new Set(first.map((row) => row.event_key)).size).toBe(first.length)
    expect(first.every((row) => row.event_key.startsWith("candidate-stage-event:v1:"))).toBe(true)
  })

  test("skips scaffolding/invalid timestamps and never invents a terminal event from status alone", () => {
    const rows = emitCandidateStageEventRows(
      fixture({
        applications: [{ id: 1001, job_id: 10, candidate_id: 9001, status: "rejected", stage_name: "Phone Chat" }],
        applicationStages: [
          { id: 5001, application_id: 1001, job_interview_stage_id: 101, entered_at: null, exited_at: null, current: false },
          { id: 5002, application_id: 1001, job_interview_stage_id: 101, entered_at: "not-a-timestamp", exited_at: null },
        ],
        outcomes: [
          { id: "bad", application_id: 1001, event_type: "rejected", event_at: "not-a-timestamp" },
        ],
      })
    )

    expect(rows).toEqual([])
  })
})
