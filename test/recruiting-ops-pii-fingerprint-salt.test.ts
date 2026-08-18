import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
  LOCAL_ONLY_PII_FINGERPRINT_KEY,
  PII_FINGERPRINT_SALT_ENV,
  createPiiFingerprint,
  createLocalPiiFingerprint,
  createPseudonymousFingerprint,
} from "../lib/recruiting-ops/checksums"

// REGRESSION LOCK — SAFETY-GATES-4: PII-derived pseudonyms keyed by a committed constant
// are reversible over any committed roster. Live-provenance fingerprints MUST use an
// env-injected secret and fail closed without it; the committed key is reachable only
// for fixture-provenance data.

const originalSalt = process.env[PII_FINGERPRINT_SALT_ENV]

beforeEach(() => {
  delete process.env[PII_FINGERPRINT_SALT_ENV]
})

afterEach(() => {
  if (originalSalt === undefined) {
    delete process.env[PII_FINGERPRINT_SALT_ENV]
  } else {
    process.env[PII_FINGERPRINT_SALT_ENV] = originalSalt
  }
})

describe("PII fingerprint salt provenance", () => {
  test("the env contract is the literal RECOPS_PII_FINGERPRINT_SALT", () => {
    // Guards the throw assertions below: toThrow(undefined) degrades to
    // toThrow-anything, so a broken export must fail loudly on its own.
    expect(PII_FINGERPRINT_SALT_ENV).toBe("RECOPS_PII_FINGERPRINT_SALT")
  })

  test("live provenance without the env salt fails closed", () => {
    expect(() =>
      createPiiFingerprint("Avery Collins", { context: "test_recipient", dataProvenance: "live" })
    ).toThrow("RECOPS_PII_FINGERPRINT_SALT")
  })

  test("live provenance with a blank env salt still fails closed", () => {
    process.env[PII_FINGERPRINT_SALT_ENV] = "   "
    expect(() =>
      createPiiFingerprint("Avery Collins", { context: "test_recipient", dataProvenance: "live" })
    ).toThrow("RECOPS_PII_FINGERPRINT_SALT")
  })

  test("live provenance uses the env salt, never the committed key", () => {
    process.env[PII_FINGERPRINT_SALT_ENV] = "env-injected-secret-for-test"
    const live = createPiiFingerprint("Avery Collins", {
      context: "test_recipient",
      dataProvenance: "live",
    })
    expect(live).toBe(
      createPseudonymousFingerprint("Avery Collins", {
        key: "env-injected-secret-for-test",
        context: "test_recipient",
      })
    )
    expect(live).not.toBe(
      createPseudonymousFingerprint("Avery Collins", {
        key: LOCAL_ONLY_PII_FINGERPRINT_KEY,
        context: "test_recipient",
      })
    )
  })

  test("fixture provenance is stable and equals the local helper", () => {
    const direct = createPiiFingerprint("recruiter_fixture_alpha", {
      context: "test_recipient",
      dataProvenance: "fixture",
    })
    expect(direct).toBe(createLocalPiiFingerprint("recruiter_fixture_alpha", "test_recipient"))
    expect(direct).toMatch(/^hmac-sha256:/)
  })
})
