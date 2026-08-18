import { describe, expect, test } from "vitest"

import { buildReqWeekReportRows } from "../lib/recruiting-ops/delivery-source/req-week-report"

describe("ReqWeekReportRow platform emit", () => {
  test("emits queried fields and governed audience scope without human-owned columns", () => {
    const [row] = buildReqWeekReportRows({
      reportingWeekFriday: "2026-07-03",
      asOf: "2026-07-10T12:00:00.000Z",
      jobs: [
        {
          id: 42,
          requisition_id: 890,
          name: "Platform Engineer",
          status: "open",
          department_id: 7,
          opened_at: "2026-06-20T00:00:00.000Z",
          custom_fields: [
            { name: "Hiring Location(s)", value: "United States" },
            { name: "Hiring Manager", value: "Hiring Leader" },
          ],
        },
      ],
      openings: [
        { id: 1, job_id: 42, status: "open", open: true, opened_at: "2026-06-18T00:00:00.000Z" },
        { id: 2, job_id: 42, status: "closed", open: false, opened_at: "2026-06-19T00:00:00.000Z" },
      ],
      jobOwners: [
        { id: 1, job_id: 42, user_id: 10, type: "recruiter" },
        { id: 2, job_id: 42, user_id: 11, type: "sourcer" },
      ],
      users: [
        { id: 10, name: "Recruiter One" },
        { id: 11, name: "Sourcer One" },
      ],
      departments: [{ id: 7, name: "Engineering" }],
      offers: [
        { id: 1, job_id: 42, status: "accepted", created_at: "2026-07-04T10:00:00Z", resolved_at: "2026-07-08T10:00:00Z" },
        { id: 2, job_id: 42, status: "declined", created_at: "2026-07-05T10:00:00Z", resolved_at: "2026-07-09T10:00:00Z" },
      ],
      roster: [{ recruiterName: "Recruiter One", teamId: "team", teamName: "Team One", hodName: "Lead One" }],
    })

    expect(row).toMatchObject({
      upsertKey: "2026-07-03|890",
      reportingWeekEnd: "2026-07-09",
      reportingWeekLabel: "Jul 3 - Jul 9",
      requisitionId: "890",
      department: "Engineering",
      location: "United States",
      headcountOpen: 1,
      headcountClosed: 1,
      offerExtended: 2,
      signed: 1,
      declined: 1,
      acceptedOffers: 1,
      earliestOpeningDate: "2026-06-18",
      daysOpen: 22,
      recruiters: ["Recruiter One"],
      recruiterTeams: ["Team One"],
      sourcers: ["Sourcer One"],
      hiringManagers: ["Hiring Leader"],
      hods: ["Lead One"],
      jobUrl: "https://app4.greenhouse.io/sdash/42",
      audienceScope: "team_visible",
    })
    expect(row).not.toHaveProperty("priority")
    expect(row).not.toHaveProperty("comments")
    expect(row).not.toHaveProperty("roleType")
  })

  test.each([
    ["confidential", { name: "Executive", department: "Executive", confidential: true }, "confidential job or department"],
    ["delivery", { name: "Senior Engineer, Delivery", department: "Engineering" }, "delivery or fulfillment req"],
    ["holding", { name: "Central Hiring platform", department: "Engineering" }, "central-hiring platform holding req"],
    ["campaign", { name: "Recruiting Strike", department: "Engineering" }, "campaign requisition"],
  ])("keeps %s rows in full-internal scope with an explicit reason", (_label, job, reason) => {
    const [row] = buildReqWeekReportRows({
      reportingWeekFriday: "2026-07-03",
      asOf: "2026-07-10T00:00:00Z",
      jobs: [{ id: 1, requisition_id: 2, status: "open", ...job }],
      openings: [],
      jobOwners: [],
      users: [],
      departments: [],
      offers: [],
      roster: [],
    })
    expect(row.audienceScope).toBe("full_internal_only")
    expect(row.audienceReason).toBe(reason)
  })

  test("rejects an invalid reporting anchor rather than emitting an ambiguous key", () => {
    expect(() =>
      buildReqWeekReportRows({
        reportingWeekFriday: "July 3",
        asOf: "2026-07-10T00:00:00Z",
        jobs: [],
        openings: [],
        jobOwners: [],
        users: [],
        departments: [],
        offers: [],
        roster: [],
      })
    ).toThrow("reportingWeekFriday")
  })

  test("stops Days Open at the Greenhouse closure date", () => {
    const [row] = buildReqWeekReportRows({
      reportingWeekFriday: "2026-07-10",
      asOf: "2026-07-14T17:00:00.000Z",
      jobs: [{
        id: 42,
        requisition_id: 890,
        name: "Closed Platform Engineer",
        status: "closed",
        closed_at: "2026-07-13T18:00:00.000Z",
      }],
      openings: [{
        id: 1,
        job_id: 42,
        status: "closed",
        open: false,
        opened_at: "2026-07-01T12:00:00.000Z",
      }],
      jobOwners: [],
      users: [],
      departments: [],
      offers: [],
      roster: [],
    })

    expect(row).toMatchObject({
      closedDate: "2026-07-13",
      earliestOpeningDate: "2026-07-01",
      daysOpen: 12,
    })
  })
})
