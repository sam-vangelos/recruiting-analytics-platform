import { describe, expect, test } from "vitest"

import { validateDiscrepancy, type Discrepancy } from "../lib/recruiting-ops/discrepancies"

// REGRESSION LOCK (was RED SPEC) — population P6 / CAPABILITY-SPINE-3: capability provenance is required on
// the run (CommandCenterRun.capabilityId is non-optional and validateCommandCenterRun
// asserts it) but optional + UNVALIDATED on the nested records that the run is built
// from — Discrepancy, SourceGap, RunArtifact.
// (the internal control-plane excavation audit (2026-06-26) — P6/CAPABILITY-SPINE-3.)
//
// On HEAD, `Discrepancy.capabilityId` is `capabilityId?: string` (discrepancies.ts:19)
// and `validateDiscrepancy` (discrepancies.ts:52-76) never checks it. So a discrepancy
// authored without a capability sails through validation. The run builder back-fills
// capabilityId onto artifacts and source gaps (runs.ts:116-117) but NOT onto
// discrepancies — they are only summarized — so an unattributed discrepancy can be
// validated and surfaced with no capability provenance at all.
//
// FIX (P6): make capabilityId required-and-validated on every nested record. Each
// validator (validateDiscrepancy / validateSourceGap / validateRunArtifact) must assert
// a non-empty capabilityId, mirroring validateCommandCenterRun (runs.ts:139). When fixed,
// this file goes green and moves to test/.
//
// Post-fix note: capabilityId is now REQUIRED on Discrepancy, so authoring this fixture
// takes an explicit unsafe cast — the type system already refuses the omission; this lock
// proves the RUNTIME validator refuses it too (hand-built records bypassing the types).

// A fully-formed, otherwise-valid discrepancy that lacks capability provenance.
const discrepancyWithoutCapability = {
  id: "disc_p6_no_capability",
  runId: "t07_20260624010101000",
  workflowId: "T07",
  // capabilityId intentionally omitted — the spine defect under test.
  class: "source_gap",
  severity: "blocking",
  entityKey: "application:123",
  field: "offer_status",
  modernValueSummary: "missing status source",
  legacyValueSummary: "legacy artifact has populated status",
  evidenceRefs: ["legacy_q12_final_offer"],
  resolutionStatus: "open",
  owner: "Jordan",
} as unknown as Discrepancy

describe("P6: nested records must carry validated capability provenance", () => {
  test("validateDiscrepancy rejects a discrepancy with no capabilityId", () => {
    expect(discrepancyWithoutCapability.capabilityId).toBeUndefined()
    // Every record persisted off a run must be capability-attributed, same as the run.
    expect(() => validateDiscrepancy(discrepancyWithoutCapability)).toThrow(/capabilityId/)
  })
})
