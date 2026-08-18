import { describe, expect, test } from "vitest"

import {
  pipelineLegacyWeekOrder,
  renderPipelineCandidateRows,
  renderPipelineJobWeekRows,
} from "../lib/recruiting-ops/delivery/pipeline-sheet-renderer"
import type { CandidateStageEventRow } from "../lib/recruiting-ops/delivery-source/candidate-stage-events"

function event(overrides: Partial<CandidateStageEventRow> = {}): CandidateStageEventRow {
  return {
    event_key: "event-1",
    source_kind: "application_stage",
    source_stage_event_id: "stage-1",
    source_outcome_id: null,
    week_order: 32,
    week: "Jul 3 - Jul 9",
    week_label: "Jul 3, 2026 - Jul 9, 2026",
    reporting_week_friday: "2026-07-03",
    reporting_week_thursday: "2026-07-09",
    job_id: "job-1",
    requisition_id: "890",
    job_name: "Platform Engineer",
    application_id: "app-1",
    candidate_id: "person-1",
    candidate_name: "Candidate One",
    recruiter_id: "recruiter-1",
    recruiter_name: "Recruiter One",
    raw_stage_id: "stage-plan-1",
    stage_name: "Recruiter Phone Screen",
    core_stage: "Recruiter Phone Screen",
    core_stage_order: 2,
    stage_resolution_source: "governed",
    event_type: "entered",
    event_ts: "2026-07-04T12:00:00.000Z",
    application_status: "in_process",
    current_stage_id: "stage-plan-1",
    current_stage_name: "Recruiter Phone Screen",
    current_core_stage: "Recruiter Phone Screen",
    current_core_stage_order: 2,
    rejected_at: null,
    withdrew: null,
    rejected_by: null,
    rejection_reason_id: null,
    rejection_reason: null,
    outcome_direction: null,
    ...overrides,
  }
}

describe("pipeline copy renderer", () => {
  test("renders exact common candidate columns and 890 withdrawal columns", () => {
    const row = renderPipelineCandidateRows({
      artifactKey: "pipeline_890",
      reportingWeekFriday: "2026-07-03",
      rows: [event({ event_type: "withdrawn", withdrew: "Withdrew", rejected_by: "Actor", rejection_reason: "Reason" })],
    })[0]
    expect(row).toHaveLength(17)
    expect(row.slice(0, 14)).toEqual([
      31, "Jul 3 - Jul 9", "890", "Platform Engineer", "app-1", "Candidate One", "Recruiter One",
      "Recruiter Phone Screen", "Recruiter Phone Screen", "withdrawn", "2026-07-04T12:00:00.000Z",
      "in_process", null, "Recruiter Phone Screen",
    ])
    expect(row.slice(14)).toEqual(["Withdrew", "Actor", "Reason"])
  })

  test("filters to the artifact reqs and completed reporting week", () => {
    const rows = renderPipelineCandidateRows({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-07-03",
      rows: [
        event({ requisition_id: "907" }),
        event({ requisition_id: "890" }),
        event({ requisition_id: "907", reporting_week_friday: "2026-06-26" }),
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveLength(14)
  })

  test("renders explicit enter/pass/reject triplets without destination inference", () => {
    const rows = [
      event({ event_key: "1", event_type: "entered", application_id: "a" }),
      event({ event_key: "2", event_type: "entered", application_id: "a" }),
      event({ event_key: "3", event_type: "passed", application_id: "a" }),
      event({ event_key: "4", event_type: "rejected", application_id: "b" }),
    ]
    const [summary] = renderPipelineJobWeekRows({
      artifactKey: "pipeline_890",
      reportingWeekFriday: "2026-07-03",
      rows,
      jobOpenDateByReq: new Map([["890", "2026-01-01"]]),
    })
    expect(summary.cells.slice(0, 5)).toEqual([31, "Jul 3 - Jul 9", "890", "Platform Engineer", "2026-01-01"])
    // Recruiter Phone Screen is the third stage group: F starts at cell 5, + 2*3.
    expect(summary.cells.slice(11, 14)).toEqual([1, 1, 1])
  })

  test("uses the governed display ordinal anchored in each copied legacy pipeline", () => {
    expect(pipelineLegacyWeekOrder("pipeline_890", "2026-07-03")).toBe(31)
    expect(pipelineLegacyWeekOrder("pipeline_907", "2026-07-03")).toBe(29)
    expect(pipelineLegacyWeekOrder("pipeline_1026_1027", "2026-07-03")).toBe(31)
    expect(pipelineLegacyWeekOrder("pipeline_1118_1119", "2026-07-03")).toBe(32)
    expect(pipelineLegacyWeekOrder("pipeline_907", "2026-07-10")).toBe(30)
    expect(() => pipelineLegacyWeekOrder("pipeline_907", "2026-07-04")).toThrow("valid Friday")
  })
})
