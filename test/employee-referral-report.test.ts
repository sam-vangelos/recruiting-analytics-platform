import { describe, expect, test, vi } from "vitest"

import {
  buildEmployeeReferralReport,
  createEmployeeReferralReportPeriod,
  createPreviousEmployeeReferralMonth,
  evaluateEmployeeReferralEligibility,
  loadEmployeeReferralSnapshot,
  renderEmployeeReferralCsv,
  type EmployeeReferralGreenhouseGetAll,
  type EmployeeReferralReportRow,
  type EmployeeReferralSnapshot,
} from "../lib/recruiting-ops/employee-referral-report"
import {
  EMPLOYEE_REFERRAL_POLICY,
  EMPLOYEE_REFERRAL_POLICY_CONFIG_SHA256,
  resolveEmployeeReferralPolicy,
} from "../lib/recruiting-ops/employee-referral-policy"

const period = createEmployeeReferralReportPeriod("2026-04-01", "2026-07-01")

function baseSnapshot(): EmployeeReferralSnapshot {
  return {
    period,
    currentOffers: [
      {
        id: 10,
        version: 1,
        resolved_at: "2026-04-20T18:00:00Z",
        application_id: 100,
        starts_on: "2026-05-01",
        job_id: 200,
        status: "Accepted",
        candidate_id: 300,
        custom_fields: { hiring_location: { name: "Hiring Location", value: "USA" } },
      },
      {
        id: 12,
        version: 1,
        resolved_at: "2026-05-20T18:00:00Z",
        application_id: 101,
        starts_on: "2026-06-01",
        job_id: 200,
        status: "Accepted",
        candidate_id: 301,
        custom_fields: { hiring_location: { value: "India" } },
      },
    ],
    allVersionOffers: [
      {
        id: 11,
        version: 2,
        resolved_at: "2026-04-18T18:00:00Z",
        application_id: 100,
        starts_on: "2026-05-01",
        job_id: 200,
        status: "Deprecated",
        candidate_id: 300,
        custom_fields: { hiring_location: { value: "USA" } },
      },
    ],
    applications: [
      {
        id: 100,
        candidate_id: 300,
        job_id: 201,
        status: "hired",
        source_id: 4000194004,
        referrer_id: 400,
      },
      {
        id: 101,
        candidate_id: 301,
        job_id: 200,
        status: "hired",
        source_id: 999,
        referrer_id: 401,
      },
    ],
    candidates: [
      { id: 300, first_name: "=HYPERLINK(\"bad\")", last_name: "<Candidate>" },
      { id: 301, first_name: "Second", last_name: "Candidate" },
    ],
    jobs: [
      { id: 200, name: "Engineer & Builder", department_id: 4069524004 },
      { id: 201, name: "Transferred role", department_id: 4069529004 },
    ],
    departments: [
      { id: 4069524004, name: "R&D / Engineering" },
      { id: 4069529004, name: "Executive & Admin" },
    ],
    referrers: [
      { id: 400, user_id: 500, name: "Referrer <One>" },
      { id: 401, user_id: null, name: "Custom Referrer" },
    ],
    jobOwners: [
      { id: 700, job_id: 200, user_id: 600, type: "hiring_manager" },
    ],
    users: [
      { id: 500, name: "Referrer <One>", deactivated: false },
      { id: 600, name: "Hiring Manager" },
    ],
    sources: [
      {
        id: 4000194004,
        name: "Referral",
        type: { id: 4000002004, name: "Referral" },
      },
      { id: 999, name: "New referral", type: { id: 4000002004, name: "Referral" } },
      { id: 888, name: "Inbound", type: { id: 1, name: "Prospecting" } },
    ],
    customFields: [
      {
        id: 23150958004,
        name: "Hiring Location",
        name_key: "hiring_location",
        field_type: "offer",
        active: true,
      },
    ],
  }
}

describe("employee referral period", () => {
  test("uses exact Los Angeles PST/PDT boundaries", () => {
    expect(createEmployeeReferralReportPeriod("2026-01-01", "2026-02-01")).toMatchObject({
      windowStartUtc: "2026-01-01T08:00:00.000Z",
      windowEndUtc: "2026-02-01T08:00:00.000Z",
      label: "January 2026",
    })
    expect(createEmployeeReferralReportPeriod("2026-07-01", "2026-08-01")).toMatchObject({
      windowStartUtc: "2026-07-01T07:00:00.000Z",
      windowEndUtc: "2026-08-01T07:00:00.000Z",
      label: "July 2026",
    })
    expect(period).toMatchObject({
      windowStartUtc: "2026-04-01T07:00:00.000Z",
      windowEndUtc: "2026-07-01T07:00:00.000Z",
      label: "April-June 2026",
    })
  })

  test("derives the prior local month across a year boundary", () => {
    expect(createPreviousEmployeeReferralMonth(new Date("2026-01-15T12:00:00Z"))).toMatchObject({
      periodStartLocal: "2025-12-01",
      periodEndLocalExclusive: "2026-01-01",
      label: "December 2025",
    })
  })

  test("rejects non-month and reversed boundaries", () => {
    expect(() => createEmployeeReferralReportPeriod("2026-04-02", "2026-05-01")).toThrow(
      "YYYY-MM-01"
    )
    expect(() => createEmployeeReferralReportPeriod("2026-05-01", "2026-04-01")).toThrow(
      "must be after"
    )
  })
})

describe("employee referral policy", () => {
  test.each([
    ["USA", "4069524004", 3000, "USD"],
    ["USA", "4069529004", 1000, "USD"],
    ["UK", "4069524004", 2250, "GBP"],
    ["UK", "4069529004", 750, "GBP"],
    ["India", "4069524004", 70000, "INR"],
    ["India", "4094661004", 70000, "INR"],
    ["India", "4069529004", 25000, "INR"],
    ["Brazil", "4069524004", 1200, "BRL"],
    ["Brazil", "4069529004", 400, "BRL"],
  ])("maps %s and department %s", (location, departmentId, amount, currency) => {
    expect(
      resolveEmployeeReferralPolicy({
        acceptedDate: "2026-04-14",
        hiringLocation: location,
        departmentId,
      })
    ).toMatchObject({ amount, currency, reviewReasons: [] })
  })

  test("keeps unresolvable combinations blank and pre-effective rates reviewable", () => {
    expect(
      resolveEmployeeReferralPolicy({
        acceptedDate: "2026-04-14",
        hiringLocation: "Columbia",
        departmentId: "4069524004",
      })
    ).toMatchObject({ amount: null, country: "Columbia" })
    expect(
      resolveEmployeeReferralPolicy({
        acceptedDate: "2026-04-14",
        hiringLocation: "RoW/EOR",
        departmentId: "4069524004",
      })
    ).toMatchObject({ amount: null, country: "Other" })
    expect(
      resolveEmployeeReferralPolicy({
        acceptedDate: "2026-04-13",
        hiringLocation: "USA",
        departmentId: "4069524004",
      })
    ).toMatchObject({
      amount: 3000,
      currency: "USD",
      bonusResolutionStatus: "POLICY_MAPPING_REQUIRED - Policy DRI/People Ops",
      reviewReasons: ["POLICY_PREDATES_EFFECTIVE_DATE:2026-04-14"],
    })
    expect(
      resolveEmployeeReferralPolicy({
        acceptedDate: "2026-04-14",
        hiringLocation: "Mars",
        departmentId: "999999",
      })
    ).toMatchObject({ amount: null, country: null, functionBand: null })
  })

  test("locks the policy rate on the Los Angeles accepted calendar date", () => {
    expect(
      resolveEmployeeReferralPolicy({
        acceptedDate: "2026-04-14T06:59:59.999Z",
        hiringLocation: "USA",
        departmentId: "4069524004",
      }).amount
    ).toBe(3000)
    expect(
      resolveEmployeeReferralPolicy({
        acceptedDate: "2026-04-14T07:00:00.000Z",
        hiringLocation: "USA",
        departmentId: "4069524004",
      }).amount
    ).toBe(3000)
    expect(
      resolveEmployeeReferralPolicy({
        acceptedDate: "2026-04-14-not-an-instant",
        hiringLocation: "USA",
        departmentId: "4069524004",
      }).amount
    ).toBeNull()
  })

  test("pins the approved source export and a deterministic policy config hash", () => {
    expect(EMPLOYEE_REFERRAL_POLICY.sourceDocumentExportSha256).toBe(
      "0000000000000000000000000000000000000000000000000000000000000000"
    )
    expect(EMPLOYEE_REFERRAL_POLICY_CONFIG_SHA256).toBe(
      "72c08c76b9dbc42dd14590ae070358f3671b4b8a5f0c422e746baf0dff384616"
    )
  })
})

describe("employee referral eligibility first pass", () => {
  const base = {
    recordType: "CURRENT_ACCEPTED_COHORT" as const,
    hiringManagerNames: ["Hiring Manager"],
    offerJobTitle: "Research Engineer",
    currentApplicationJob: "Research Engineer",
    greenhousePlannedStartDate: "2026-05-01",
    assessmentDateLocal: "2026-07-28",
  }

  test("matches Bob's deterministic manager and internship exclusions", () => {
    expect(
      evaluateEmployeeReferralEligibility({
        ...base,
        referringEmployeeName: "Tristan Tager",
        hiringManagerNames: ["Tristan Tager"],
        offerJobTitle: "Strategic Project Lead",
      })
    ).toMatchObject({
      status: "LIKELY INELIGIBLE",
      reason: "Referring employee is a listed hiring manager",
    })
    expect(
      evaluateEmployeeReferralEligibility({
        ...base,
        referringEmployeeName: "Vikramjit Singh Bagga",
        hiringManagerNames: ["Vikramjit Singh Bagga"],
        offerJobTitle: "Product Designer",
      })
    ).toMatchObject({
      status: "LIKELY INELIGIBLE",
      reason: "Referring employee is a listed hiring manager",
    })
    expect(
      evaluateEmployeeReferralEligibility({
        ...base,
        referringEmployeeName: "Ravi Gupte",
        offerJobTitle: "Code OTS Delivery Intern - US",
      })
    ).toMatchObject({
      status: "LIKELY INELIGIBLE",
      reason: "Position is an internship",
    })
  })

  test("flags inactive or executive referrers and non-regular offers", () => {
    expect(
      evaluateEmployeeReferralEligibility({
        ...base,
        referringEmployeeName: "Former Employee",
        referringEmployeeDeactivated: true,
      })
    ).toMatchObject({
      status: "LIKELY INELIGIBLE",
      reason: "Referring employee is no longer active",
    })
    expect(
      evaluateEmployeeReferralEligibility({
        ...base,
        referringEmployeeName: "Executive Referrer",
        referringEmployeeIsExecutiveOrElt: true,
        offerWorkStatus: "Part time",
      })
    ).toMatchObject({
      status: "LIKELY INELIGIBLE",
      reason: "Referring employee is an executive or ELT member; Offer is part-time",
    })
    expect(
      evaluateEmployeeReferralEligibility({
        ...base,
        referringEmployeeName: "Employee",
        offerAnticipatedEndDate: "2026-09-30",
      })
    ).toMatchObject({
      status: "NEEDS REVIEW",
      reason: "Offer has an anticipated end date (2026-09-30)",
    })
  })

  test("uses the accepted-offer supervisor for the hiring-manager conflict", () => {
    const snapshot = baseSnapshot()
    snapshot.currentOffers = [
      {
        ...snapshot.currentOffers[0],
        custom_fields: {
          hiring_location: { name: "Hiring Location", value: "USA" },
          supervisor: {
            name: "Supervisor",
            value: { user_id: 500, name: "Referrer <One>" },
          },
        },
      },
    ]
    snapshot.allVersionOffers = []
    expect(buildEmployeeReferralReport(snapshot).rows[0]).toMatchObject({
      hiringManagerNames: ["Hiring Manager", "Referrer <One>"],
      preliminaryEligibility: "LIKELY INELIGIBLE",
      eligibilityReason: "Referring employee is a listed hiring manager",
    })
  })

  test("calculates the 90-day date and leaves unavailable facts for review", () => {
    expect(
      evaluateEmployeeReferralEligibility({
        ...base,
        referringEmployeeName: "Dhanasree Molugu",
      })
    ).toEqual({
      status: "PENDING - 90 DAYS NOT COMPLETED",
      reason: "Estimated 90-day date is 2026-07-30",
      estimatedNinetyDayDate: "2026-07-30",
    })
    expect(
      evaluateEmployeeReferralEligibility({
        ...base,
        referringEmployeeName: "Dhanasree Molugu",
        hiringManagerNames: [],
      })
    ).toMatchObject({
      status: "NEEDS REVIEW",
      reason: "Hiring manager is unavailable",
    })
  })
})

describe("employee referral report", () => {
  test("keeps current, Deprecated, and ungoverned records typed and uncoalesced", () => {
    const report = buildEmployeeReferralReport(baseSnapshot(), {
      correlationId: "corr-test",
      assessmentDateLocal: "2026-07-22",
    })
    expect(report.counts).toEqual({
      currentCohortCount: 1,
      deprecatedReviewCount: 1,
      ungovernedSourceReviewCount: 1,
      amountMappedCount: 1,
      mappingReviewCount: 3,
      totalRowCount: 3,
    })
    expect(report.rows.map((row) => row.recordType)).toEqual([
      "CURRENT_ACCEPTED_COHORT",
      "DEPRECATED_SIGNING_REVIEW",
      "UNGOVERNED_REFERRAL_SOURCE_REVIEW",
    ])
    expect(new Set(report.rows.map((row) => row.rowKey)).size).toBe(3)
    const current = report.rows[0]
    expect(current).toMatchObject({
      offerJobTitle: "Engineer & Builder",
      offerJobFunction: "R&D / Engineering",
      currentApplicationJob: "Transferred role",
      policyFunctionBand: "Delivery and R&D",
      policyReferenceBonusAmount: 3000,
      policyReferenceCurrency: "USD",
      hiringManagerNames: ["Hiring Manager"],
      preliminaryEligibility: "PENDING - 90 DAYS NOT COMPLETED",
      estimatedNinetyDayDate: "2026-07-30",
    })
    expect(current.mappingReviewStatusReason).toContain("CURRENT_APPLICATION_JOB_MISMATCH:201")
    expect(report.rows[1].mappingReviewStatusReason).toContain(
      "DEPRECATED_OFFER_ACCEPTANCE_UNKNOWN"
    )
    expect(report.rows[1].policyReferenceBonusAmount).toBeNull()
    expect(report.rows[2].mappingReviewStatusReason).toContain("UNGOVERNED_REFERRAL_SOURCE:999")
    expect(report.rows[2].policyReferenceBonusAmount).toBeNull()
    expect(report.publicDiagnostics).not.toHaveProperty("rows")
  })

  test("escapes HTML and neutralizes formulas while retaining RFC 4180 quoting", () => {
    const report = buildEmployeeReferralReport(baseSnapshot())
    expect(report.html).toContain("Referrer &lt;One&gt;")
    expect(report.html).toContain("Engineer &amp; Builder")
    expect(report.html).not.toContain("Referrer <One>")
    expect(report.csv).toContain("\"'=HYPERLINK(\"\"bad\"\") <Candidate>\"")
    expect(report.csv).toContain("\"Referrer <One>\"")
    expect(report.csv.split("\r\n")[0].split(",")).toHaveLength(23)
  })

  test("neutralizes every dangerous spreadsheet prefix", () => {
    const template = buildEmployeeReferralReport(baseSnapshot()).rows[0]
    const rows = ["=x", "+x", "-x", "@x", "\tx", "\rx"].map(
      (candidateName, index): EmployeeReferralReportRow => ({
        ...template,
        rowKey: `row-${index}`,
        candidateName,
      })
    )
    const csv = renderEmployeeReferralCsv(rows)
    for (const prefix of ["=x", "+x", "-x", "@x", "\tx", "\rx"]) {
      expect(csv).toContain(`\"'${prefix.replace(/\r/g, "\r")}\"`)
    }
  })

  test("sends an explicit zero-row success representation", () => {
    const snapshot = baseSnapshot()
    snapshot.currentOffers = []
    snapshot.allVersionOffers = []
    snapshot.applications = []
    snapshot.candidates = []
    snapshot.jobs = []
    snapshot.departments = []
    snapshot.referrers = []
    const report = buildEmployeeReferralReport(snapshot)
    expect(report.counts.totalRowCount).toBe(0)
    expect(report.subject).toContain("0 current - 0 review")
    expect(report.html).toContain("Zero current accepted employee referrals")
    expect(report.csv.split("\r\n").filter(Boolean)).toHaveLength(1)
  })

  test("does not fall back to candidate source attribution", () => {
    const snapshot = baseSnapshot()
    snapshot.currentOffers = [snapshot.currentOffers[0]]
    snapshot.allVersionOffers = []
    snapshot.applications[0] = { ...snapshot.applications[0], source_id: 888 }
    expect(buildEmployeeReferralReport(snapshot).counts.totalRowCount).toBe(0)
  })

  test("retains multiple accepted offers for the same candidate", () => {
    const snapshot = baseSnapshot()
    snapshot.currentOffers = [
      snapshot.currentOffers[0],
      { ...snapshot.currentOffers[0], id: 13, version: 2 },
    ]
    snapshot.allVersionOffers = []
    const report = buildEmployeeReferralReport(snapshot)
    expect(report.counts.currentCohortCount).toBe(2)
    expect(
      report.rows.every((row) =>
        row.mappingReviewStatusReason.includes(
          "MULTIPLE_CURRENT_ACCEPTED_OFFERS_OR_APPLICATIONS_FOR_CANDIDATE"
        )
      )
    ).toBe(true)
  })

  test("flags distinct current applications for one candidate", () => {
    const snapshot = baseSnapshot()
    snapshot.currentOffers = [
      snapshot.currentOffers[0],
      {
        ...snapshot.currentOffers[0],
        id: 14,
        application_id: 102,
      },
    ]
    snapshot.allVersionOffers = []
    snapshot.applications.push({
      ...snapshot.applications[0],
      id: 102,
    })
    const report = buildEmployeeReferralReport(snapshot)
    expect(report.rows).toHaveLength(2)
    expect(
      report.rows.every((row) =>
        row.mappingReviewStatusReason.includes(
          "MULTIPLE_CURRENT_ACCEPTED_OFFERS_OR_APPLICATIONS_FOR_CANDIDATE"
        )
      )
    ).toBe(true)
  })

  test("flags a governed and ungoverned current Accepted pair for one candidate", () => {
    const snapshot = baseSnapshot()
    snapshot.currentOffers[1] = {
      ...snapshot.currentOffers[1],
      candidate_id: 300,
    }
    snapshot.applications[1] = {
      ...snapshot.applications[1],
      candidate_id: 300,
    }
    const report = buildEmployeeReferralReport(snapshot)
    const currentAcceptedRows = report.rows.filter(
      (row) => row.recordType !== "DEPRECATED_SIGNING_REVIEW"
    )
    expect(currentAcceptedRows).toHaveLength(2)
    expect(
      currentAcceptedRows.every((row) =>
        row.mappingReviewStatusReason.includes(
          "MULTIPLE_CURRENT_ACCEPTED_OFFERS_OR_APPLICATIONS_FOR_CANDIDATE"
        )
      )
    ).toBe(true)
  })

  test("keeps a missing business value visible but fails unresolved foreign keys", () => {
    const missing = baseSnapshot()
    missing.currentOffers = [missing.currentOffers[0]]
    missing.allVersionOffers = []
    missing.applications[0] = { ...missing.applications[0], referrer_id: null }
    expect(buildEmployeeReferralReport(missing).rows[0]).toMatchObject({
      referringEmployeeName: null,
    })
    expect(buildEmployeeReferralReport(missing).rows[0].mappingReviewStatusReason).toContain(
      "REFERRER_MISSING"
    )

    const unresolved = baseSnapshot()
    unresolved.currentOffers = [unresolved.currentOffers[0]]
    unresolved.allVersionOffers = []
    unresolved.jobs = unresolved.jobs.filter((job) => job.id !== 200)
    expect(() => buildEmployeeReferralReport(unresolved)).toThrow("unresolved offer job 200")
  })

  test("fails closed on source tuple or stable field drift", () => {
    const sourceDrift = baseSnapshot()
    sourceDrift.sources[0] = { ...sourceDrift.sources[0], name: "Edited" }
    expect(() => buildEmployeeReferralReport(sourceDrift)).toThrow("source tuple drifted")

    const fieldDrift = baseSnapshot()
    fieldDrift.customFields[0] = { ...fieldDrift.customFields[0], name_key: "renamed" }
    expect(() => buildEmployeeReferralReport(fieldDrift)).toThrow("expected exactly once")
  })

  test("does not classify a source from a mutable Referral name alone", () => {
    const snapshot = baseSnapshot()
    snapshot.currentOffers = [snapshot.currentOffers[1]]
    snapshot.allVersionOffers = []
    snapshot.sources[1] = {
      id: 999,
      name: "Misleading",
      type: { id: 123, name: "Referral" },
    }
    expect(buildEmployeeReferralReport(snapshot).counts.totalRowCount).toBe(0)
  })

  test("fails candidate mismatch, an unresolved candidate reference, and missing version", () => {
    const mismatch = baseSnapshot()
    mismatch.currentOffers = [{ ...mismatch.currentOffers[0], candidate_id: 301 }]
    mismatch.allVersionOffers = []
    expect(() => buildEmployeeReferralReport(mismatch)).toThrow(
      "offer/application candidate mismatch"
    )

    const unresolved = baseSnapshot()
    unresolved.currentOffers = [unresolved.currentOffers[0]]
    unresolved.allVersionOffers = []
    unresolved.candidates = []
    expect(() => buildEmployeeReferralReport(unresolved)).toThrow("unresolved offer candidate 300")

    const missingVersion = baseSnapshot()
    missingVersion.currentOffers = [{ ...missingVersion.currentOffers[0], version: null }]
    missingVersion.allVersionOffers = []
    expect(() => buildEmployeeReferralReport(missingVersion)).toThrow("offer version is missing id")
  })

  test("rejects missing, malformed, start-before, and end-boundary resolved instants", () => {
    for (const resolved_at of [
      null,
      "not-an-instant",
      "2026-04-01T06:59:59.999Z",
      "2026-07-01T07:00:00.000Z",
    ]) {
      const snapshot = baseSnapshot()
      snapshot.currentOffers = [{ ...snapshot.currentOffers[0], resolved_at }]
      snapshot.allVersionOffers = []
      expect(() => buildEmployeeReferralReport(snapshot)).toThrow(/resolved_at|outside report period/)
    }
    const start = baseSnapshot()
    start.currentOffers = [
      { ...start.currentOffers[0], resolved_at: "2026-04-01T07:00:00.000Z" },
    ]
    start.allVersionOffers = []
    expect(buildEmployeeReferralReport(start).counts.currentCohortCount).toBe(1)
  })
})

describe("employee referral Greenhouse loader", () => {
  test("uses exact offer projection, separate bounds, and batches dependent IDs at 50", async () => {
    const currentOffers = Array.from({ length: 51 }, (_, index) => ({
      id: index + 1,
      version: 1,
      application_id: 1000 + index,
      candidate_id: 2000 + index,
      job_id: 3000 + index,
      resolved_at: "2026-04-20T00:00:00Z",
      status: "Accepted",
    }))
    const calls: { path: string; params?: Record<string, string | number | boolean | undefined> }[] = []
    const getAll: EmployeeReferralGreenhouseGetAll = vi.fn(async (path, params) => {
      calls.push({ path, params })
      if (path === "/offers" && params?.current_only === true) return currentOffers as never[]
      if (path === "/offers") return []
      if (path === "/applications") {
        return String(params?.ids)
          .split(",")
          .map((id, index) => ({
            id: Number(id),
            candidate_id: 2000 + Number(id) - 1000,
            job_id: 3000 + Number(id) - 1000,
            referrer_id: 4000 + index,
          })) as never[]
      }
      if (path === "/referrers") {
        return String(params?.ids)
          .split(",")
          .map((id) => ({
            id: Number(id),
            user_id: Number(id) + 1000,
            name: `Referrer ${id}`,
          })) as never[]
      }
      if (path === "/users") {
        return String(params?.ids)
          .split(",")
          .map((id) => ({ id: Number(id), deactivated: false })) as never[]
      }
      return []
    })
    await loadEmployeeReferralSnapshot(period, getAll)
    const offerCalls = calls.filter((call) => call.path === "/offers")
    expect(offerCalls).toHaveLength(2)
    expect(offerCalls[0].params).toMatchObject({
      status: "Accepted",
      current_only: true,
      "resolved_at[gte]": "2026-04-01T07:00:00.000Z",
      "resolved_at[lt]": "2026-07-01T07:00:00.000Z",
      per_page: 500,
    })
    expect(offerCalls[0].params?.fields).toContain("version")
    expect(offerCalls[0].params?.fields).toContain("opening_id")
    expect(offerCalls[0].params?.fields).not.toContain("sent_at")
    expect(offerCalls[1].params).not.toHaveProperty("status")
    expect(offerCalls[1].params?.current_only).toBe(false)
    const applicationCalls = calls.filter((call) => call.path === "/applications")
    expect(applicationCalls).toHaveLength(2)
    expect(applicationCalls.map((call) => String(call.params?.ids).split(",").length)).toEqual([
      50, 1,
    ])
    expect(
      calls
        .filter((call) => call.params?.ids)
        .every((call) => String(call.params?.ids).split(",").length <= 50)
    ).toBe(true)
    expect(calls.filter((call) => call.path === "/users")).toHaveLength(1)
  })

  test("propagates endpoint failures and rejects a missing offer application key", async () => {
    const failure: EmployeeReferralGreenhouseGetAll = async (path) => {
      if (path === "/sources") throw new Error("terminal page failed")
      return []
    }
    await expect(loadEmployeeReferralSnapshot(period, failure)).rejects.toThrow("terminal page failed")

    const missingKey: EmployeeReferralGreenhouseGetAll = async (path, params) => {
      if (path === "/offers" && params?.current_only === true) {
        return [{ id: 1, status: "Accepted", application_id: null }] as never[]
      }
      return []
    }
    await expect(loadEmployeeReferralSnapshot(period, missingKey)).rejects.toThrow(
      "has no application_id"
    )
  })
})
