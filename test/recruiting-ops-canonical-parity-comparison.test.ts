import { describe, expect, test } from "vitest"

import {
  CANONICAL_PARITY_MATRIX_EVIDENCE_LIMIT,
  compareCanonicalParity,
  type CanonicalParityPayload,
} from "../lib/recruiting-ops/delivery/canonical-parity-comparison"
import { inspectPublicValue } from "../lib/recruiting-ops/safe-public-output"

const fingerprintKey = "parity-test-secret-that-must-not-escape"
const evidenceFingerprint = `sha256:${"a".repeat(64)}`

function matrix(values: readonly (readonly (string | number | boolean | null)[])[]): CanonicalParityPayload {
  return { kind: "matrix", values }
}

function doc(text: string): CanonicalParityPayload {
  return { kind: "doc_text", text }
}

describe("canonical parity comparison", () => {
  test("classifies an all-three-identical matrix as exact-match", () => {
    const values = [
      ["Header", "Status"],
      ["Role", "Open"],
    ] as const
    const report = compareCanonicalParity({
      artifactKey: "weekly_recruitment",
      fingerprintKey,
      surfaces: [
        {
          surfaceId: "weekly_working_a_z",
          matrixStartCell: "A1",
          canonical: matrix(values),
          copied: matrix(values),
          platform: matrix(values),
        },
      ],
    })

    expect(report.readOnly).toBe(true)
    expect(report.canonicalWriteAuthorized).toBe(false)
    expect(report.classificationCounts).toEqual({
      "exact-match": 1,
      "platform-correct": 0,
      "legacy-error": 0,
      "needs-investigation": 0,
    })
    expect(report.surfaces[0]).toMatchObject({
      classification: "exact-match",
      mismatchCounts: {
        canonicalToCopied: 0,
        canonicalToPlatform: 0,
        copiedToPlatform: 0,
      },
      counts: {
        canonical: { kind: "matrix", rowCount: 2, columnCount: 2, cellCount: 4 },
        copied: { kind: "matrix", rowCount: 2, columnCount: 2, cellCount: 4 },
        platform: { kind: "matrix", rowCount: 2, columnCount: 2, cellCount: 4 },
      },
    })
    expect(report.surfaces[0]?.canonicalFingerprint).toBe(report.surfaces[0]?.copiedFingerprint)
    expect(report.surfaces[0]?.copiedFingerprint).toBe(report.surfaces[0]?.platformFingerprint)
    expect(report.surfaces[0]?.canonicalFingerprint).toBe(
      "hmac-sha256:7f543cdd9594f5eed068a7d31d5139df59c5ac130431b220e5f33cc379ff2ea9"
    )
    expect(report.matrixMismatchEvidence).toEqual({
      comparison: "canonical-to-platform",
      limit: CANONICAL_PARITY_MATRIX_EVIDENCE_LIMIT,
      totalMismatchCount: 0,
      returnedMismatchCount: 0,
      truncated: false,
      entries: [],
    })
  })

  test.each([
    ["platform-correct", "platform-correct"],
    ["legacy-error", "legacy-error"],
  ] as const)("requires fingerprinted adjudication for %s", (approved, expected) => {
    const report = compareCanonicalParity({
      artifactKey: "all_hires",
      fingerprintKey,
      surfaces: [
        {
          surfaceId: "data_a_i",
          matrixStartCell: "A1",
          canonical: matrix([["June 2026", 1]]),
          copied: matrix([["June 2026", 10]]),
          platform: matrix([["June 2026", 10]]),
          approvedDivergence: {
            classification: approved,
            evidenceFingerprint,
          },
        },
      ],
    })

    expect(report.surfaces[0]?.classification).toBe(expected)
    expect(report.surfaces[0]?.divergenceEvidenceFingerprint).toBe(evidenceFingerprint)
    expect(report.surfaces[0]?.mismatchCounts).toEqual({
      canonicalToCopied: 1,
      canonicalToPlatform: 1,
      copiedToPlatform: 0,
    })
  })

  test("returns exact row-major A1 coordinates, typed categories, and keyed fingerprints without raw values", () => {
    const privateCanonical = [
      ["Candidate Alpha", 7, "private note"],
      [true, null, null],
    ] as const
    const privatePlatform = [
      ["candidate.alpha@example.test", "7"],
      [false, null],
    ] as const
    const report = compareCanonicalParity({
      artifactKey: "weekly_recruitment",
      fingerprintKey,
      surfaces: [{
        surfaceId: "weekly_recruitment_e_f",
        matrixStartCell: "E7",
        canonical: matrix(privateCanonical),
        copied: matrix(privatePlatform),
        platform: matrix(privatePlatform),
      }],
    })

    expect(report.surfaces[0]?.mismatchCounts).toEqual({
      canonicalToCopied: 5,
      canonicalToPlatform: 5,
      copiedToPlatform: 0,
    })
    expect(report.matrixMismatchEvidence).toMatchObject({
      totalMismatchCount: 5,
      returnedMismatchCount: 5,
      truncated: false,
      entries: [
        { surfaceId: "weekly_recruitment_e_f", coordinate: "E7", beforeCategory: "string", afterCategory: "string" },
        { surfaceId: "weekly_recruitment_e_f", coordinate: "F7", beforeCategory: "number", afterCategory: "string" },
        { surfaceId: "weekly_recruitment_e_f", coordinate: "G7", beforeCategory: "string", afterCategory: "missing" },
        { surfaceId: "weekly_recruitment_e_f", coordinate: "E8", beforeCategory: "boolean", afterCategory: "boolean" },
        { surfaceId: "weekly_recruitment_e_f", coordinate: "G8", beforeCategory: "null", afterCategory: "missing" },
      ],
    })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain("Candidate Alpha")
    expect(serialized).not.toContain("candidate.alpha@example.test")
    expect(serialized).not.toContain("private note")
    expect(serialized).not.toContain(fingerprintKey)
    expect(report.matrixMismatchEvidence.entries.every(
      (entry) =>
        /^hmac-sha256:[a-f0-9]{64}$/.test(entry.beforeFingerprint) &&
        /^hmac-sha256:[a-f0-9]{64}$/.test(entry.afterFingerprint) &&
        entry.beforeFingerprint !== entry.afterFingerprint
    )).toBe(true)
    expect(inspectPublicValue(report).ok).toBe(true)
  })

  test("orders coordinate evidence deterministically across surfaces and repeated runs", () => {
    const input = {
      artifactKey: "weekly_recruitment" as const,
      fingerprintKey,
      surfaces: [
        {
          surfaceId: "weekly_recruitment_a_c",
          matrixStartCell: "Y10",
          canonical: matrix([[1, 2], [3, 4]]),
          copied: matrix([[0, 2], [0, 0]]),
          platform: matrix([[0, 2], [0, 0]]),
        },
        {
          surfaceId: "weekly_recruitment_y_z",
          matrixStartCell: "AA2",
          canonical: matrix([[true]]),
          copied: matrix([[false]]),
          platform: matrix([[false]]),
        },
      ],
    }

    const first = compareCanonicalParity(input)
    const second = compareCanonicalParity(input)
    expect(first.matrixMismatchEvidence.entries.map((entry) => entry.coordinate)).toEqual([
      "Y10",
      "Y11",
      "Z11",
      "AA2",
    ])
    expect(second.matrixMismatchEvidence).toEqual(first.matrixMismatchEvidence)
  })

  test("retains a synthetic 444-mismatch capacity case across the five governed origins", () => {
    const specs = [
      ["weekly_recruitment_a_c", "A2", 3, 61],
      ["weekly_recruitment_e_f", "E2", 2, 47],
      ["weekly_recruitment_h_i", "H2", 2, 16],
      ["weekly_recruitment_m_w", "M2", 11, 268],
      ["weekly_recruitment_y_z", "Y2", 2, 52],
    ] as const
    const surfaces = specs.map(([surfaceId, matrixStartCell, columns, mismatchCount]) => {
      const canonical = Array.from(
        { length: 171 },
        (_, row) => Array.from({ length: columns }, (__, column) => row * columns + column)
      )
      const platform = canonical.map((row) => [...row])
      for (let index = 0; index < mismatchCount; index += 1) {
        const row = Math.floor(index / columns)
        const column = index % columns
        platform[row][column] += 1
      }
      return {
        surfaceId,
        matrixStartCell,
        canonical: matrix(canonical),
        copied: matrix(platform),
        platform: matrix(platform),
      }
    })
    const complete = compareCanonicalParity({
      artifactKey: "weekly_recruitment",
      fingerprintKey,
      surfaces,
    })
    expect(complete.matrixMismatchEvidence).toMatchObject({
      totalMismatchCount: 444,
      returnedMismatchCount: 444,
      truncated: false,
    })
    expect(complete.surfaces.map((surface) => surface.mismatchCounts.canonicalToPlatform)).toEqual(
      specs.map(([, , , mismatchCount]) => mismatchCount)
    )
    expect(
      complete.surfaces.every((surface) => surface.classification === "needs-investigation")
    ).toBe(true)
    expect(
      complete.matrixMismatchEvidence.entries
        .filter((__, index) => [0, 61, 108, 124, 392, 443].includes(index))
        .map((entry) => entry.coordinate)
    ).toEqual(["A2", "E2", "H2", "M2", "Y2", "Z27"])
    expect(inspectPublicValue(complete).ok).toBe(true)
  })

  test("bounds coordinate evidence and fails approved classification closed when truncated", () => {
    const canonical = Array.from(
      { length: CANONICAL_PARITY_MATRIX_EVIDENCE_LIMIT + 1 },
      (_, index) => [index]
    )
    const platform = canonical.map(([value]) => [value + 1])
    const report = compareCanonicalParity({
      artifactKey: "weekly_recruitment",
      fingerprintKey,
      surfaces: [{
        surfaceId: "weekly_recruitment_a_c",
        matrixStartCell: "A1",
        canonical: matrix(canonical),
        copied: matrix(platform),
        platform: matrix(platform),
        approvedDivergence: {
          classification: "legacy-error",
          evidenceFingerprint,
        },
      }],
    })

    expect(report.matrixMismatchEvidence).toMatchObject({
      limit: CANONICAL_PARITY_MATRIX_EVIDENCE_LIMIT,
      totalMismatchCount: CANONICAL_PARITY_MATRIX_EVIDENCE_LIMIT + 1,
      returnedMismatchCount: CANONICAL_PARITY_MATRIX_EVIDENCE_LIMIT,
      truncated: true,
    })
    expect(report.matrixMismatchEvidence.entries).toHaveLength(
      CANONICAL_PARITY_MATRIX_EVIDENCE_LIMIT
    )
    expect(report.matrixMismatchEvidence.entries.at(-1)?.coordinate).toBe(
      `A${CANONICAL_PARITY_MATRIX_EVIDENCE_LIMIT}`
    )
    expect(report.surfaces[0]?.classification).toBe("needs-investigation")
  })

  test("fails unadjudicated or non-reproduced drift to needs-investigation", () => {
    const report = compareCanonicalParity({
      artifactKey: "pipeline_890",
      fingerprintKey,
      surfaces: [
        {
          surfaceId: "candidate_level_data",
          matrixStartCell: "A1",
          canonical: matrix([["canonical"]]),
          copied: matrix([["platform"]]),
          platform: matrix([["platform"]]),
        },
        {
          surfaceId: "job_summary",
          matrixStartCell: "A1",
          canonical: matrix([[1]]),
          copied: matrix([[2]]),
          platform: matrix([[3]]),
          approvedDivergence: {
            classification: "platform-correct",
            evidenceFingerprint,
          },
        },
        {
          surfaceId: "candidate_filter",
          matrixStartCell: "A1",
          canonical: matrix([[true]]),
          copied: matrix([[true]]),
          platform: matrix([[false]]),
        },
      ],
    })

    expect(report.classificationCounts["needs-investigation"]).toBe(3)
    expect(report.surfaces.map((surface) => surface.classification)).toEqual([
      "needs-investigation",
      "needs-investigation",
      "needs-investigation",
    ])
  })

  test("compares document text without returning text or the fingerprint secret", () => {
    const privateCanonical = "Candidate Alpha\nalpha@example.test"
    const privatePlatform = "Candidate Beta\nbeta@example.test"
    const report = compareCanonicalParity({
      artifactKey: "elt_doc",
      fingerprintKey,
      surfaces: [
        {
          surfaceId: "elt_body",
          canonical: doc(privateCanonical),
          copied: doc(privatePlatform),
          platform: doc(privatePlatform),
          approvedDivergence: {
            classification: "platform-correct",
            evidenceFingerprint,
          },
        },
      ],
    })
    const serialized = JSON.stringify(report)

    expect(report.surfaces[0]?.counts).toEqual({
      canonical: { kind: "doc_text", lineCount: 2, characterCount: 34 },
      copied: { kind: "doc_text", lineCount: 2, characterCount: 32 },
      platform: { kind: "doc_text", lineCount: 2, characterCount: 32 },
    })
    expect(report.surfaces[0]?.mismatchCounts.copiedToPlatform).toBe(0)
    expect(serialized).not.toContain("Candidate Alpha")
    expect(serialized).not.toContain("alpha@example.test")
    expect(serialized).not.toContain("Candidate Beta")
    expect(serialized).not.toContain("beta@example.test")
    expect(serialized).not.toContain(fingerprintKey)
    expect(serialized).toMatch(/hmac-sha256:[a-f0-9]{64}/)
    expect(report.matrixMismatchEvidence).toMatchObject({
      totalMismatchCount: 0,
      returnedMismatchCount: 0,
      truncated: false,
      entries: [],
    })
  })

  test("rejects malformed comparison contracts before reporting", () => {
    expect(() =>
      compareCanonicalParity({
        artifactKey: "all_hires",
        fingerprintKey,
        surfaces: [
          {
            surfaceId: "person@example.test",
            canonical: matrix([[1]]),
            copied: matrix([[1]]),
            platform: matrix([[1]]),
          },
        ],
      })
    ).toThrow("stable non-PII contract id")

    expect(() =>
      compareCanonicalParity({
        artifactKey: "all_hires",
        fingerprintKey,
        surfaces: [
          {
            surfaceId: "data_a_i",
            matrixStartCell: "A1",
            canonical: matrix([[1], [1, 2]]),
            copied: matrix([[1]]),
            platform: matrix([[1]]),
          },
        ],
      })
    ).toThrow("must be rectangular")

    expect(() =>
      compareCanonicalParity({
        artifactKey: "weekly_recruitment",
        fingerprintKey,
        surfaces: [
          {
            surfaceId: "weekly_working_a_z",
            canonical: matrix([["same"]]),
            copied: doc("same"),
            platform: matrix([["same"]]),
          },
        ],
      })
    ).toThrow("mixes payload kinds")

    expect(() =>
      compareCanonicalParity({
        artifactKey: "elt_doc",
        fingerprintKey,
        surfaces: [
          {
            surfaceId: "elt_body",
            canonical: matrix([["same"]]),
            copied: matrix([["same"]]),
            platform: matrix([["same"]]),
          },
        ],
      })
    ).toThrow("must use doc_text for google_doc")

    expect(() =>
      compareCanonicalParity({
        artifactKey: "all_hires",
        fingerprintKey,
        surfaces: [
          {
            surfaceId: "data_a_i",
            matrixStartCell: "A1",
            canonical: matrix([[Number.NaN]]),
            copied: matrix([[Number.NaN]]),
            platform: matrix([[Number.NaN]]),
          },
        ],
      })
    ).toThrow("non-finite number")

    expect(() =>
      compareCanonicalParity({
        artifactKey: "all_hires",
        fingerprintKey,
        surfaces: [
          {
            surfaceId: "data_a_i",
            matrixStartCell: "A1",
            canonical: matrix([[1]]),
            copied: matrix([[2]]),
            platform: matrix([[2]]),
            approvedDivergence: {
              classification: "legacy-error",
              evidenceFingerprint: "sha256:not-valid",
            },
          },
        ],
      })
    ).toThrow("malformed evidence fingerprint")

    expect(() =>
      compareCanonicalParity({
        artifactKey: "weekly_recruitment",
        fingerprintKey,
        surfaces: [
          {
            surfaceId: "weekly_recruitment_e_f",
            canonical: matrix([[1]]),
            copied: matrix([[2]]),
            platform: matrix([[2]]),
          },
        ],
      })
    ).toThrow("requires an exact matrix origin")

    expect(() =>
      compareCanonicalParity({
        artifactKey: "weekly_recruitment",
        fingerprintKey,
        surfaces: [
          {
            surfaceId: "weekly_recruitment_a_c",
            matrixStartCell: "not-a-cell",
            canonical: matrix([[1]]),
            copied: matrix([[2]]),
            platform: matrix([[2]]),
          },
        ],
      })
    ).toThrow("absolute A1 cell coordinate")

    expect(() =>
      compareCanonicalParity({
        artifactKey: "weekly_recruitment",
        fingerprintKey,
        surfaces: [
          {
            surfaceId: "weekly_recruitment_a_c",
            matrixStartCell: `A${Number.MAX_SAFE_INTEGER}`,
            canonical: matrix([[1], [1]]),
            copied: matrix([[2], [2]]),
            platform: matrix([[2], [2]]),
          },
        ],
      })
    ).toThrow("matrix evidence exceeds safe coordinate bounds")

    for (const values of [[], [[]]] as const) {
      expect(() =>
        compareCanonicalParity({
          artifactKey: "weekly_recruitment",
          fingerprintKey,
          surfaces: [
            {
              surfaceId: "weekly_recruitment_a_c",
              matrixStartCell: "A1",
              canonical: matrix(values),
              copied: matrix([[1]]),
              platform: matrix([[1]]),
              approvedDivergence: {
                classification: "legacy-error",
                evidenceFingerprint,
              },
            },
          ],
        })
      ).toThrow("matrix must contain at least one cell")
    }

    expect(() =>
      compareCanonicalParity({
        artifactKey: "weekly_recruitment",
        fingerprintKey,
        surfaces: [
          {
            surfaceId: "weekly_recruitment_a_c",
            matrixStartCell: "A1",
            canonical: matrix([[1]]),
            copied: matrix([[1]]),
            platform: matrix([[{ raw: "Candidate Alpha" } as never]]),
          },
        ],
      })
    ).toThrow("non-scalar value")
  })
})
