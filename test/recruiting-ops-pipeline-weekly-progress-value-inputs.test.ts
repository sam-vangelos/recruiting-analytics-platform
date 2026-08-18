import { beforeEach, describe, expect, test } from "vitest"

import { PII_FINGERPRINT_SALT_ENV } from "../lib/recruiting-ops/checksums"
import type { CandidateStageEventRow } from "../lib/recruiting-ops/delivery-source/candidate-stage-events"
import type { OfferLifecycleExportRow } from "../lib/recruiting-ops/delivery-source/offer-lifecycle-export"
import type { ScorecardSubmissionRow } from "../lib/recruiting-ops/delivery-source/scorecard-submission"
import {
  buildPipelineStagingValuePlanRanges,
  buildWeeklyProgressStagingValuePlanRanges,
  type SheetValueMatrix,
} from "../lib/recruiting-ops/delivery/pipeline-weekly-progress-value-inputs"
import { getStagingSheetContract } from "../lib/recruiting-ops/delivery/staging-sheet-contracts"
import {
  buildStagingSheetValuePlan,
  type SheetCellValue,
} from "../lib/recruiting-ops/delivery/staging-value-plan"

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
    candidate_id: "candidate-1",
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

function headerMatrix(rangeId: Parameters<typeof getStagingSheetContract>[0], rows: SheetValueMatrix = []): SheetValueMatrix {
  const contract = getStagingSheetContract(rangeId)
  return contract.headerRow === 1
    ? [contract.headers, ...rows]
    : [contract.groupedHeader?.headers ?? [], contract.headers, ...rows]
}

function progressMatrix(input: {
  rangeId: "weekly_progress_code_rl" | "weekly_progress_fde_pe" | "weekly_progress_brazil_colombia"
  weekColumn: number
  weekHeader?: string
  currentValues?: readonly number[]
}): SheetValueMatrix {
  const labels = getStagingSheetContract(input.rangeId).headers
  const width = input.weekColumn + 1
  const header = Array<null | string>(width).fill(null)
  header[input.weekColumn] = input.weekHeader ?? "Current week"
  return [
    header,
    ...labels.map((label, index) => {
      const row = Array<null | string | number>(width).fill(null)
      row[0] = label
      row[input.weekColumn] = input.currentValues?.[index] ?? 9
      return row
    }),
  ]
}

describe("pipeline and Weekly Progress bounded value-plan inputs", () => {
  beforeEach(() => {
    process.env[PII_FINGERPRINT_SALT_ENV] = "value-input-test-hmac-key"
  })

  test("fully replaces current candidate rows but appends after a differing manual job-week snapshot", () => {
    const candidateHeaders = getStagingSheetContract("pipeline_890_candidate").headers
    const old = [
      32, "Jul 3 - Jul 9", "890", "Old job", "old-app", "Old Candidate", "Old Recruiter",
      "Old stage", "Recruiter Phone Screen", "entered", "2026-07-04T00:00:00Z", "in_process",
      null, "Old stage", null, null, null,
    ]
    const jobHeaders = getStagingSheetContract("pipeline_890_job_week").headers
    const prior = Array(jobHeaders.length).fill(0)
    prior[0] = 31
    prior[1] = "Jun 26 - Jul 2"
    prior[2] = "890"
    const current = Array(jobHeaders.length).fill(0)
    current[0] = 32
    current[1] = "Jul 3 - Jul 9"
    current[2] = "890"

    const ranges = buildPipelineStagingValuePlanRanges({
      artifactKey: "pipeline_890",
      reportingWeekFriday: "2026-07-03",
      candidateEvents: [event()],
      candidateTarget: {
        sheetTitle: "Candidate Level Data - 10 July",
        currentMatrix: [candidateHeaders, old, old],
      },
      jobWeekTarget: {
        sheetTitle: "Job level pipeline",
        currentMatrix: headerMatrix("pipeline_890_job_week", [prior, current]),
      },
    })

    expect(ranges[0]).toMatchObject({
      rangeId: "pipeline_890_candidate",
      a1Range: "'Candidate Level Data - 10 July'!A2:Q3",
    })
    expect(ranges[0].currentValues).toHaveLength(2)
    expect(ranges[0].desiredValues[0]).toHaveLength(17)
    expect(ranges[0].desiredValues[1]).toEqual(Array(17).fill(null))
    expect(ranges[1]).toMatchObject({
      rangeId: "pipeline_890_job_week",
      a1Range: "'Job level pipeline'!A5:AC5",
    })
    expect(ranges[1].currentValues[0]).toEqual(Array(29).fill(null))

    expect(() =>
      buildStagingSheetValuePlan({
        artifactKey: "pipeline_890",
        runId: "pipeline_890_20260710",
        sourceGeneratedAt: "2026-07-10T12:00:00Z",
        structureHash: `sha256:${"a".repeat(64)}`,
        dataProvenance: "fixture",
        ranges,
      })
    ).not.toThrow()
  })

  test("deterministically appends the ordered two-req job-week block", () => {
    const candidateHeaders = getStagingSheetContract("pipeline_1026_1027_candidate").headers
    const jobHeaders = getStagingSheetContract("pipeline_1026_1027_job_week").headers
    const prior = Array(jobHeaders.length).fill(0)
    prior[0] = 31
    prior[1] = "Jun 26 - Jul 2"
    prior[2] = "1026"
    const ranges = buildPipelineStagingValuePlanRanges({
      artifactKey: "pipeline_1026_1027",
      reportingWeekFriday: "2026-07-03",
      candidateEvents: [],
      candidateTarget: {
        sheetTitle: "Candidate Level Data - 10 July",
        currentMatrix: [candidateHeaders],
      },
      jobWeekTarget: {
        sheetTitle: "Job Level Pipeline",
        currentMatrix: headerMatrix("pipeline_1026_1027_job_week", [prior]),
      },
    })
    expect(ranges[0]).toMatchObject({
      rangeId: "pipeline_1026_1027_candidate",
      a1Range: "'Candidate Level Data - 10 July'!A2:N2",
      currentValues: [Array(14).fill(null)],
      desiredValues: [Array(14).fill(null)],
    })
    expect(ranges[1]).toMatchObject({
      rangeId: "pipeline_1026_1027_job_week",
      a1Range: "'Job Level Pipeline'!A4:AF5",
    })
    expect(ranges[1].desiredValues.map((row) => row[2])).toEqual(["1026", "1027"])
  })

  test.each([
    ["pipeline_890", "pipeline_890_candidate", "pipeline_890_job_week", 717, "890", "'Job level pipeline'!A719:AC719"],
    ["pipeline_1026_1027", "pipeline_1026_1027_candidate", "pipeline_1026_1027_job_week", 1172, "1026", "'Job Level Pipeline'!A1174:AF1175"],
  ] as const)(
    "keeps %s value hydration aligned with the audited adjacent structural destination",
    (artifactKey, candidateId, jobWeekId, lastValueRowIndex, requisitionId, expectedRange) => {
      const candidateContract = getStagingSheetContract(candidateId)
      const jobContract = getStagingSheetContract(jobWeekId)
      const matrix = headerMatrix(jobWeekId).map((row) => [...row])
      while (matrix.length <= lastValueRowIndex) {
        matrix.push(Array(jobContract.headers.length).fill(null))
      }
      const historical = Array<SheetCellValue>(jobContract.headers.length).fill(null)
      historical[0] = 31
      historical[1] = "Jun 26 - Jul 2"
      historical[2] = requisitionId
      matrix[lastValueRowIndex] = historical

      const ranges = buildPipelineStagingValuePlanRanges({
        artifactKey,
        reportingWeekFriday: "2026-07-03",
        candidateEvents: [],
        candidateTarget: {
          sheetTitle: "Candidate Level Data - 10 July",
          currentMatrix: [candidateContract.headers],
        },
        jobWeekTarget: {
          sheetTitle: jobContract.sheetTitle,
          currentMatrix: matrix,
        },
      })

      expect(ranges[1].a1Range).toBe(expectedRange)
    }
  )

  test.each([
    ["pipeline_890", "pipeline_890_candidate", "pipeline_890_job_week", "'Candidate Level Data - 10 July'!A2:Q2", "'Job level pipeline'!A4:AC4"],
    ["pipeline_907", "pipeline_907_candidate", "pipeline_907_job_week", "'Candidate Level Data - 10 July'!A2:N2", "'Job level pipeline'!A4:AC4"],
    ["pipeline_1026_1027", "pipeline_1026_1027_candidate", "pipeline_1026_1027_job_week", "'Candidate Level Data - 10 July'!A2:N2", "'Job Level Pipeline'!A4:AF5"],
    ["pipeline_1118_1119", "pipeline_1118_1119_candidate", "pipeline_1118_1119_job_week", "'Candidate Level Data - 10 July'!A2:N2", "'Job level pipeline'!A4:AF5"],
  ] as const)("binds %s to exact contract ids and bounded ranges", (artifactKey, candidateId, jobWeekId, candidateA1, jobWeekA1) => {
    const candidateContract = getStagingSheetContract(candidateId)
    const jobWeekContract = getStagingSheetContract(jobWeekId)
    const historical = Array(jobWeekContract.headers.length).fill(null)
    historical[0] = 31
    historical[1] = "Jun 26 - Jul 2"
    historical[2] = jobWeekId === "pipeline_890_job_week"
      ? "890"
      : jobWeekId === "pipeline_907_job_week"
        ? "907"
        : jobWeekId === "pipeline_1026_1027_job_week"
          ? "1026"
          : "1118"
    const ranges = buildPipelineStagingValuePlanRanges({
      artifactKey,
      reportingWeekFriday: "2026-07-03",
      candidateEvents: [],
      candidateTarget: {
        sheetTitle: "Candidate Level Data - 10 July",
        currentMatrix: [candidateContract.headers],
      },
      jobWeekTarget: {
        sheetTitle: jobWeekContract.sheetTitle,
        currentMatrix: headerMatrix(jobWeekId, [historical]),
      },
    })
    expect(ranges.map((range) => range.rangeId)).toEqual([candidateId, jobWeekId])
    expect(ranges.map((range) => range.a1Range)).toEqual([candidateA1, jobWeekA1])
    expect(ranges[1].currentValues.every((row) => row.every((value) => value === null))).toBe(true)
  })

  test("accepts one predecessor-week rollover preimage but rejects older rows and bad titles", () => {
    const headers = getStagingSheetContract("pipeline_907_candidate").headers
    const base = {
      artifactKey: "pipeline_907" as const,
      reportingWeekFriday: "2026-07-03",
      candidateEvents: [event({ requisition_id: "907" })],
      jobWeekTarget: {
        sheetTitle: "Job level pipeline",
        currentMatrix: headerMatrix("pipeline_907_job_week"),
      },
    }
    expect(() =>
      buildPipelineStagingValuePlanRanges({
        ...base,
        candidateTarget: { sheetTitle: "Candidate Level Data - 10 July", currentMatrix: [headers, headers] },
      })
    ).toThrow("header row is ambiguous")
    const predecessorWeek = Array(headers.length).fill(null)
    predecessorWeek[1] = "Jun 26 - Jul 2"
    predecessorWeek[2] = "907"
    expect(
      buildPipelineStagingValuePlanRanges({
        ...base,
        candidateTarget: {
          sheetTitle: "Candidate Level Data - 10 July",
          currentMatrix: [headers, predecessorWeek],
        },
      })[0]
    ).toMatchObject({ currentValues: [predecessorWeek] })
    const wrongWeek = Array(headers.length).fill(null)
    wrongWeek[1] = "Jun 19 - Jun 25"
    wrongWeek[2] = "907"
    expect(() =>
      buildPipelineStagingValuePlanRanges({
        ...base,
        candidateTarget: { sheetTitle: "Candidate Level Data - 10 July", currentMatrix: [headers, wrongWeek] },
      })
    ).toThrow("non-current-or-predecessor-week")
    expect(() =>
      buildPipelineStagingValuePlanRanges({
        ...base,
        candidateTarget: { sheetTitle: "Candidate Level Data latest", currentMatrix: [headers] },
      })
    ).toThrow("normalized current-date")
  })

  test("accepts an unpadded cross-month candidate tab title", () => {
    const headers = getStagingSheetContract("pipeline_907_candidate").headers
    const ranges = buildPipelineStagingValuePlanRanges({
      artifactKey: "pipeline_907",
      reportingWeekFriday: "2026-07-31",
      candidateEvents: [],
      candidateTarget: {
        sheetTitle: "Candidate Level Data - 7 August",
        currentMatrix: [headers],
      },
      jobWeekTarget: {
        sheetTitle: "Job level pipeline",
        currentMatrix: headerMatrix("pipeline_907_job_week"),
      },
    })
    expect(ranges[0].a1Range).toBe("'Candidate Level Data - 7 August'!A2:N2")
  })

  test("rejects drift in either physical row of a grouped pipeline job header", () => {
    const candidateHeaders = getStagingSheetContract("pipeline_907_candidate").headers
    const goodJobMatrix = headerMatrix("pipeline_907_job_week").map((row) => [...row])
    const base = {
      artifactKey: "pipeline_907" as const,
      reportingWeekFriday: "2026-07-03",
      candidateEvents: [],
      candidateTarget: {
        sheetTitle: "Candidate Level Data - 10 July",
        currentMatrix: [candidateHeaders],
      },
      jobWeekTarget: {
        sheetTitle: "Job level pipeline",
        currentMatrix: goodJobMatrix,
      },
    }
    const groupedDrift = goodJobMatrix.map((row) => [...row])
    groupedDrift[0][5] = "Application Review changed"
    expect(() =>
      buildPipelineStagingValuePlanRanges({
        ...base,
        jobWeekTarget: { ...base.jobWeekTarget, currentMatrix: groupedDrift },
      })
    ).toThrow("grouped header contract drifted")

    const metricDrift = goodJobMatrix.map((row) => [...row])
    metricDrift[1][5] = "Application Review Enter"
    expect(() =>
      buildPipelineStagingValuePlanRanges({
        ...base,
        jobWeekTarget: { ...base.jobWeekTarget, currentMatrix: metricDrift },
      })
    ).toThrow("header contract drifted")
  })

  test("preserves duplicate, partial, and non-contiguous manual blocks and appends after them", () => {
    const candidateHeaders = getStagingSheetContract("pipeline_1026_1027_candidate").headers
    const jobHeaders = getStagingSheetContract("pipeline_1026_1027_job_week").headers
    const target = (req: string) => {
      const row = Array(jobHeaders.length).fill(0)
      row[0] = 31
      row[1] = "Jul 3 - Jul 9"
      row[2] = req
      return row
    }
    const input = (rows: SheetValueMatrix) => ({
      artifactKey: "pipeline_1026_1027" as const,
      reportingWeekFriday: "2026-07-03",
      candidateEvents: [],
      candidateTarget: {
        sheetTitle: "Candidate Level Data - 10 July",
        currentMatrix: [candidateHeaders],
      },
      jobWeekTarget: {
        sheetTitle: "Job Level Pipeline",
        currentMatrix: headerMatrix("pipeline_1026_1027_job_week", rows),
      },
    })
    expect(buildPipelineStagingValuePlanRanges(input([target("1026"), target("1026")]))[1].a1Range)
      .toBe("'Job Level Pipeline'!A5:AF6")
    expect(buildPipelineStagingValuePlanRanges(input([target("1026")]))[1].a1Range)
      .toBe("'Job Level Pipeline'!A4:AF5")
    expect(buildPipelineStagingValuePlanRanges(input([
        target("1026"),
        (() => {
          const historical = target("1026")
          historical[0] = 31
          historical[1] = "Jun 26 - Jul 2"
          return historical
        })(),
        target("1027"),
      ]))[1].a1Range).toBe("'Job Level Pipeline'!A6:AF7")
  })

  test("ignores recognized legacy annotations and repeated headers but fails on an unknown requisition", () => {
    const candidateHeaders = getStagingSheetContract("pipeline_907_candidate").headers
    const jobContract = getStagingSheetContract("pipeline_907_job_week")
    const annotation = Array(jobContract.headers.length).fill(null)
    annotation[0] = "09 June Data - Req 907"
    const repeatedHeader = [...jobContract.headers]
    const legacySnapshot = Array(jobContract.headers.length).fill(0)
    legacySnapshot[0] = 29
    legacySnapshot[1] = "Jul 3 - Jul 9"
    legacySnapshot[2] = "907"
    const base = {
      artifactKey: "pipeline_907" as const,
      reportingWeekFriday: "2026-07-03",
      candidateEvents: [],
      candidateTarget: {
        sheetTitle: "Candidate Level Data - 10 July",
        currentMatrix: [candidateHeaders],
      },
      jobWeekTarget: {
        sheetTitle: "Job level pipeline",
        currentMatrix: headerMatrix("pipeline_907_job_week", [
          annotation,
          repeatedHeader,
          legacySnapshot,
          legacySnapshot,
        ]),
      },
    }
    expect(buildPipelineStagingValuePlanRanges(base)[1].a1Range)
      .toBe("'Job level pipeline'!A7:AC7")

    const unknownReq = [...legacySnapshot]
    unknownReq[2] = "999"
    expect(() =>
      buildPipelineStagingValuePlanRanges({
        ...base,
        jobWeekTarget: {
          ...base.jobWeekTarget,
          currentMatrix: headerMatrix("pipeline_907_job_week", [unknownReq]),
        },
      })
    ).toThrow("unexpected requisition")
  })

  test.each([
    ["pipeline_890", "pipeline_890_candidate", "pipeline_890_job_week", ["890"]],
    ["pipeline_907", "pipeline_907_candidate", "pipeline_907_job_week", ["907"]],
    ["pipeline_1026_1027", "pipeline_1026_1027_candidate", "pipeline_1026_1027_job_week", ["1026", "1027"]],
    ["pipeline_1118_1119", "pipeline_1118_1119_candidate", "pipeline_1118_1119_job_week", ["1118", "1119"]],
  ] as const)("an identical %s retry no-ops both value ranges", (artifactKey, candidateId, jobWeekId, requisitionIds) => {
    const candidateHeaders = getStagingSheetContract(candidateId).headers
    const jobWeekContract = getStagingSheetContract(jobWeekId)
    const candidateEvents = requisitionIds.map((requisitionId, index) => event({
      event_key: `event-${requisitionId}`,
      source_stage_event_id: `stage-${requisitionId}`,
      application_id: `app-${requisitionId}`,
      candidate_id: `candidate-${requisitionId}`,
      requisition_id: requisitionId,
      job_name: `Role ${requisitionId}`,
      event_ts: `2026-07-0${index + 4}T12:00:00.000Z`,
    }))
    const desired = buildPipelineStagingValuePlanRanges({
      artifactKey,
      reportingWeekFriday: "2026-07-03",
      candidateEvents,
      candidateTarget: {
        sheetTitle: "Candidate Level Data - 10 July",
        currentMatrix: [candidateHeaders],
      },
      jobWeekTarget: {
        sheetTitle: jobWeekContract.sheetTitle,
        currentMatrix: headerMatrix(jobWeekId),
      },
    })
    const retainedManualRows = artifactKey === "pipeline_1118_1119"
      ? desired[1].desiredValues.map((row, index) => {
          const manual = [...row]
          manual[3] = index === 0 ? "Manual Brazil form" : "Manual Colombia form"
          manual[5] = 900 + index
          return manual
        })
      : []
    const first = buildPipelineStagingValuePlanRanges({
      artifactKey,
      reportingWeekFriday: "2026-07-03",
      candidateEvents,
      candidateTarget: {
        sheetTitle: "Candidate Level Data - 10 July",
        currentMatrix: [candidateHeaders],
      },
      jobWeekTarget: {
        sheetTitle: jobWeekContract.sheetTitle,
        currentMatrix: headerMatrix(jobWeekId, retainedManualRows),
      },
    })
    const rerun = buildPipelineStagingValuePlanRanges({
      artifactKey,
      reportingWeekFriday: "2026-07-03",
      candidateEvents,
      candidateTarget: {
        sheetTitle: "Candidate Level Data - 10 July",
        currentMatrix: [candidateHeaders, ...first[0].desiredValues],
      },
      jobWeekTarget: {
        sheetTitle: jobWeekContract.sheetTitle,
        currentMatrix: headerMatrix(jobWeekId, [...retainedManualRows, ...first[1].desiredValues]),
      },
    })
    const plan = buildStagingSheetValuePlan({
      artifactKey,
      runId: `${artifactKey}_retry`,
      sourceGeneratedAt: "2026-07-10T12:00:00Z",
      structureHash: `sha256:${"a".repeat(64)}`,
      dataProvenance: "fixture",
      ranges: rerun,
    })

    expect(plan.noOp).toBe(true)
    expect(plan.writes.every((write) => !write.changed)).toBe(true)
    if (artifactKey === "pipeline_1118_1119") {
      expect(first[1].a1Range).toBe("'Job level pipeline'!A5:AF6")
      expect(rerun[1]).toMatchObject({
        a1Range: "'Job level pipeline'!A5:AF6",
        currentValues: first[1].desiredValues,
        desiredValues: first[1].desiredValues,
      })
      expect(retainedManualRows.map((row) => [row[2], row[3], row[5]])).toEqual([
        ["1118", "Manual Brazil form", 900],
        ["1119", "Manual Colombia form", 901],
      ])
    }
  })

  test("locates the exact current-week value columns and stage blocks on all three progress tabs", () => {
    const offer = {
      offer_id: "offer-1",
      offer_status: "accepted",
      requisition_id: "890",
      created_at: "2026-07-05T00:00:00Z",
      resolved_at: "2026-07-08T00:00:00Z",
    } as OfferLifecycleExportRow
    const scorecard = {
      scorecard_id: "scorecard-1",
      requisition_id: "890",
      interview_name: "Recruiter Phone Screen",
      scheduled_interview_ended_at: "2026-07-07T00:00:00Z",
    } as ScorecardSubmissionRow
    const ranges = buildWeeklyProgressStagingValuePlanRanges({
      reportingWeekFriday: "2026-07-03",
      candidateEvents: [event({ event_type: "passed", core_stage: "Onsite Interview" })],
      offers: [offer],
      scorecards: [scorecard],
      targets: {
        code_rl: {
          sheetTitle: "FDL (Code + RL)",
          weekHeader: "03 Jul - 09 Jul",
          currentMatrix: progressMatrix({ rangeId: "weekly_progress_code_rl", weekColumn: 2, weekHeader: "03 Jul - 09 Jul" }),
        },
        fde_pe: {
          sheetTitle: "FDE/PE",
          weekHeader: "03 Jul - 09 Jul",
          currentMatrix: progressMatrix({ rangeId: "weekly_progress_fde_pe", weekColumn: 24, weekHeader: "03 Jul - 09 Jul" }),
        },
        brazil_colombia: {
          sheetTitle: "FDL (Brazil + Colombia)",
          weekHeader: "03 Jul - 09 Jul",
          currentMatrix: progressMatrix({ rangeId: "weekly_progress_brazil_colombia", weekColumn: 3, weekHeader: "03 Jul - 09 Jul" }),
        },
      },
    })
    expect(ranges.map((range) => [range.rangeId, range.a1Range])).toEqual([
      ["weekly_progress_code_rl", "'FDL (Code + RL)'!C2:C8"],
      ["weekly_progress_fde_pe", "'FDE/PE'!Y2:Y7"],
      ["weekly_progress_brazil_colombia", "'FDL (Brazil + Colombia)'!D2:D8"],
    ])
    expect(ranges[0].currentValues).toEqual(Array.from({ length: 7 }, () => [9]))
    expect(ranges[1].desiredValues).toEqual([[1], [1], [1], [0], [0], [1]])
    expect(ranges[2].desiredValues).toEqual(Array.from({ length: 7 }, () => [0]))
    expect(() =>
      buildStagingSheetValuePlan({
        artifactKey: "weekly_progress",
        runId: "weekly_progress_20260710",
        sourceGeneratedAt: "2026-07-10T12:00:00Z",
        structureHash: `sha256:${"b".repeat(64)}`,
        dataProvenance: "fixture",
        ranges,
      })
    ).not.toThrow()
  })

  test("locates the equivalent month-first FDE/PE week header retained by the manual sheet", () => {
    const code = progressMatrix({
      rangeId: "weekly_progress_code_rl",
      weekColumn: 2,
      weekHeader: "03 Jul - 09 Jul",
    })
    const fde = progressMatrix({
      rangeId: "weekly_progress_fde_pe",
      weekColumn: 24,
      weekHeader: "Jul 3 - Jul 9",
    })
    const brazil = progressMatrix({
      rangeId: "weekly_progress_brazil_colombia",
      weekColumn: 3,
      weekHeader: "03 Jul - 09 Jul",
    })

    const ranges = buildWeeklyProgressStagingValuePlanRanges({
      reportingWeekFriday: "2026-07-03",
      candidateEvents: [],
      offers: [],
      scorecards: [],
      targets: {
        code_rl: {
          sheetTitle: "FDL (Code + RL)",
          weekHeader: "03 Jul - 09 Jul",
          currentMatrix: code,
        },
        fde_pe: {
          sheetTitle: "FDE/PE",
          weekHeader: "03 Jul - 09 Jul",
          currentMatrix: fde,
        },
        brazil_colombia: {
          sheetTitle: "FDL (Brazil + Colombia)",
          weekHeader: "03 Jul - 09 Jul",
          currentMatrix: brazil,
        },
      },
    })

    expect(ranges.find((range) => range.rangeId === "weekly_progress_fde_pe")?.a1Range).toBe(
      "'FDE/PE'!Y2:Y7"
    )
  })

  test("rejects ambiguous Weekly Progress week headers and stage rows", () => {
    const good = progressMatrix({ rangeId: "weekly_progress_code_rl", weekColumn: 2, weekHeader: "03 Jul - 09 Jul" })
    const targets = {
      code_rl: {
        sheetTitle: "FDL (Code + RL)",
        weekHeader: "03 Jul - 09 Jul",
        currentMatrix: good,
      },
      fde_pe: {
        sheetTitle: "FDE/PE",
        weekHeader: "03 Jul - 09 Jul",
        currentMatrix: progressMatrix({ rangeId: "weekly_progress_fde_pe", weekColumn: 24, weekHeader: "03 Jul - 09 Jul" }),
      },
      brazil_colombia: {
        sheetTitle: "FDL (Brazil + Colombia)",
        weekHeader: "03 Jul - 09 Jul",
        currentMatrix: progressMatrix({ rangeId: "weekly_progress_brazil_colombia", weekColumn: 3, weekHeader: "03 Jul - 09 Jul" }),
      },
    }
    const duplicateHeader = good.map((row) => [...row])
    duplicateHeader[0][1] = "03 Jul - 09 Jul"
    expect(() =>
      buildWeeklyProgressStagingValuePlanRanges({
        reportingWeekFriday: "2026-07-03",
        candidateEvents: [],
        offers: [],
        scorecards: [],
        targets: { ...targets, code_rl: { ...targets.code_rl, currentMatrix: duplicateHeader } },
      })
    ).toThrow("missing or ambiguous")
    const duplicateRow = [...good, [...good[1]]]
    expect(() =>
      buildWeeklyProgressStagingValuePlanRanges({
        reportingWeekFriday: "2026-07-03",
        candidateEvents: [],
        offers: [],
        scorecards: [],
        targets: { ...targets, code_rl: { ...targets.code_rl, currentMatrix: duplicateRow } },
      })
    ).toThrow("stage row")
    const wrongWeek = progressMatrix({
      rangeId: "weekly_progress_code_rl",
      weekColumn: 2,
      weekHeader: "26 Jun - 02 Jul",
    })
    expect(() =>
      buildWeeklyProgressStagingValuePlanRanges({
        reportingWeekFriday: "2026-07-03",
        candidateEvents: [],
        offers: [],
        scorecards: [],
        targets: {
          ...targets,
          code_rl: {
            ...targets.code_rl,
            weekHeader: "26 Jun - 02 Jul",
            currentMatrix: wrongWeek,
          },
        },
      })
    ).toThrow("requested Fri-Thu")
  })
})
