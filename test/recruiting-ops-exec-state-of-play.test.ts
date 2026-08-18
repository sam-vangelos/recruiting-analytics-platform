import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { buildGovernedFunnelMap } from "../lib/recruiting-ops/exec-definitions"
import { emptyExecStateSources, type HarvestExecStateSources } from "../lib/recruiting-ops/extractors/greenhouse-exec-read-boundary"
import {
  collectEngagedApplicationIds,
  collectExecCandidateIds,
  deriveExecState,
  execStateOfPlayModuleDefinition,
  runExecStateOfPlayModule,
} from "../lib/recruiting-ops/modules/exec-state-of-play"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "recops-e01-"))
  roots.push(root)
  return root
}

const NOW_MS = Date.parse("2026-07-06T12:00:00.000Z")
const NO_GOVERNED = buildGovernedFunnelMap([])
const ROSTER = [{ recruiterName: "Kavya Menon", teamId: "team_a", teamName: "Team A", hodName: "HOD" }]

function daysAgoIso(days: number): string {
  return new Date(NOW_MS - days * 86_400_000).toISOString()
}

/**
 * Fixture org: two open jobs.
 *  - job 1 "Senior Engineer" (req 101): owner Kavya (roster), 2 seats, one
 *    onsite candidate + one application-review candidate + one unknown-stage
 *    candidate; a complete scorecard 3 days ago (RPS kit) and one 10 days ago;
 *    one awaiting-feedback interview; a stage advance 2 days ago.
 *  - job 2 "General Pool - ICLR" (req 102): pool, no owner, one sourced candidate.
 * Offers: one accepted 5 days ago on CLOSED job 9 (candidate 900), one accepted
 * 30 days ago on job 1 (candidate 901).
 */
function fixtureSources(): HarvestExecStateSources {
  return {
    ...emptyExecStateSources(),
    jobs: [
      { id: 1, requisition_id: "101", name: "Senior Engineer", status: "open", opened_at: daysAgoIso(40), department_id: 10 },
      { id: 2, requisition_id: "102", name: "General Pool - ICLR", status: "open", opened_at: daysAgoIso(300), department_id: 10 },
    ],
    offerJobs: [{ id: 9, requisition_id: "900", name: "Closed Architect", status: "closed", department_id: 11 }],
    departments: [
      { id: 10, name: "Engineering" },
      { id: 11, name: "Architecture" },
    ],
    openings: [
      { id: 51, job_id: 1, open: true },
      { id: 52, job_id: 1, open: true },
      { id: 53, job_id: 2, open: true },
      { id: 54, job_id: 1, open: false },
    ],
    jobOwners: [
      { id: 71, job_id: 1, user_id: 501, type: "recruiter", responsible: true },
      { id: 72, job_id: 1, user_id: 502, type: "sourcer" },
    ],
    users: [
      { id: 501, first_name: "Kavya", last_name: "Menon" },
      { id: 502, first_name: "Some", last_name: "Sourcer" },
    ],
    applications: [
      { id: 1001, job_id: 1, candidate_id: 9001, status: "in_process", stage_name: "Onsite Interview" },
      { id: 1002, job_id: 1, candidate_id: 9002, status: "in_process", stage_name: "Application Review" },
      { id: 1003, job_id: 1, candidate_id: 9003, status: "in_process", stage_name: "Vibe Alignment Circle" },
      { id: 1005, job_id: 1, candidate_id: 9005, status: "in_process", stage_name: "Recruiter Phone Screen" },
      { id: 1004, job_id: 2, candidate_id: 9004, status: "in_process", stage_name: "Sourced" },
    ],
    jobInterviewStages: [
      { id: 301, job_id: 1, name: "Recruiter Phone Screen" },
      { id: 302, job_id: 1, name: "Onsite Interview" },
    ],
    jobInterviews: [
      { id: 401, job_id: 1, job_interview_stage_id: 301, name: "RPS" },
      { id: 402, job_id: 1, job_interview_stage_id: 302, name: "Panel" },
    ],
    interviewKits: [
      { id: 601, job_id: 1, job_interview_id: 401 },
      { id: 602, job_id: 1, job_interview_id: 402 },
    ],
    scorecards: [
      { id: 801, application_id: 1001, interview_kit_id: 601, status: "complete", interviewed_at: daysAgoIso(3), submitted_at: daysAgoIso(2) },
      { id: 802, application_id: 1001, interview_kit_id: 602, status: "complete", interviewed_at: daysAgoIso(10), submitted_at: daysAgoIso(9) },
      { id: 803, application_id: 1001, interview_kit_id: 601, status: "draft", interviewed_at: daysAgoIso(1) },
      { id: 804, application_id: 7777, interview_kit_id: 601, status: "complete", interviewed_at: daysAgoIso(2) },
    ],
    awaitingFeedbackInterviews: [{ id: 900, job_id: 1, application_id: 1001, status: "awaiting_feedback" }],
    applicationStages: [
      { id: 5002, application_id: 1001, job_interview_stage_id: 302, entered_at: daysAgoIso(2), current: true },
      { id: 2002, application_id: 1002, job_interview_stage_id: 301, entered_at: null, current: false },
    ],
    offers: [
      { id: 3001, job_id: 9, candidate_id: 900, status: "Accepted", resolved_at: daysAgoIso(5), starts_on: "2026-08-01" },
      { id: 3002, job_id: 1, candidate_id: 901, status: "Accepted", resolved_at: daysAgoIso(30) },
    ],
  }
}

const CANDIDATE_NAMES = new Map([
  ["9001", "Ada Lovelace"],
  ["900", "Grace Hopper"],
  ["901", "Katherine Johnson"],
])

/**
 * Default engaged stage histories matching the fixture: application 1001
 * entered Onsite 2 days ago (current) after RPS 20 days ago; application 1005
 * entered RPS 25 days ago and is still there.
 */
function fixtureStageHistories() {
  return [
    { id: 5001, application_id: 1001, job_interview_stage_id: 301, entered_at: daysAgoIso(20), exited_at: daysAgoIso(2), current: false },
    { id: 5002, application_id: 1001, job_interview_stage_id: 302, entered_at: daysAgoIso(2), exited_at: null, current: true },
    { id: 5003, application_id: 1005, job_interview_stage_id: 301, entered_at: daysAgoIso(25), exited_at: null, current: true },
  ]
}

function derive(overrides: Partial<Parameters<typeof deriveExecState>[0]> = {}) {
  return deriveExecState({
    sources: fixtureSources(),
    roster: ROSTER,
    governedFunnel: NO_GOVERNED,
    candidateNameById: CANDIDATE_NAMES,
    engagedStageHistories: fixtureStageHistories(),
    nowMs: NOW_MS,
    pullDiagnostics: [],
    ...overrides,
  })
}

function deriveFdeStageActivity(
  applicationStages: HarvestExecStateSources["applicationStages"],
  extraStages: HarvestExecStateSources["jobInterviewStages"] = []
) {
  const sources = fixtureSources()
  return derive({
    sources: {
      ...sources,
      jobs: sources.jobs.map((job) => (String(job.id) === "1" ? { ...job, requisition_id: "907" } : job)),
      scorecards: [],
      applicationStages,
      jobInterviewStages: [...sources.jobInterviewStages, ...extraStages],
    },
  })
}

function fdeStages(bundle: ReturnType<typeof derive>["bundle"]) {
  const section = bundle.eltFacts.sections.find((candidate) => candidate.title === "FDE + PE")!
  return { section, byLabel: new Map(section.stages.map((stage) => [stage.label, stage])) }
}

describe("module definition", () => {
  test("binds E01 to structured_hiring_status with the snapshot deliverable", () => {
    expect(execStateOfPlayModuleDefinition).toEqual({
      moduleId: "exec-state-of-play",
      workflowId: "E01",
      capabilityId: "structured_hiring_status",
      title: "E01 exec state-of-play",
      sourceIds: ["greenhouse"],
      queryIds: [],
      legacyArtifactIds: [],
      outputContractIds: ["exec_state_of_play_snapshot"],
    })
  })
})

describe("collectExecCandidateIds", () => {
  test("collects finalists on open reqs plus offer candidates — never unclassified stages", () => {
    const ids = collectExecCandidateIds(fixtureSources(), NO_GOVERNED).sort()
    // 9001 (Onsite finalist), 900 + 901 (offer candidates). NOT 9003 (unknown stage), NOT 9002/9004 (early).
    expect(ids).toEqual(["900", "9001", "901"])
  })
})

describe("deriveExecState", () => {
  test("per-req shape: seats, funnel split, finalists, owner, health with reason", () => {
    const { bundle } = derive()
    const senior = bundle.rows.find((row) => row.req_id === 101)!
    expect(senior.seats).toBe(2) // the closed opening does not count
    expect(senior.owner).toBe("Kavya Menon")
    expect(senior.owner_kind).toBe("recruiter") // recruiter wins over sourcer
    expect(senior.owner_on_roster).toBe(true)
    expect(senior.engaged_depth).toBe(2) // onsite + RPS candidates
    expect(senior.application_pile).toBe(1)
    expect(senior.unclassified_count).toBe(1) // Vibe Alignment Circle
    expect(senior.finalists).toHaveLength(1)
    expect(senior.finalists[0]).toMatchObject({ name: "Ada Lovelace", stage: "Onsite Interview" })
    expect(senior.finalists[0].url).toContain("/people/9001")
    expect(senior.health_reason).toBeTruthy()
    expect(senior.conducted_last7).toBe(1) // complete scorecard 3d ago; draft + off-scope excluded
    expect(senior.conducted_prior7).toBe(1) // complete scorecard 10d ago
    expect(senior.pending_writeups).toBe(1)
    expect(senior.advanced_last7).toBe(1) // onsite entry 2d ago
    expect(senior.momentum).toBe("moving")
    // 2 engaged candidates for 2 seats with conducted + advances — green with a data-bearing reason.
    expect(senior.health).toBe("green")
    expect(senior.health_rule).toBe("active_pipeline")
    expect(senior.funnel.find((cell) => cell.stage === "Recruiter Phone Screen")?.count).toBe(1)
    expect(senior.offers_accepted_12wk).toBe(1) // the job-1 offer
  })

  test("unclassified stages never count as finalists — the 159-finalists regression", () => {
    const sources = fixtureSources()
    // Blow up the unknown-stage population; finalists must not move.
    const flood = Array.from({ length: 150 }, (_, index) => ({
      id: 5000 + index,
      job_id: 1,
      candidate_id: 20000 + index,
      status: "in_process",
      stage_name: "Other",
    }))
    const { bundle } = derive({ sources: { ...sources, applications: [...sources.applications, ...flood] } })
    const senior = bundle.rows.find((row) => row.req_id === 101)!
    expect(senior.finalists).toHaveLength(1)
    expect(senior.unclassified_count).toBe(151)
  })

  test("governed funnel mapping overrides the heuristic and emits no heuristic gap for that label", () => {
    const governed = buildGovernedFunnelMap([{ stageLabel: "Vibe Alignment Circle", funnelStage: "Hiring Manager Review" }])
    const { bundle, sourceGaps } = derive({ governedFunnel: governed })
    const senior = bundle.rows.find((row) => row.req_id === 101)!
    expect(senior.unclassified_count).toBe(0)
    expect(senior.engaged_depth).toBe(3)
    expect(sourceGaps.some((gap) => gap.reason.includes("Vibe Alignment Circle") && gap.reason.includes("could not be classified"))).toBe(false)
  })

  test("pools are segregated: classified, gap-emitted, excluded from role rollups", () => {
    const { bundle, sourceGaps } = derive()
    const pool = bundle.rows.find((row) => row.req_id === 102)!
    expect(pool.req_class).toBe("pool")
    expect(bundle.rollup.open_roles).toBe(1)
    expect(bundle.rollup.pools_campaigns_templates).toBe(1)
    expect(bundle.rollup.seats).toBe(2) // pool's seat not counted
    expect(sourceGaps.some((gap) => gap.field === "req_class" && gap.reason.includes("General Pool - ICLR"))).toBe(true)
    // The pool has no owner but does NOT emit an unowned-role gap (it is not a role).
    expect(sourceGaps.some((gap) => gap.field === "owner" && gap.reason.includes("General Pool"))).toBe(false)
  })

  test("hires include closed-job offers with enrichment and week bucketing", () => {
    const { bundle } = derive()
    expect(bundle.hires).toHaveLength(2)
    const closedJobHire = bundle.hires.find((hire) => hire.candidate === "Grace Hopper")!
    expect(closedJobHire.role).toBe("Closed Architect")
    expect(closedJobHire.department).toBe("Architecture")
    expect(closedJobHire.starts_on).toBe("2026-08-01")
    expect(closedJobHire.week_friday).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(bundle.rollup.offers_accepted_12wk).toBe(2)
  })

  test("unknown stage labels and heuristic resolutions emit one counted gap per distinct label", () => {
    const { sourceGaps } = derive()
    const unclassifiedGaps = sourceGaps.filter((gap) => gap.reason.includes("could not be classified"))
    expect(unclassifiedGaps).toHaveLength(1) // "Vibe Alignment Circle", once, despite occurring on a row + counts
    expect(unclassifiedGaps[0].reason).toContain("Vibe Alignment Circle")
    const heuristicGaps = sourceGaps.filter((gap) => gap.reason.includes("keyword heuristic"))
    expect(heuristicGaps.length).toBeGreaterThan(0) // Onsite Interview etc. resolved heuristically with no governed rows
    expect(heuristicGaps.every((gap) => !gap.blocksCutover)).toBe(true)
  })

  test("suspected truncation becomes a BLOCKING gap and the run reports it", () => {
    const { sourceGaps } = derive({
      pullDiagnostics: [{ source: "/application_stages?updated_at", records: 120000, truncationSuspected: true }],
    })
    const truncationGap = sourceGaps.find((gap) => gap.field === "pull_completeness")!
    expect(truncationGap.blocksCutover).toBe(true)
    expect(truncationGap.reason).toContain("/application_stages")
  })

  test("off-roster owners emit a gap", () => {
    const { sourceGaps } = derive({ roster: [{ recruiterName: "Somebody Else", teamId: "t", teamName: "T", hodName: "H" }] })
    expect(sourceGaps.some((gap) => gap.reason.includes('"Kavya Menon" is not on the active governed roster'))).toBe(true)
  })

  test("rollup momentum distribution counts every row", () => {
    const { bundle } = derive()
    const total = Object.values(bundle.rollup.momentum).reduce((sum, count) => sum + count, 0)
    expect(total).toBe(bundle.rows.length)
  })
})

describe("eltFacts", () => {
  // NOW_MS is Monday Jul 6 -> ELT reporting week = last complete week, Fri Jun 26 - Thu Jul 2.
  test("reporting week is the last complete Fri-Thu week on a non-Thursday", () => {
    const { bundle } = derive()
    expect(bundle.eltFacts.weekLabel).toBe("Jun 26, 2026 - Jul 2, 2026")
    expect(bundle.eltFacts.weekShort).toBe("Jun 26 - Jul 2")
  })

  test("generated on Thursday, the reporting week is the week ending that day", () => {
    const thursday = Date.parse("2026-07-02T18:00:00.000Z")
    const { bundle } = derive({ nowMs: thursday })
    expect(bundle.eltFacts.weekLabel).toBe("Jun 26, 2026 - Jul 2, 2026")
  })

  test("a declared backfill week rewindows the ELT block while generatedAt stays the live clock", () => {
    // Fixture offers: Grace Hopper accepted daysAgo(5) = Jul 1 (inside the
    // derived Jun 26 - Jul 2 week); Katherine Johnson accepted daysAgo(30) = Jun 6.
    // Declaring the Jun 5 - Jun 11 week must swap which hire the block carries
    // and restamp the labels, without touching the snapshot timestamp.
    const { bundle } = derive({ eltBackfillWeekFriday: "2026-06-05" })
    expect(bundle.eltFacts.weekLabel).toBe("Jun 5, 2026 - Jun 11, 2026")
    expect(bundle.eltFacts.weekShort).toBe("Jun 5 - Jun 11")
    expect(bundle.eltFacts.hires).toHaveLength(1)
    expect(bundle.eltFacts.hires[0]).toMatchObject({ candidate: "Katherine Johnson" })
    expect(bundle.eltFacts.generatedAt).toBe(new Date(NOW_MS).toISOString())
  })

  test("an absent declared week derives the ELT week from the clock exactly as before", () => {
    const declared = derive({ eltBackfillWeekFriday: undefined })
    const derived = derive()
    expect(declared.bundle.eltFacts).toEqual(derived.bundle.eltFacts)
  })

  test.each([
    ["a Saturday", "2026-06-06", "not a valid UTC Friday"],
    ["a malformed date", "June 5 2026", "not a valid UTC Friday"],
    ["the derived current week itself", "2026-06-26", "not older than the governed current reporting week"],
    ["a week newer than the derived one", "2026-07-03", "not older than the governed current reporting week"],
  ])("refuses a declared backfill week that is %s", (_case, declared, message) => {
    expect(() => derive({ eltBackfillWeekFriday: declared })).toThrow(message)
  })

  test("hires block is org-wide with enrichment, scoped to the reporting week", () => {
    // Offer on CLOSED job 9 accepted daysAgo(5) = Jul 1 -> inside Jun 26-Jul 2.
    const { bundle } = derive()
    expect(bundle.eltFacts.hires).toHaveLength(1)
    expect(bundle.eltFacts.hires[0]).toMatchObject({ candidate: "Grace Hopper", role: "Closed Architect", department: "Architecture" })
  })

  test("sections count stage entries and credit a true stage-jump pass to its origin", () => {
    const { bundle } = deriveFdeStageActivity([
      { id: 2101, application_id: 1001, job_interview_stage_id: 301, entered_at: daysAgoIso(9), exited_at: daysAgoIso(8) },
      { id: 2102, application_id: 1001, job_interview_stage_id: 302, entered_at: daysAgoIso(8), current: true },
    ])
    const { section: fde, byLabel } = fdeStages(bundle)
    expect(fde.subs).toEqual(["PE", "FDE"])
    const rps = byLabel.get("RPS")!
    expect(rps.conducted).toBe(1)
    expect(rps.passed).toBe(1)
    expect(rps.subs).toEqual([
      { label: "PE", conducted: 0, passed: 0 },
      { label: "FDE", conducted: 1, passed: 1 },
    ])
    expect(byLabel.get("Assessment")?.passed).toBe(0)
    expect(byLabel.get("Onsite Interviews")).toMatchObject({ conducted: 1, passed: 0 })
    expect(bundle.eltFacts.hiresNote).toBe(
      "For Jun 26 - Jul 2, accepted offers are org-wide; candidates are counted when they enter each stage, and passes are credited to the stage they exit."
    )
    // Sections with no focus-req jobs stay all-zero, never undefined.
    const brazil = bundle.eltFacts.sections.find((section) => section.title === "FDL (Brazil + Colombia)")!
    expect(brazil.stages.every((stage) => stage.conducted === 0 && stage.passed === 0)).toBe(true)
  })

  test.each([
    {
      name: "a regression",
      applicationStages: [
        { id: 2201, application_id: 1001, job_interview_stage_id: 302, entered_at: daysAgoIso(9), exited_at: daysAgoIso(8) },
        { id: 2202, application_id: 1001, job_interview_stage_id: 303, entered_at: daysAgoIso(8), current: true },
      ],
      extraStages: [{ id: 303, job_id: 1, name: "Skills Assessment" }],
    },
    {
      name: "a same-stage substep",
      applicationStages: [
        { id: 2301, application_id: 1001, job_interview_stage_id: 302, entered_at: daysAgoIso(9), exited_at: daysAgoIso(8) },
        { id: 2302, application_id: 1001, job_interview_stage_id: 304, entered_at: daysAgoIso(8), current: true },
      ],
      extraStages: [{ id: 304, job_id: 1, name: "Final Panel" }],
    },
    {
      name: "a stage with no exit",
      applicationStages: [
        { id: 2401, application_id: 1001, job_interview_stage_id: 301, entered_at: daysAgoIso(9), exited_at: null },
        { id: 2402, application_id: 1001, job_interview_stage_id: 302, entered_at: daysAgoIso(8), current: true },
      ],
      extraStages: [],
    },
    {
      name: "an unresolved intermediate stage",
      applicationStages: [
        { id: 2451, application_id: 1001, job_interview_stage_id: 301, entered_at: daysAgoIso(10), exited_at: daysAgoIso(9) },
        { id: 2452, application_id: 1001, job_interview_stage_id: 999, entered_at: daysAgoIso(9), exited_at: daysAgoIso(8) },
        { id: 2453, application_id: 1001, job_interview_stage_id: 302, entered_at: daysAgoIso(8), current: true },
      ],
      extraStages: [],
    },
  ])("$name does not count as a pass", ({ applicationStages, extraStages }) => {
    const { bundle } = deriveFdeStageActivity(applicationStages, extraStages)
    expect(fdeStages(bundle).section.stages.every((stage) => stage.passed === 0)).toBe(true)
  })

  test("conducted counts each application once per core stage per week", () => {
    const { bundle } = deriveFdeStageActivity([
      { id: 2501, application_id: 1001, job_interview_stage_id: 301, entered_at: daysAgoIso(9), exited_at: daysAgoIso(8) },
      { id: 2502, application_id: 1001, job_interview_stage_id: 301, entered_at: daysAgoIso(8), current: true },
    ])
    const rps = fdeStages(bundle).byLabel.get("RPS")!
    expect(rps).toMatchObject({ conducted: 1, passed: 0 })
    expect(rps.subs).toContainEqual({ label: "FDE", conducted: 1, passed: 0 })
  })

  test("a cross-week transition counts the entry and exit in their own weeks", () => {
    const { bundle } = deriveFdeStageActivity([
      { id: 2601, application_id: 1001, job_interview_stage_id: 301, entered_at: daysAgoIso(4), exited_at: daysAgoIso(3) },
      { id: 2602, application_id: 1001, job_interview_stage_id: 302, entered_at: daysAgoIso(2), current: true },
    ])
    const elt = fdeStages(bundle).byLabel
    expect(elt.get("RPS")).toMatchObject({ conducted: 1, passed: 0 })
    expect(elt.get("Onsite Interviews")).toMatchObject({ conducted: 0, passed: 0 })

    const senior = bundle.rows.find((row) => row.req_id === 907)!
    const current = new Map(senior.week_stage_activity.map((stage) => [stage.stage, stage]))
    expect(current.get("Recruiter Phone Screen")).toMatchObject({ conducted: 0, passed: 1 })
    expect(current.get("Onsite Interview")).toMatchObject({ conducted: 1, passed: 0 })
  })

  test("stage rows are resolved once before reporting-week grouping", () => {
    const { sourceGaps } = deriveFdeStageActivity(
      [{ id: 2701, application_id: 1001, job_interview_stage_id: 305, entered_at: daysAgoIso(8), current: true }],
      [{ id: 305, job_id: 1, name: "Portfolio Assessment" }]
    )
    const gap = sourceGaps.find((candidate) => candidate.reason.includes('"Portfolio Assessment"'))!
    expect(gap.reason).toContain("(1 occurrence(s))")
  })

  test("QTD counts section offers from the reporting quarter with names", () => {
    const sources = fixtureSources()
    const retargeted = {
      ...sources,
      offerJobs: [{ id: 9, requisition_id: "1026", name: "Research Engineer, Code - US", status: "closed", department_id: 11 }],
      // accepted daysAgo(30) = Jun 6 -> inside Q2 (reporting week Jun 26 is Q2). daysAgo(5) = Jul 1 -> also Q2 + in week.
      offers: [
        { id: 3001, job_id: 9, candidate_id: 900, status: "Accepted", resolved_at: daysAgoIso(5), starts_on: "2026-08-01" },
        { id: 3002, job_id: 9, candidate_id: 901, status: "Accepted", resolved_at: daysAgoIso(30) },
      ],
    }
    const { bundle } = derive({ sources: retargeted })
    const codeSection = bundle.eltFacts.sections.find((section) => section.title === "FDL Code + RL (U.S.)")!
    expect(codeSection.qtdOffers.total).toBe(2)
    expect(codeSection.qtdOffers.subs).toEqual([
      { label: "Code", count: 2 },
      { label: "RL", count: 0 },
    ])
    expect(codeSection.qtdOffers.names.sort()).toEqual(["Grace Hopper", "Katherine Johnson"])
    expect(codeSection.weekOffers.total).toBe(1)
  })
})

describe("runExecStateOfPlayModule", () => {
  test("produces a succeeded run with artifacts, capability stamped, names surviving in the JSON artifact", async () => {
    const result = await runExecStateOfPlayModule({
      rootDir: tempRoot(),
      startedAt: "2026-07-06T12:00:00.000Z",
      generatedAt: "2026-07-06T12:00:05.000Z",
      sources: fixtureSources(),
      roster: ROSTER,
      governedFunnel: NO_GOVERNED,
      candidateNameById: CANDIDATE_NAMES,
      engagedStageHistories: fixtureStageHistories(),
      nowMs: NOW_MS,
      pullDiagnostics: [],
    })
    expect(result.run.status).toBe("succeeded")
    expect(result.run.capabilityId).toBe("structured_hiring_status")
    expect(result.normalizedRows).toHaveLength(2)
    expect(result.artifacts).toHaveLength(2)
    for (const artifact of result.artifacts) expect(artifact.capabilityId).toBe("structured_hiring_status")
    for (const gap of result.sourceGaps) expect(gap.capabilityId).toBe("structured_hiring_status")

    const jsonArtifact = result.artifacts.find((artifact) => artifact.format === "json")!
    const payload = JSON.parse(readFileSync(jsonArtifact.path, "utf8"))
    const senior = payload.rows.find((row: { req_id: number }) => row.req_id === 101)
    expect(senior.finalists[0].name).toBe("Ada Lovelace")
    // The artifact's public summary (what persists to Supabase) must carry counts only.
    expect(JSON.stringify(jsonArtifact.publicSummary)).not.toContain("Ada")
    expect(JSON.stringify(result.run.publicSummary)).not.toContain("Ada")
  })

  test("a truncation-flagged pull blocks the run", async () => {
    const result = await runExecStateOfPlayModule({
      rootDir: tempRoot(),
      startedAt: "2026-07-06T12:00:00.000Z",
      generatedAt: "2026-07-06T12:00:05.000Z",
      sources: fixtureSources(),
      roster: ROSTER,
      governedFunnel: NO_GOVERNED,
      candidateNameById: CANDIDATE_NAMES,
      engagedStageHistories: fixtureStageHistories(),
      nowMs: NOW_MS,
      pullDiagnostics: [{ source: "/offers?status=Accepted&resolved_at", records: 5000, truncationSuspected: true }],
    })
    expect(result.run.status).toBe("blocked")
  })
})

// ---------------------------------------------------------------------------
// Content-contract emits (§4): stage-history facts, 30d signals, tiers,
// attention, movement_14d, and the emit order the page renders verbatim.

describe("collectEngagedApplicationIds", () => {
  test("collects exactly the classified engaged applications on open reqs", () => {
    const ids = collectEngagedApplicationIds(fixtureSources(), NO_GOVERNED).sort()
    // 1001 (Onsite) + 1005 (RPS). NOT 1002 (review), NOT 1003 (unclassified), NOT 1004 (pool req is open but Sourced = order 0).
    expect(ids).toEqual(["1001", "1005"])
  })
})

describe("deriveExecState — tier + history emits", () => {
  test("stage histories feed last_advance_at, finalist in_stage_days, and funnel ages", () => {
    const { bundle } = derive()
    const senior = bundle.rows.find((row) => row.req_id === 101)!
    expect(senior.last_advance_at).toBe(daysAgoIso(2))
    expect(senior.finalists[0].in_stage_days).toBe(2)
    const rps = senior.funnel.find((cell) => cell.stage === "Recruiter Phone Screen")!
    expect(rps).toMatchObject({ count: 1, oldest_days: 25, median_days: 25 })
    const onsite = senior.funnel.find((cell) => cell.stage === "Onsite Interview")!
    expect(onsite).toMatchObject({ count: 1, oldest_days: 2 })
    // Pre-screen buckets never carry ages.
    expect(senior.funnel.find((cell) => cell.stage === "Application Review")).toMatchObject({
      oldest_days: null,
      median_days: null,
    })
  })

  test("30-day signals widen the 14-day ones without replacing them", () => {
    const { bundle } = derive()
    const senior = bundle.rows.find((row) => row.req_id === 101)!
    expect(senior.conducted_last30).toBe(2) // scorecards 3d + 10d; draft + off-scope excluded
    expect(senior.advanced_last30).toBe(1) // onsite entry 2d ago
    expect(senior.added_last30).toBe(0)
    expect(senior.last_hire_accepted_on).toBe(daysAgoIso(30).slice(0, 10))
    expect(senior.tier).toBe("in_play")
    expect(senior.tier_rule).toBe("moving_30d")
    expect(senior.attention).toEqual([]) // moving, offer-less, owned, low backlog
  })

  test("movement_14d carries per-stage conducted + advanced-in for the disclosure layer", () => {
    const { bundle } = derive()
    const senior = bundle.rows.find((row) => row.req_id === 101)!
    const byStage = new Map(senior.movement_14d.map((cell) => [cell.stage, cell]))
    expect(byStage.get("Onsite Interview")).toMatchObject({ conducted: 1, advanced_in: 1 })
    expect(byStage.get("Recruiter Phone Screen")).toMatchObject({ conducted: 1, advanced_in: 0 })
  })

  test("a parked pipeline beyond 30 days goes gone_quiet with the stall age in its reason", () => {
    const sources = fixtureSources()
    const { bundle } = derive({
      sources: {
        ...sources,
        applications: [{ id: 1001, job_id: 1, candidate_id: 9001, status: "in_process", stage_name: "Onsite Interview" }],
        scorecards: [],
        applicationStages: [],
        awaitingFeedbackInterviews: [],
      },
      engagedStageHistories: [
        { id: 5002, application_id: 1001, job_interview_stage_id: 302, entered_at: daysAgoIso(40), exited_at: null, current: true },
      ],
    })
    const senior = bundle.rows.find((row) => row.req_id === 101)!
    expect(senior.tier).toBe("gone_quiet")
    expect(senior.tier_reason).toContain("40 days")
    expect(senior.last_advance_at).toBe(daysAgoIso(40))
    // The 40-day onsite sitter also fires the onsite attention flag for the quiet row's detail.
    expect(senior.attention.some((flag) => flag.rule === "onsite_waiting")).toBe(true)
    expect(bundle.rollup.tiers.gone_quiet).toBe(1)
  })

  test("an emptied req with a recent hire is filled_not_closed, an empty hire-less one is no_search", () => {
    const sources = fixtureSources()
    const emptied = { ...sources, applications: sources.applications.filter((app) => app.job_id !== 1), scorecards: [], applicationStages: [], awaitingFeedbackInterviews: [] }
    const filled = derive({ sources: emptied, engagedStageHistories: [] }).bundle.rows.find((row) => row.req_id === 101)!
    expect(filled.tier).toBe("filled_not_closed")
    expect(filled.last_hire_accepted_on).toBe(daysAgoIso(30).slice(0, 10))

    const hireless = derive({
      sources: { ...emptied, offers: emptied.offers.filter((offer) => offer.job_id !== 1) },
      engagedStageHistories: [],
    }).bundle.rows.find((row) => row.req_id === 101)!
    expect(hireless.tier).toBe("no_search")
    expect(hireless.tier_reason).toBe("No candidates, no interview activity, no recent hires")
  })

  test("attention rows lead the in-play emit order; offers_out and attention_count land in the rollup", () => {
    const sources = fixtureSources()
    const withOfferReq = {
      ...sources,
      jobs: [
        ...sources.jobs,
        { id: 3, requisition_id: "103", name: "Head of Something", status: "open", opened_at: daysAgoIso(100), department_id: 10 },
      ],
      applications: [
        ...sources.applications,
        { id: 1006, job_id: 3, candidate_id: 9006, status: "in_process", stage_name: "Offer" },
      ],
    }
    const { bundle } = derive({
      sources: withOfferReq,
      engagedStageHistories: [
        ...fixtureStageHistories(),
        { id: 5004, application_id: 1006, job_interview_stage_id: 999, entered_at: daysAgoIso(20), exited_at: null, current: true },
      ],
    })
    const offerReq = bundle.rows.find((row) => row.req_id === 103)!
    expect(offerReq.tier).toBe("in_play") // advance 20d ago is inside the 30d window
    expect(offerReq.attention[0]).toMatchObject({ rule: "offer_waiting" })
    expect(offerReq.attention.some((flag) => flag.rule === "unowned")).toBe(true)
    // Emit order: the flagged in-play req precedes the calm one; the pool stays last.
    const emittedReqIds = bundle.rows.map((row) => row.req_id)
    expect(emittedReqIds.indexOf(103)).toBeLessThan(emittedReqIds.indexOf(101))
    expect(emittedReqIds[emittedReqIds.length - 1]).toBe(102)
    expect(bundle.rollup.attention_count).toBe(1)
    expect(bundle.rollup.offers_out).toEqual({ count: 1, waiting_14d_plus: 1 })
    expect(bundle.rollup.tiers.in_play).toBe(2)
    expect(bundle.rollup.positions_in_play).toBe(2) // job 3 has no open openings
  })
})
