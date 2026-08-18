// The shared resolved-vs-defect display gate (lib/resolution-display.ts). This is the single mapping
// the loader, the live clients, and the notification path all use, so the canon "a name shows only
// when resolved; everything else is a defect, never a sentinel" is proven once here.

import { describe, expect, test } from "vitest"
import {
  agencySourceDefectLabel,
  ownershipDefectLabel,
  resolvedOrNull,
} from "../lib/resolution-display"

describe("resolvedOrNull — the resolved-vs-defect gate", () => {
  test("returns the trimmed name only when status is 'resolved'", () => {
    expect(resolvedOrNull("  Dana Lee ", "resolved")).toBe("Dana Lee")
  })

  test("returns null for every non-resolved status even with a name present (no stale leak)", () => {
    expect(resolvedOrNull("Dana Lee", "unresolved")).toBeNull()
    expect(resolvedOrNull("Dana Lee", "ambiguous")).toBeNull()
    expect(resolvedOrNull("Dana Lee", "permission_blocked")).toBeNull()
    expect(resolvedOrNull("Dana Lee", null)).toBeNull()
    expect(resolvedOrNull("Dana Lee", undefined)).toBeNull()
  })

  test("returns null when resolved but the name is blank/absent", () => {
    expect(resolvedOrNull(null, "resolved")).toBeNull()
    expect(resolvedOrNull("   ", "resolved")).toBeNull()
  })
})

describe("defect labels — operator copy, never a banned sentinel", () => {
  test("ownership labels per status", () => {
    expect(ownershipDefectLabel("ambiguous")).toBe("Ambiguous — verifying")
    expect(ownershipDefectLabel("permission_blocked")).toBe("Access blocked")
    expect(ownershipDefectLabel("unresolved")).toBe("Owner unresolved")
    expect(ownershipDefectLabel(null)).toBe("Owner unresolved")
  })

  test("agency source labels per status", () => {
    expect(agencySourceDefectLabel("ambiguous")).toBe("Ambiguous source")
    expect(agencySourceDefectLabel("unresolved")).toBe("Unresolved source")
    expect(agencySourceDefectLabel(null)).toBe("Unresolved source")
  })

  test("no defect label is one of the banned sentinels", () => {
    const banned = ["Unknown", "Unknown Agency", "UNASSIGNED"]
    for (const s of ["unresolved", "ambiguous", "permission_blocked"] as const) {
      expect(banned).not.toContain(ownershipDefectLabel(s))
    }
    for (const s of ["unresolved", "ambiguous"] as const) {
      expect(banned).not.toContain(agencySourceDefectLabel(s))
    }
  })
})
