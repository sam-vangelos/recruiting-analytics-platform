import { describe, expect, test } from "vitest"

import {
  evaluateProductionDeliveryPreflight,
  productionDeliveryAdapterContracts,
  type ProductionDeliveryPreflightInput,
} from "../lib/recruiting-ops/production-delivery-adapters"

// REGRESSION LOCK (was RED SPEC) — AUTONOMY-1 / P4: the kill switch is advisory at the wrong layer.
// (the internal control-plane excavation audit (2026-06-26) §3 P4, AUTONOMY-1.)
//
// The kill switch is enforced only inside delivery-gates; the production-delivery
// preflight — the future SEND/WRITE chokepoint that every live execution must clear —
// has NO kill_switch check at all. evaluateProductionDeliveryPreflight is correct in
// isolation (each existing check passes), so the defect is at THIS call site: the
// chokepoint omits the one control that must always be present.
//
// FIX (P4): add a kill_switch check to evaluateProductionDeliveryPreflight (extend
// ProductionDeliveryPreflightCheckId with "kill_switch" and surface it in `checks`,
// failing the preflight whenever the global kill switch is engaged). When fixed, this
// file goes green and moves to test/.
//
// Type-validity note: "kill_switch" is NOT yet a member of
// ProductionDeliveryPreflightCheckId, so we compare against String(c.checkId) rather
// than naming the literal in a typed position. The input is a plain, fully-typed
// ProductionDeliveryPreflightInput — no killSwitches field is added. On HEAD the
// returned checks contain no kill_switch entry, so this FAILS by assertion.

const slackContract = productionDeliveryAdapterContracts.find(
  (item) => item.adapterId === "slack_delivery_disabled"
)!

const baseInput: ProductionDeliveryPreflightInput = {
  contract: slackContract,
  deliverableId: "recruiter_lead_slack_draft",
  runId: "t18_20260624120000000",
  requestedAt: "2026-06-24T12:02:00.000Z",
  requestedBy: "sam",
  readinessState: "ready_for_delivery",
  autonomyState: "auto_delivering",
  externalAdapterApproved: false,
  uiMutationControlEnabled: false,
}

describe("P4: production-delivery preflight must enforce the kill switch at the send chokepoint", () => {
  test("evaluateProductionDeliveryPreflight emits a fail-closed kill_switch check", () => {
    const result = evaluateProductionDeliveryPreflight(baseInput)
    // The chokepoint check must exist AND fail closed — no durable kill-switch store
    // exists until C2, so a "pass" would claim the switch is provably disengaged.
    expect(result.checks.find((c) => String(c.checkId) === "kill_switch")).toMatchObject({
      status: "fail",
    })
  })
})
