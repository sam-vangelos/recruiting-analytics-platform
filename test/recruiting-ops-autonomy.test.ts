import { describe, expect, test } from "vitest"

import {
  createDeliverableAutonomyLookup,
  recipientScopeRules,
  validateDeliverableAutonomyContract,
  validateDeliverableAutonomyContracts,
  validateRecipientScopeRules,
  type DeliverableAutonomyContract,
} from "../lib/recruiting-ops/autonomy"

const weeklyProgressContract = {
  deliverableId: "weekly_progress_sheet",
  capabilityId: "pipeline_movement_intelligence",
  lane: "auto_delivery",
  initialAutonomyState: "shadow",
  eligibleAutonomyStates: ["shadow", "auto_eligible", "auto_paused"],
  readinessStatesAllowed: ["ready_for_review", "ready_with_warnings", "ready_for_delivery", "blocked"],
  recipientScopeRuleIds: ["recruiter_scoped_visibility"],
  freshnessTtlMinutes: 7 * 24 * 60,
  staleBehavior: "block",
  piiPolicy: "public_safe",
  shadowRunRequirement: 4,
  autoEligibility: "candidate",
} as const satisfies DeliverableAutonomyContract

describe("recruiting ops automation autonomy contracts", () => {
  test("validates recipient scope defaults and a valid auto-delivery candidate fixture", () => {
    expect(validateRecipientScopeRules()).toEqual({
      ok: true,
      count: recipientScopeRules.length,
    })

    expect(validateDeliverableAutonomyContract(weeklyProgressContract).ok).toBe(true)
  })

  test("exports lookup helpers over validated autonomy contracts", () => {
    const lookup = createDeliverableAutonomyLookup([weeklyProgressContract])

    expect(lookup.getDeliverableAutonomyContract("weekly_progress_sheet")).toBe(weeklyProgressContract)
    expect(() => lookup.getDeliverableAutonomyContract("missing_deliverable")).toThrow(
      "Unknown deliverable autonomy contract"
    )
  })

  test("rejects missing lane, autonomy state, recipient scope, and freshness policy", () => {
    expect(() =>
      validateDeliverableAutonomyContract({
        ...weeklyProgressContract,
        lane: undefined,
      } as unknown as DeliverableAutonomyContract)
    ).toThrow("lane is invalid")

    expect(() =>
      validateDeliverableAutonomyContract({
        ...weeklyProgressContract,
        initialAutonomyState: undefined,
      } as unknown as DeliverableAutonomyContract)
    ).toThrow("initialAutonomyState is invalid")

    expect(() =>
      validateDeliverableAutonomyContract({
        ...weeklyProgressContract,
        recipientScopeRuleIds: [],
      })
    ).toThrow("recipientScopeRuleIds must not be empty")

    expect(() =>
      validateDeliverableAutonomyContract({
        ...weeklyProgressContract,
        freshnessTtlMinutes: 0,
      })
    ).toThrow("freshnessTtlMinutes must be a positive integer")
  })

  test("requires blocked and never-auto rationales", () => {
    expect(() =>
      validateDeliverableAutonomyContract({
        ...weeklyProgressContract,
        lane: "review_assisted",
        initialAutonomyState: "review_required",
        eligibleAutonomyStates: ["review_required"],
        autoEligibility: "blocked",
      })
    ).toThrow("blockedReason is required")

    expect(() =>
      validateDeliverableAutonomyContract({
        deliverableId: "offer_action_queue",
        capabilityId: "offer_administration",
        lane: "action_proposal",
        initialAutonomyState: "never_auto",
        eligibleAutonomyStates: ["never_auto"],
        readinessStatesAllowed: ["human_only", "blocked"],
        recipientScopeRuleIds: ["admin_action_review"],
        freshnessTtlMinutes: 24 * 60,
        staleBehavior: "block",
        piiPolicy: "public_safe",
        shadowRunRequirement: 0,
        autoEligibility: "never_auto",
      })
    ).toThrow("neverAutoReason is required")
  })

  test("keeps auto-delivering unreachable until an adapter posture is explicitly approved", () => {
    const autoDeliveringContract = {
      ...weeklyProgressContract,
      initialAutonomyState: "auto_delivering",
      eligibleAutonomyStates: ["shadow", "auto_eligible", "auto_delivering"],
    } as const satisfies DeliverableAutonomyContract

    expect(() => validateDeliverableAutonomyContract(autoDeliveringContract)).toThrow(
      "auto_delivering requires an approved external delivery adapter"
    )
    expect(validateDeliverableAutonomyContract(autoDeliveringContract, { approvedExternalDeliveryAdapter: true }).ok).toBe(
      true
    )
  })

  test("validates batches without duplicate deliverable autonomy contracts", () => {
    expect(validateDeliverableAutonomyContracts([weeklyProgressContract])).toEqual({
      ok: true,
      count: 1,
    })
    expect(() => validateDeliverableAutonomyContracts([weeklyProgressContract, weeklyProgressContract])).toThrow(
      "Duplicate deliverable autonomy contract"
    )
  })
})
