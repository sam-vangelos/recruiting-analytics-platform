import { describe, expect, test } from "vitest"

import { buildGovernedFunnelMap } from "../lib/recruiting-ops/exec-definitions"
import { emitCandidateStageEventRows } from "../lib/recruiting-ops/delivery-source/candidate-stage-events"
import {
  mapHarvestApplicationsToCandidateStageOutcomes,
  type MapHarvestCandidateStageOutcomesInput,
} from "../lib/recruiting-ops/delivery-source/harvest-candidate-stage-outcomes"

function baseInput(overrides: Partial<MapHarvestCandidateStageOutcomesInput> = {}): MapHarvestCandidateStageOutcomesInput {
  return {
    applications: [
      {
        id: 1001,
        job_id: 10,
        candidate_id: 9001,
        stage_id: 101,
        stage_name: "Phone Chat",
        status: "rejected",
        rejected_at: "2026-07-03T10:00:00Z",
        rejection_reason: {
          id: 44,
          name: "Skills mismatch",
          type: { key: "we_rejected_them", name: "We rejected them" },
        },
        rejected_by: { id: 8001, name: "Operator One" },
      },
    ],
    ...overrides,
  }
}

describe("mapHarvestApplicationsToCandidateStageOutcomes", () => {
  test("maps nested application rejection evidence to a company-rejected source", () => {
    expect(mapHarvestApplicationsToCandidateStageOutcomes(baseInput())).toEqual([
      {
        id: "harvest-application-outcome:1001",
        application_id: "1001",
        event_type: "rejected",
        event_at: "2026-07-03T10:00:00.000Z",
        stage_id: "101",
        stage_name: "Phone Chat",
        rejection_reason_id: "44",
        rejection_reason: "Skills mismatch",
        withdrew: null,
        rejected_by: "Operator One",
      },
    ])
  })

  test("maps joined They-rejected-us direction to withdrawn and resolves a scalar actor id", () => {
    const outcomes = mapHarvestApplicationsToCandidateStageOutcomes(
      baseInput({
        applications: [
          {
            id: 1002,
            job_id: 10,
            candidate_id: 9002,
            stage_id: 102,
            stage_name: "Final Loop",
            status: "rejected",
            rejected_at: "2026-07-09T23:59:59Z",
            rejection_reason_id: 45,
            rejected_by: 8002,
          },
        ],
        rejectionReasons: [
          { id: 45, name: "Candidate declined", type: { key: "they_rejected_us", name: "They rejected us" } },
        ],
        directionEvidence: [
          {
            application_id: 1002,
            direction: "candidate_withdrew",
            withdrew: "Withdrew from Onsite Interviews",
          },
        ],
        users: [{ id: 8002, name: "Operator Two" }],
      })
    )

    expect(outcomes).toEqual([
      expect.objectContaining({
        application_id: "1002",
        event_type: "withdrawn",
        event_at: "2026-07-09T23:59:59.000Z",
        rejection_reason_id: "45",
        rejection_reason: "Candidate declined",
        withdrew: "Withdrew from Onsite Interviews",
        rejected_by: "Operator Two",
      }),
    ])

    const rows = emitCandidateStageEventRows({
      applications: baseInput({
        applications: [
          { id: 1002, job_id: 10, candidate_id: 9002, status: "rejected", stage_id: 102, stage_name: "Final Loop" },
        ],
      }).applications,
      applicationStages: [],
      jobInterviewStages: [{ id: 102, job_id: 10, name: "Final Loop" }],
      jobs: [{ id: 10, requisition_id: 890, name: "Platform Engineer" }],
      governedFunnel: buildGovernedFunnelMap([{ stageLabel: "Final Loop", funnelStage: "Onsite Interview" }]),
      outcomes,
    })
    expect(rows).toEqual([
      expect.objectContaining({
        source_outcome_id: "harvest-application-outcome:1002",
        event_type: "withdrawn",
        week: "Jul 3 - Jul 9",
        core_stage: "Onsite Interview",
        outcome_direction: "candidate_withdrew",
      }),
    ])
  })

  test("preserves scalar rejection reason id/name with direct structured direction", () => {
    expect(
      mapHarvestApplicationsToCandidateStageOutcomes({
        applications: [
          {
            id: 1004,
            status: "rejected",
            rejected_at: "2026-07-04T12:00:00Z",
            rejection_reason_id: 46,
            rejection_reason_name: "Role requirements not met",
            rejection_direction: "company_rejected",
          },
        ],
      })
    ).toEqual([
      expect.objectContaining({
        application_id: "1004",
        event_type: "rejected",
        rejection_reason_id: "46",
        rejection_reason: "Role requirements not met",
      }),
    ])
  })

  test("does not fabricate from terminal status without a timestamp and explicit direction", () => {
    const applications = [
      { id: 1, status: "rejected" },
      { id: 2, status: "rejected", rejected_at: "2026-07-03T10:00:00Z" },
      {
        id: 3,
        status: "rejected",
        rejected_at: "not-a-timestamp",
        rejection_direction: "company_rejected",
      },
      {
        id: 4,
        status: "in_process",
        rejected_at: "2026-07-03T10:00:00Z",
        rejection_direction: "company_rejected",
      },
    ]
    expect(mapHarvestApplicationsToCandidateStageOutcomes({ applications })).toEqual([])
  })

  test("fails closed when structured direction evidence conflicts", () => {
    expect(
      mapHarvestApplicationsToCandidateStageOutcomes(
        baseInput({
          directionEvidence: [{ application_id: 1001, direction: "candidate_withdrew" }],
        })
      )
    ).toEqual([])
  })

  test("accepts scalar rejection reason names but never infers direction from their prose", () => {
    expect(
      mapHarvestApplicationsToCandidateStageOutcomes(
        baseInput({
          applications: [
            {
              id: 1003,
              status: "rejected",
              rejected_at: "2026-07-03T10:00:00Z",
              rejection_reason_name: "Candidate withdrew",
            },
          ],
        })
      )
    ).toEqual([])
  })
})
