import { describe, expect, test } from "vitest"

import {
  buildOfferLifecycleExportRow,
  emitOfferLifecycleExportRows,
  type OfferLifecycleExportSource,
} from "../lib/recruiting-ops/delivery-source/offer-lifecycle-export"

const completeSource: OfferLifecycleExportSource = {
  offer: {
    id: 7001,
    applicationId: 101,
    candidateId: 501,
    jobId: 900,
    status: " accepted ",
    createdAt: "2026-07-01T10:00:00-07:00",
    sentAt: "2026-07-02T18:00:00Z",
    resolvedAt: "2026-07-03T19:30:00Z",
    startDate: "2026-07-20",
    recruiterOfRecord: { id: 21, name: " Recruiter One " },
    createdBy: { id: 22, name: "Offer Creator" },
    approver: { id: 23, name: "Approver One" },
    customFields: [
      { key: "comp_band", name: "Comp Band", type: "single_select", value: "B4" },
    ],
  },
  application: {
    id: "101",
    candidateId: "501",
    jobId: "900",
    status: "hired",
    stage: "Offer",
    rejection: {
      reasonId: 44,
      reasonName: "Candidate declined",
      type: "candidate",
      rejectedAt: "2026-07-03T19:30:00Z",
    },
    customFields: [
      { name: "Referral", type: "boolean", value: false },
    ],
  },
  candidate: {
    id: 501,
    name: "Candidate One",
    source: { id: "src_1", name: "Referral", type: "prospecting" },
    customFields: [
      { key: "availability", name: "Availability", value: { weeks: 2, notes: null } },
    ],
  },
  job: {
    id: 900,
    requisitionId: 1027,
    name: "Research Engineer",
    detailedTitle: "Research Engineer, RL Gyms - US",
    status: "open",
    level: "IC",
    departmentName: "R&D / Engineering",
    hiringLocation: "US - Remote",
    customFields: [
      { key: "priority", name: "Priority", type: "multi_select", value: ["P1"] },
    ],
  },
  sourcer: { id: 24, name: "Sourcer One" },
  hod: { id: 25, name: "HOD One" },
}

describe("offer lifecycle delivery-source emit", () => {
  test("emits the joined artifact-agnostic offer lifecycle contract", () => {
    expect(buildOfferLifecycleExportRow(completeSource)).toEqual({
      source_system: "greenhouse",
      offer_id: "7001",
      offer_status: "accepted",
      application_id: "101",
      application_status: "hired",
      application_stage: "Offer",
      application_recruiter_id: null,
      application_recruiter_name: null,
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
      recruiter_of_record_name: "Recruiter One",
      sourcer_id: "24",
      sourcer_name: "Sourcer One",
      hod_id: "25",
      hod_name: "HOD One",
      created_by_id: "22",
      created_by_name: "Offer Creator",
      approver_id: "23",
      approver_name: "Approver One",
      rejection_reason_id: "44",
      rejection_reason_name: "Candidate declined",
      rejection_type: "candidate",
      rejected_at: "2026-07-03T19:30:00.000Z",
      candidate_source_id: "src_1",
      candidate_source_name: "Referral",
      candidate_source_type: "prospecting",
      created_at: "2026-07-01T17:00:00.000Z",
      sent_at: "2026-07-02T18:00:00.000Z",
      resolved_at: "2026-07-03T19:30:00.000Z",
      start_date: "2026-07-20",
      custom_field_metadata: [
        {
          entity: "application",
          key: "Referral",
          name: "Referral",
          type: "boolean",
          value: false,
        },
        {
          entity: "candidate",
          key: "availability",
          name: "Availability",
          type: null,
          value: { notes: null, weeks: 2 },
        },
        {
          entity: "job",
          key: "priority",
          name: "Priority",
          type: "multi_select",
          value: ["P1"],
        },
        {
          entity: "offer",
          key: "comp_band",
          name: "Comp Band",
          type: "single_select",
          value: "B4",
        },
      ],
    })
  })

  test("does not substitute an application recruiter for missing offer-letter attribution", () => {
    const row = buildOfferLifecycleExportRow({
      ...completeSource,
      offer: { ...completeSource.offer, recruiterOfRecord: null },
    })

    expect(row.recruiter_of_record_id).toBeNull()
    expect(row.recruiter_of_record_name).toBeNull()
  })

  test("fails closed when joined entity identities conflict", () => {
    expect(() =>
      buildOfferLifecycleExportRow({
        ...completeSource,
        offer: { ...completeSource.offer, applicationId: "different_application" },
      })
    ).toThrow("offer.applicationId different_application does not match joined id 101")
  })

  test("normalizes optional blanks and rejects malformed dates", () => {
    const row = buildOfferLifecycleExportRow({
      ...completeSource,
      offer: {
        ...completeSource.offer,
        sentAt: " ",
        resolvedAt: null,
        startDate: null,
        createdBy: { name: " " },
      },
      application: { ...completeSource.application, rejection: null },
      candidate: { ...completeSource.candidate, source: null },
    })
    expect(row.sent_at).toBeNull()
    expect(row.resolved_at).toBeNull()
    expect(row.start_date).toBeNull()
    expect(row.created_by_name).toBeNull()
    expect(row.rejection_reason_id).toBeNull()
    expect(row.candidate_source_name).toBeNull()

    expect(() =>
      buildOfferLifecycleExportRow({
        ...completeSource,
        offer: { ...completeSource.offer, resolvedAt: "not-a-timestamp" },
      })
    ).toThrow("offer.resolvedAt must be a valid timestamp")
  })

  test("sorts rows deterministically and rejects duplicate offer identities", () => {
    const later = {
      ...completeSource,
      offer: { ...completeSource.offer, id: "offer_b" },
    }
    const earlier = {
      ...completeSource,
      offer: { ...completeSource.offer, id: "offer_a" },
    }
    expect(emitOfferLifecycleExportRows([later, earlier]).map((row) => row.offer_id)).toEqual([
      "offer_a",
      "offer_b",
    ])
    expect(() => emitOfferLifecycleExportRows([completeSource, completeSource])).toThrow(
      "Duplicate offer lifecycle source for offer_id 7001"
    )
  })
})
