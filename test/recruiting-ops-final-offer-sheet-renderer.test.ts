import { describe, expect, test } from "vitest"

import type { RecruiterTeamHodEntry } from "../lib/recruiting-ops/dimensions/config/recruiter-team-hod.v1"
import type { OfferLifecycleExportRow } from "../lib/recruiting-ops/delivery-source/offer-lifecycle-export"
import { projectFinalOfferSheet } from "../lib/recruiting-ops/delivery/final-offer-sheet-renderer"
import { FINAL_OFFER_HEADERS } from "../lib/recruiting-ops/delivery/staging-sheet-contracts"

const roster: readonly RecruiterTeamHodEntry[] = [
  {
    recruiterName: "Offer Recruiter",
    teamId: "team_offer",
    teamName: "Team Offer",
    hodName: "Roster HOD",
  },
  {
    recruiterName: "Offer Sourcer",
    teamId: "team_source",
    teamName: "Team Source",
    hodName: "Source HOD",
  },
]

function offer(overrides: Partial<OfferLifecycleExportRow> = {}): OfferLifecycleExportRow {
  return {
    source_system: "greenhouse",
    offer_id: "7001",
    offer_status: "accepted",
    application_id: "101",
    application_status: "hired",
    application_stage: "Offer",
    candidate_id: "501",
    candidate_name: "Candidate One",
    job_id: "900",
    requisition_id: "1027",
    job_name: "Research Engineer",
    detailed_job_title: "Research Engineer, RL Gyms - US",
    job_status: "open",
    job_level: "IC",
    department_name: "R&D / Engineering",
    hiring_location: "US - Remote",
    recruiter_of_record_id: "21",
    recruiter_of_record_name: "Offer Recruiter",
    sourcer_id: "24",
    sourcer_name: "Offer Sourcer",
    hod_id: "25",
    hod_name: "Department HOD",
    created_by_id: "22",
    created_by_name: "Offer Creator",
    approver_id: "23",
    approver_name: "Final Approver",
    rejection_reason_id: "44",
    rejection_reason_name: "Candidate declined",
    rejection_type: "candidate",
    rejected_at: "2026-07-05T01:00:00.000Z",
    candidate_source_id: "77",
    candidate_source_name: "Employee Referral",
    candidate_source_type: "Referral",
    created_at: "2026-07-02T10:00:00.000Z",
    sent_at: "2026-07-03T23:00:00.000Z",
    resolved_at: "2026-07-05T01:00:00.000Z",
    start_date: "2026-07-20",
    custom_field_metadata: [],
    ...overrides,
  }
}

const q3 = { startDate: "2026-07-01", endDateExclusive: "2026-10-01" }

describe("Final Offer staging renderer", () => {
  test("renders the exact governed Mastersheet A:AE contract", () => {
    const projection = projectFinalOfferSheet({ rows: [offer()], roster, quarter: q3 })

    expect(projection.contractId).toBe("final_offer_master")
    expect(projection.headers).toEqual(FINAL_OFFER_HEADERS)
    expect(projection.rows).toEqual([
      {
        offerId: "7001",
        upsertKey: "101\u00002026-07-02T10:00:00.000Z",
        recruiterTeamName: "Team Offer",
        sourcerTeamName: "Team Source",
        values: [
          "Candidate One",
          "Offer Accepted",
          "Offer",
          "101",
          "Offer Recruiter",
          "44",
          "Candidate declined",
          "candidate",
          "Team Offer",
          "Offer Sourcer",
          "Team Source",
          "Employee Referral - Referral",
          "accepted",
          "2026-07-02T10:00:00.000Z",
          "Offer Creator",
          "2026-07-03T23:00:00.000Z",
          "2026-07-05T01:00:00.000Z",
          3,
          "Research Engineer",
          "Research Engineer, RL Gyms - US",
          "1027",
          "open",
          "July",
          5,
          1,
          "IC",
          "2026-07-20",
          "R&D / Engineering",
          "Department HOD",
          "Final Approver",
          "US - Remote",
        ],
      },
    ])
    expect(projection.rows[0].values).toHaveLength(31)
  })

  test("filters by created quarter, assigns observed lifecycle/month ordinals, and sorts by offer id", () => {
    const projection = projectFinalOfferSheet({
      roster,
      quarter: q3,
      rows: [
        offer({ offer_id: "10", application_status: "active", offer_status: "approved", created_at: "2026-08-01T00:00:00Z", resolved_at: null }),
        offer({ offer_id: "2", application_status: "rejected", rejection_type: "company", offer_status: "declined", created_at: "2026-09-30T23:59:59Z", resolved_at: null }),
        offer({ offer_id: "1", application_status: "active", offer_status: "created", created_at: "2026-07-01T00:00:00Z", sent_at: null, resolved_at: null }),
        offer({ offer_id: "before", created_at: "2026-06-30T23:59:59Z" }),
        offer({ offer_id: "after", created_at: "2026-10-01T00:00:00Z" }),
      ],
    })

    expect(projection.rows.map((row) => row.offerId)).toEqual(["1", "2", "10"])
    expect(projection.rows.map((row) => [row.values[22], row.values[23], row.values[24]])).toEqual([
      ["July", 1, 1],
      ["September", 4, 3],
      ["August", 2, 2],
    ])
  })

  test("uses canonical Unknown fallbacks and governed roster HOD attribution", () => {
    const [governed, unresolved] = projectFinalOfferSheet({
      roster,
      quarter: q3,
      rows: [
        offer({ offer_id: "1", hod_id: null, hod_name: null }),
        offer({
          offer_id: "2",
          recruiter_of_record_name: "Not In Roster",
          sourcer_name: "Also Not In Roster",
          hod_id: null,
          hod_name: null,
        }),
      ],
    }).rows

    expect(governed.values[8]).toBe("Team Offer")
    expect(governed.values[28]).toBe("Roster HOD")
    expect(unresolved.values[8]).toBe("Unknown")
    expect(unresolved.values[10]).toBe("Unknown")
    expect(unresolved.values[28]).toBe("Unknown")
  })

  test("reproduces the canonical query's governed exclusion scope", () => {
    const rows = projectFinalOfferSheet({
      roster,
      quarter: q3,
      rows: [
        offer({ offer_id: "1" }),
        offer({ offer_id: "2", application_recruiter_name: "Vikas Mehta" }),
        offer({ offer_id: "3", job_name: "Campus 2025 Hires" }),
        offer({ offer_id: "4", offer_status: "deprecated" }),
        offer({ offer_id: "5", rejection_reason_name: "Duplicate" }),
      ],
    }).rows

    expect(rows.map((row) => row.offerId)).toEqual(["1"])
  })

  test("maps the flat v3 in_process status to the canonical active-offer display", () => {
    const [row] = projectFinalOfferSheet({
      roster,
      quarter: q3,
      rows: [offer({ application_status: "in_process", offer_status: "Created", sent_at: null, resolved_at: null })],
    }).rows

    expect(row.values[1]).toBe("Offer Created")
    expect(row.values[23]).toBe(1)
  })

  test("fails closed on unknown status, invalid quarter, duplicate offers, and negative resolution time", () => {
    expect(() =>
      projectFinalOfferSheet({ rows: [offer({ application_status: "new vendor state" })], roster, quarter: q3 })
    ).toThrow("application status")
    expect(() =>
      projectFinalOfferSheet({
        rows: [offer(), offer()],
        roster,
        quarter: q3,
      })
    ).toThrow("duplicate offer id")
    expect(() =>
      projectFinalOfferSheet({
        rows: [],
        roster,
        quarter: { startDate: "2026-07-02", endDateExclusive: "2026-10-01" },
      })
    ).toThrow("first-of-month")
    expect(() =>
      projectFinalOfferSheet({
        rows: [
          offer({
            created_at: "2026-07-05T00:00:00Z",
            resolved_at: "2026-07-04T00:00:00Z",
          }),
        ],
        roster,
        quarter: q3,
      })
    ).toThrow("cannot precede")
  })
})
