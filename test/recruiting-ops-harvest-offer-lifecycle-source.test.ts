import { describe, expect, test, vi } from "vitest"

import {
  mapHarvestToOfferLifecycleExportSources,
  type HarvestOfferLifecycleJoinInput,
} from "../lib/recruiting-ops/delivery-source/harvest-offer-lifecycle-source"
import { emitOfferLifecycleExportRows } from "../lib/recruiting-ops/delivery-source/offer-lifecycle-export"

function completeInput(): HarvestOfferLifecycleJoinInput {
  return {
    offers: [
      {
        id: 7001,
        application_id: 101,
        candidate_id: 501,
        job_id: 900,
        status: "accepted",
        created_at: "2026-07-01T10:00:00Z",
        sent_at: "2026-07-02T10:00:00Z",
        resolved_at: "2026-07-03T10:00:00Z",
        start_date: "2026-07-20",
        recruiter: { id: 999, name: "Associated Candidate Recruiter" },
        created_by_id: 22,
        custom_fields: {
          recruiter_of_record_offer_100: {
            name: "Recruiter of Record",
            type: "user",
            value: { id: 21, name: "Offer Letter Recruiter" },
          },
          comp_band_offer_101: { name: "Comp Band", type: "single_select", value: "B4" },
        },
      },
    ],
    applications: [
      {
        id: 101,
        candidate_id: 501,
        job_id: 900,
        status: "hired",
        stage_name: "Offer",
        source_id: 77,
        referrer_id: 88,
        recruiter: { id: 998, name: "Application Recruiter" },
        custom_fields: {
          referral_application_1: { name: "Referral", type: "boolean", value: false },
        },
      },
    ],
    candidates: [
      {
        id: 501,
        first_name: "Candidate",
        last_name: "One",
        custom_fields: {
          availability_candidate_1: {
            name: "Availability",
            value: { weeks: 2, notes: null },
          },
        },
      },
    ],
    jobs: [
      {
        id: 900,
        requisition_id: 1027,
        name: "Research Engineer",
        status: "open",
        department_id: 30,
        custom_fields: {
          detailed_title_job_1: {
            name: "Detailed Job Title",
            type: "short_text",
            value: "Research Engineer, RL Gyms - US",
          },
          job_level_job_2: { name: "Job Level", type: "single_select", value: "IC" },
          hiring_location_s_job_3: {
            name: "Hiring Location(s)",
            type: "multi_select",
            value: ["US - Remote"],
          },
        },
      },
    ],
    users: [
      { id: 21, name: "Offer Letter Recruiter" },
      { id: 22, name: "Offer Creator" },
      { id: 23, name: "Final Approver" },
      { id: 24, name: "Responsible Sourcer" },
    ],
    departments: [{ id: 30, name: "R&D / Engineering" }],
    sources: [{ id: 77, public_name: "Employee Referral", type: { name: "Referral" } }],
    referrers: [{ id: 88, user_id: 24, name: "Responsible Sourcer" }],
    rejectionDetails: [
      { application_id: 101, rejection_reason_id: 44, rejected_at: "2026-07-03T10:00:00Z" },
    ],
    rejectionReasons: [{ id: 44, name: "Candidate declined", type: { name: "candidate" } }],
    offerApprovers: [
      {
        offer_id: 7001,
        approved_by_id: 23,
        approved_at: "2026-07-03T09:00:00Z",
        status: "approved",
      },
    ],
    recruiterRoster: [
      {
        recruiterName: "Offer Letter Recruiter",
        teamId: "team_offer",
        teamName: "Offer Team",
        hodName: "Governed HOD",
      },
    ],
  }
}

describe("Harvest offer lifecycle source join", () => {
  test("joins flat v3 records and derives governed lifecycle attribution", () => {
    const sources = mapHarvestToOfferLifecycleExportSources(completeInput())
    const rows = emitOfferLifecycleExportRows(sources)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source_system: "greenhouse",
      offer_id: "7001",
      application_id: "101",
      application_recruiter_id: "998",
      application_recruiter_name: "Application Recruiter",
      candidate_id: "501",
      candidate_name: "Candidate One",
      job_id: "900",
      requisition_id: "1027",
      job_name: "Research Engineer",
      detailed_job_title: "Research Engineer, RL Gyms - US",
      job_level: "IC",
      department_name: "R&D / Engineering",
      hiring_location: "US - Remote",
      recruiter_of_record_id: "21",
      recruiter_of_record_name: "Offer Letter Recruiter",
      sourcer_id: "24",
      sourcer_name: "Responsible Sourcer",
      hod_name: "Governed HOD",
      created_by_id: "22",
      created_by_name: "Offer Creator",
      approver_id: "23",
      approver_name: "Final Approver",
      rejection_reason_id: "44",
      rejection_reason_name: "Candidate declined",
      rejection_type: "candidate",
      candidate_source_id: "77",
      candidate_source_name: "Employee Referral",
      candidate_source_type: "Referral",
    })
    expect(rows[0].custom_field_metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: "offer", key: "comp_band_offer_101", value: "B4" }),
        expect.objectContaining({ entity: "application", key: "referral_application_1", value: false }),
        expect.objectContaining({ entity: "candidate", key: "availability_candidate_1" }),
        expect.objectContaining({ entity: "job", key: "job_level_job_2", value: "IC" }),
      ])
    )
  })

  test("never falls back to offer-associated or application recruiter ownership", () => {
    const input = completeInput()
    const sources = mapHarvestToOfferLifecycleExportSources({
      ...input,
      offers: [
        {
          ...input.offers[0],
          recruiter: { id: 999, name: "Associated Candidate Recruiter" },
          custom_fields: { comp_band_offer_101: { name: "Comp Band", value: "B4" } },
        },
      ],
      recruiterRoster: [
        {
          recruiterName: "Application Recruiter",
          teamId: "wrong_team",
          teamName: "Wrong Team",
          hodName: "Wrong HOD",
        },
      ],
    })
    const [row] = emitOfferLifecycleExportRows(sources)

    expect(row.recruiter_of_record_id).toBeNull()
    expect(row.recruiter_of_record_name).toBeNull()
    expect(row.hod_name).toBeNull()
  })

  test("uses an explicit governed department-HOD mapping ahead of recruiter roster", () => {
    const input = completeInput()
    const [row] = emitOfferLifecycleExportRows(
      mapHarvestToOfferLifecycleExportSources({
        ...input,
        departmentHods: [
          { department_id: 30, department_name: "R&D / Engineering", hod_id: 25, hod_name: "Dept HOD" },
        ],
      })
    )

    expect(row.hod_id).toBe("25")
    expect(row.hod_name).toBe("Dept HOD")
  })

  test("fails closed on missing joins and duplicate dimensions", () => {
    const input = completeInput()
    expect(() =>
      mapHarvestToOfferLifecycleExportSources({ ...input, candidates: [] })
    ).toThrow("Harvest offer lifecycle join is missing a candidate")

    expect(() =>
      mapHarvestToOfferLifecycleExportSources({
        ...input,
        users: [...(input.users ?? []), { id: 24, name: "Duplicate Sourcer" }],
      })
    ).toThrow("duplicate user ids")

    expect(() =>
      mapHarvestToOfferLifecycleExportSources({
        ...input,
        referrers: [...(input.referrers ?? []), { id: 88, user_id: 23 }],
      })
    ).toThrow("duplicate referrer ids")
  })

  test("uses the application referrer for the legacy sourcer column", () => {
    const input = completeInput()
    const [row] = emitOfferLifecycleExportRows(
      mapHarvestToOfferLifecycleExportSources(input)
    )

    expect(row.sourcer_id).toBe("24")
    expect(row.sourcer_name).toBe("Responsible Sourcer")
  })

  test("uses the v3 rejection type key when the display name is absent", () => {
    const input = completeInput()
    const [row] = emitOfferLifecycleExportRows(
      mapHarvestToOfferLifecycleExportSources({
        ...input,
        rejectionReasons: [{ id: 44, name: "Candidate declined", type: { key: "they_rejected_us" } }],
      })
    )

    expect(row.rejection_type).toBe("they rejected us")
  })

  test("does not log source or custom-field values", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

    try {
      mapHarvestToOfferLifecycleExportSources(completeInput())
      expect(log).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
      warn.mockRestore()
      error.mockRestore()
    }
  })
})
