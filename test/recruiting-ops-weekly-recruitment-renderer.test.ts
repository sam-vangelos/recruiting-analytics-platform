import { describe, expect, test } from "vitest"

import { renderWeeklyRecruitmentRows } from "../lib/recruiting-ops/delivery/weekly-recruitment-renderer"
import type { ReqWeekReportRow } from "../lib/recruiting-ops/delivery-source/req-week-report"

function source(overrides: Partial<ReqWeekReportRow> = {}): ReqWeekReportRow {
  return {
    upsertKey: "2026-07-03|890",
    reportingWeekFriday: "2026-07-03",
    reportingWeekEnd: "2026-07-09",
    reportingWeekLabel: "Jul 3 - Jul 9",
    jobId: "job-890",
    requisitionId: "890",
    jobName: "Platform Engineer",
    jobStatus: "open",
    closedDate: null,
    department: "Engineering",
    location: "Remote",
    headcountOpen: 2,
    headcountClosed: 1,
    offerExtended: 3,
    signed: 1,
    declined: 1,
    acceptedOffers: 4,
    earliestOpeningDate: "2026-01-01",
    daysOpen: 190,
    recruiters: ["Recruiter"],
    recruiterTeams: ["Team"],
    sourcers: ["Sourcer"],
    hiringManagers: ["Manager"],
    hods: ["HOD"],
    jobUrl: "https://app.greenhouse.io/sdash/890",
    reqClass: "role",
    audienceScope: "team_visible",
    audienceReason: "team-visible role",
    ...overrides,
  }
}

function currentRow(reqId: string): (string | number | boolean | null)[] {
  const row = Array<string | number | boolean | null>(26).fill(null)
  row[0] = "Old Job"
  row[2] = reqId
  row[3] = "human billable"
  row[6] = "human priority"
  row[9] = "human health"
  row[10] = "human progress"
  row[11] = "human comments"
  row[23] = "human role type"
  return row
}

describe("Weekly Recruitment copy renderer", () => {
  test("updates queried fields while physically excluding all six manual columns", () => {
    const current = currentRow("890")
    current[24] = "https://stale.example.test/jobs/890"
    const result = renderWeeklyRecruitmentRows({ currentRows: [current], sourceRows: [source()] })
    expect(result.desiredRows[0][0]).toBe("Platform Engineer")
    expect([3, 6, 9, 10, 11, 23].map((index) => result.desiredRows[0][index])).toEqual([
      "human billable",
      "human priority",
      "human health",
      "human progress",
      "human comments",
      "human role type",
    ])
    expect(result.segments.map((segment) => `${segment.startColumn}:${segment.endColumn}`)).toEqual([
      "A:C", "E:F", "H:I", "M:W", "Y:Z",
    ])
    expect(result.segments.flatMap((segment) => segment.values[0])).not.toContain("human comments")
    expect(result.desiredRows[0][24]).toBe("https://app.greenhouse.io/sdash/890")
    expect(result.segments.find((segment) => segment.rangeId === "weekly_recruitment_y_z")?.values[0][0])
      .toBe("https://app.greenhouse.io/sdash/890")
    expect(result.desiredRows[0]).not.toContain("https://stale.example.test/jobs/890")
    expect(renderWeeklyRecruitmentRows({ currentRows: result.desiredRows, sourceRows: [source()] }).desiredRows)
      .toEqual(result.desiredRows)
  })

  test("renders missing owner and roster lists as normalized blanks", () => {
    const result = renderWeeklyRecruitmentRows({
      currentRows: [currentRow("890")],
      sourceRows: [source({
        recruiters: [],
        recruiterTeams: [],
        sourcers: [],
        hiringManagers: [],
        hods: [],
      })],
    })

    expect(result.desiredRows[0].slice(18, 23)).toEqual([null, null, null, null, null])
    expect(result.segments.find((segment) => segment.rangeId === "weekly_recruitment_m_w")?.values[0])
      .not.toContain("")
  })

  test("appends new team-visible reqs, clears stale weekly metrics on departed rows, and reports scope", () => {
    const departed = currentRow("111")
    departed[12] = 4
    departed[13] = 2
    departed[14] = 1
    departed[15] = 9
    const scopedOut = currentRow("999")
    scopedOut[12] = 7
    scopedOut[13] = 6
    scopedOut[14] = 5
    scopedOut[15] = 4
    const result = renderWeeklyRecruitmentRows({
      currentRows: [departed, scopedOut],
      sourceRows: [source(), source({ requisitionId: "999", audienceScope: "full_internal_only" })],
    })
    expect(result.desiredRows).toHaveLength(3)
    expect(result.desiredRows[0].slice(12, 16)).toEqual([0, 0, 0, 9])
    expect(result.desiredRows[1].slice(12, 16)).toEqual([0, 0, 0, 4])
    expect(result.appendedReqIds).toEqual(["890"])
    expect(result.departedReqIds).toEqual(["111"])
    expect(result.scopeExcludedReqIds).toEqual(["999"])
  })

  test("updates the unique normalized job-name match and preserves the historical duplicate row", () => {
    const active = currentRow("1118")
    active[0] = "  RESEARCH   ENGINEER - BRAZIL  "
    active[1] = "closed"
    active[4] = "Old active department"
    const historical = currentRow("1118")
    historical[0] = "Frontier Data Lead - Brazil"
    historical[1] = "closed"
    historical[4] = "Historical department"
    historical[3] = "historical billable"
    historical[6] = "historical priority"
    historical[9] = "historical health"
    historical[10] = "historical progress"
    historical[11] = "historical comments"
    historical[23] = "historical role type"
    const historicalBefore = [...historical]
    historicalBefore[12] = 0
    historicalBefore[13] = 0
    historicalBefore[14] = 0

    const result = renderWeeklyRecruitmentRows({
      currentRows: [active, historical],
      sourceRows: [
        source({
          requisitionId: "1118",
          jobName: "Research Engineer - Brazil",
          jobStatus: "open",
          jobUrl: "https://app.greenhouse.io/sdash/1118",
        }),
      ],
    })

    expect(result.desiredRows[0][0]).toBe("Research Engineer - Brazil")
    expect(result.desiredRows[0][1]).toBe("open")
    expect(result.desiredRows[0][4]).toBe("Engineering")
    expect([3, 6, 9, 10, 11, 23].map((index) => result.desiredRows[0][index])).toEqual([
      "human billable",
      "human priority",
      "human health",
      "human progress",
      "human comments",
      "human role type",
    ])
    expect(result.desiredRows[1]).toEqual(historicalBefore)
    expect(result.appendedReqIds).toEqual([])
  })

  test("uses normalized status only to disambiguate repeated normalized job names", () => {
    const historical = currentRow("1118")
    historical[0] = "Research Engineer - Brazil"
    historical[1] = "closed"
    historical[4] = "Historical department"
    const active = currentRow("1118")
    active[0] = " research   engineer - brazil "
    active[1] = " OPEN "
    active[4] = "Old active department"

    const result = renderWeeklyRecruitmentRows({
      currentRows: [historical, active],
      sourceRows: [
        source({
          requisitionId: "1118",
          jobName: "Research Engineer - Brazil",
          jobStatus: "open",
        }),
      ],
    })

    expect(result.desiredRows[0][4]).toBe("Historical department")
    expect(result.desiredRows[1][4]).toBe("Engineering")
  })

  test("fails closed when duplicate copy rows have no normalized job-name match", () => {
    const first = currentRow("1118")
    first[0] = "Different current role"
    first[1] = "open"
    const second = currentRow("1118")
    second[0] = "Different historical role"
    second[1] = "closed"

    expect(() =>
      renderWeeklyRecruitmentRows({
        currentRows: [first, second],
        sourceRows: [source({ requisitionId: "1118", jobName: "Research Engineer - Brazil", jobStatus: "open" })],
      })
    ).toThrow("no normalized job-name match")
  })

  test("fails closed when duplicate copy rows remain ambiguous after status matching", () => {
    const first = currentRow("1118")
    first[0] = "Research Engineer - Brazil"
    first[1] = "open"
    const second = currentRow("1118")
    second[0] = " research   engineer - brazil "
    second[1] = " OPEN "

    expect(() =>
      renderWeeklyRecruitmentRows({
        currentRows: [first, second],
        sourceRows: [source({ requisitionId: "1118", jobName: "Research Engineer - Brazil", jobStatus: "open" })],
      })
    ).toThrow("ambiguous after normalized job-name and status matching")
  })

  test("clears weekly metrics on every historical duplicate when no source row remains", () => {
    const first = currentRow("890")
    const second = currentRow("890")
    first.splice(12, 3, 3, 2, 1)
    second.splice(12, 3, 6, 5, 4)
    const result = renderWeeklyRecruitmentRows({
      currentRows: [first, second],
      sourceRows: [],
    })
    expect(result.desiredRows.map((row) => row.slice(12, 15))).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ])
    expect(result.departedReqIds).toEqual(["890"])
  })

  test("continues to fail closed on duplicate Req IDs in the source", () => {
    expect(() => renderWeeklyRecruitmentRows({ currentRows: [], sourceRows: [source(), source()] })).toThrow("source contains duplicate")
  })
})
