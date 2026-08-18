import { beforeEach, describe, expect, test } from "vitest"

import { PII_FINGERPRINT_SALT_ENV } from "../lib/recruiting-ops/checksums"
import {
  buildProjectedDeliveryRpsValuePlan,
  buildStagingSheetValuePlan,
  normalizeStagingSheetScalar,
} from "../lib/recruiting-ops/delivery/staging-value-plan"

describe("staging value plan", () => {
  beforeEach(() => {
    process.env[PII_FINGERPRINT_SALT_ENV] = "test-live-hmac-key"
  })

  test("creates PII-safe preimage/payload evidence and a changed write", () => {
    const plan = buildStagingSheetValuePlan({
      artifactKey: "all_hires",
      runId: "hydration_1",
      sourceGeneratedAt: "2026-07-11T12:00:00Z",
      structureHash: `sha256:${"a".repeat(64)}`,
      dataProvenance: "live",
      ranges: [
        {
          rangeId: "all_hires_data",
          a1Range: "'Data sheet'!A2:I2",
          currentValues: [["Old Person", "Job", null, null, null, null, null, null, null]],
          desiredValues: [["New Person", "Job", null, null, null, null, null, null, null]],
        },
      ],
    })
    expect(plan.noOp).toBe(false)
    expect(plan.payloadFingerprint).toMatch(/^hmac-sha256:/)
    expect(plan.writes[0].preimageFingerprint).toMatch(/^hmac-sha256:/)
    expect(JSON.stringify({
      payloadFingerprint: plan.payloadFingerprint,
      preimageFingerprint: plan.writes[0].preimageFingerprint,
    })).not.toContain("Person")
  })

  test("marks an identical rerun as a no-op", () => {
    const rows = [["same", 1]] as const
    const plan = buildStagingSheetValuePlan({
      artifactKey: "rps_tracking",
      runId: "hydration_2",
      sourceGeneratedAt: "2026-07-11T12:00:00Z",
      structureHash: `sha256:${"b".repeat(64)}`,
      dataProvenance: "fixture",
      ranges: [{ rangeId: "rps_data_dump", a1Range: "'Data Dump'!A2:B2", currentValues: rows, desiredValues: rows }],
    })
    expect(plan.noOp).toBe(true)
    expect(plan.writes[0].changed).toBe(false)
  })

  test("certifies a Delivery projection without exposing a write-authorizing structure hash", () => {
    const structure = {
      kind: "projected_post_normalization" as const,
      normalizationId: "delivery_rps_dated_rollover_20260721",
      normalizationFingerprint: `sha256:${"1".repeat(64)}`,
      observedDriveVersion: "62",
      observedStructureFingerprint: `sha256:${"2".repeat(64)}`,
      expectedAfterStateFingerprint: `sha256:${"3".repeat(64)}`,
      forwardRequestsFingerprint: `sha256:${"4".repeat(64)}`,
      rollbackRequestsFingerprint: `sha256:${"5".repeat(64)}`,
    }
    const input = {
      runId: "delivery_projected_dry_run",
      sourceGeneratedAt: "2026-07-22T06:30:00.000Z",
      structure,
      dataProvenance: "live" as const,
      ranges: [
        {
          rangeId: "delivery_rps_raw" as const,
          a1Range: "'Raw_Daily_RPS'!A2:T2",
          currentValues: [[null]],
          desiredValues: [[null]],
        },
        {
          rangeId: "delivery_rps_clean" as const,
          a1Range: "'Cleaned_RPS'!A2:T2",
          currentValues: [[null]],
          desiredValues: [[null]],
        },
        {
          rangeId: "delivery_rps_dated" as const,
          a1Range: "'21 Jul 2026'!A3:N4",
          currentValues: [["Summary by Team", null], ["Team", "Total RPS"]],
          desiredValues: [["Summary by Team", null], ["Team", "Total RPS"]],
        },
      ],
    }

    const plan = buildProjectedDeliveryRpsValuePlan(input)
    const drifted = buildProjectedDeliveryRpsValuePlan({
      ...input,
      structure: { ...structure, forwardRequestsFingerprint: `sha256:${"6".repeat(64)}` },
    })

    expect(plan).toMatchObject({
      kind: "projected_dry_run",
      artifactKey: "delivery_roles_rps",
      noOp: true,
      structure,
    })
    expect(plan).not.toHaveProperty("structureHash")
    expect(plan.planFingerprint).toMatch(/^hmac-sha256:[a-f0-9]{64}$/)
    expect(plan.projectedPreimageFingerprint).toMatch(/^hmac-sha256:[a-f0-9]{64}$/)
    expect(plan.desiredPayloadFingerprint).toMatch(/^hmac-sha256:[a-f0-9]{64}$/)
    expect(drifted.planFingerprint).not.toBe(plan.planFingerprint)
  })

  test("rejects an incomplete projected structural basis", () => {
    expect(() => buildProjectedDeliveryRpsValuePlan({
      runId: "delivery_projected_invalid",
      sourceGeneratedAt: "2026-07-22T06:30:00.000Z",
      structure: {
        kind: "projected_post_normalization",
        normalizationId: "delivery_rps_dated_rollover_20260721",
        normalizationFingerprint: "not-a-fingerprint",
        observedDriveVersion: "62",
        observedStructureFingerprint: `sha256:${"2".repeat(64)}`,
        expectedAfterStateFingerprint: `sha256:${"3".repeat(64)}`,
        forwardRequestsFingerprint: `sha256:${"4".repeat(64)}`,
        rollbackRequestsFingerprint: `sha256:${"5".repeat(64)}`,
      },
      dataProvenance: "live",
      ranges: [{
        rangeId: "delivery_rps_dated",
        a1Range: "'21 Jul 2026'!A3:N4",
        currentValues: [[null]],
        desiredValues: [[null]],
      }],
    })).toThrow("structure basis is incomplete")
  })

  test("normalizes equivalent blank and signed-zero scalars before fingerprinting", () => {
    const plan = buildStagingSheetValuePlan({
      artifactKey: "all_hires",
      runId: "hydration_normalized_scalars",
      sourceGeneratedAt: "2026-07-11T12:00:00Z",
      structureHash: `sha256:${"d".repeat(64)}`,
      dataProvenance: "fixture",
      ranges: [{
        rangeId: "all_hires_data",
        a1Range: "'Data sheet'!A2:B2",
        currentValues: [["", -0]],
        desiredValues: [[null, 0]],
      }],
    })

    expect(plan.noOp).toBe(true)
    expect(plan.writes[0].values).toEqual([[null, 0]])
    expect(Object.is(plan.writes[0].values[0][1], -0)).toBe(false)
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite scalar %s",
    (value) => {
      expect(() => normalizeStagingSheetScalar(value)).toThrow("non-finite number")
    }
  )

  test.each([undefined, new Date("2026-07-11T12:00:00Z"), { value: "not a scalar" }])(
    "rejects unsupported runtime scalar %#",
    (value) => {
      expect(() => normalizeStagingSheetScalar(value as never)).toThrow("unsupported scalar")
    }
  )

  test.each([
    ["unbounded range", "'Data Dump'!A:R"],
    ["missing tab", "A2:R2"],
  ])("rejects %s", (_label, a1Range) => {
    expect(() =>
      buildStagingSheetValuePlan({
        artifactKey: "rps_tracking",
        runId: "hydration_3",
        sourceGeneratedAt: "2026-07-11T12:00:00Z",
        structureHash: `sha256:${"c".repeat(64)}`,
        dataProvenance: "fixture",
        ranges: [{ rangeId: "rps_data_dump", a1Range, currentValues: [[1]], desiredValues: [[2]] }],
      })
    ).toThrow("bounded A1")
  })
})
