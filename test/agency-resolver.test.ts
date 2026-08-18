// Unit tests for lib/agency-resolver.ts — the PURE agency-source resolver and its
// list-level selector resolveAllAgencySources (frozen-spec:296-300, :443-448; build-program
// S4). The function under test is greenfield and is being written by a sibling W1 task; this
// file is the FROZEN behavioral contract it must satisfy. The most important assertion is the
// Prospectly collision: AGENCY_SOURCE_TYPE_ID (4000007004) is BOTH the id of the "Agencies" source
// TYPE and the own id of an unrelated Prospecting source ("Prospectly"). A resolver keying on
// source.id instead of source.type.id seeds Prospectly and zero real agencies
// (phase2-360-review:755-769, :43). resolveAllAgencySources must select on type.id ONLY.
//
// Canon (frozen-spec:280, :300, :389; resolution-types.ts:9-11): an unresolvable source is a
// data-quality DEFECT carried as { status:'unresolved', agency_name:null, source_id:null }.
// The literal "Unknown Agency" is NEVER written. These tests assert that sentinel-string ban
// directly, on every path that fails to resolve.
//
// Stage-1 contracts consumed EXACTLY (resolution-types.ts): AgencySourceResolution,
// AgencyResolutionStatus, AGENCY_EVIDENCE_TYPES, AGENCY_RESOLUTION_STATUS_VALUES. The resolver's
// AgencyEvidenceType domain is "registry" | "source_type" | "agency_account" | "activity" | "none"
// (resolution-types.ts:94-101) — NOT the older frozen-spec:434 draft literals.

import { describe, expect, test } from "vitest"
import {
  AGENCY_SOURCE_TYPE_ID,
  isAgencySource,
  resolveAgencySource,
  resolveAllAgencySources,
  type AgencyEvidence,
  type AgencyRegistryResolver,
} from "../lib/agency-resolver"
import {
  AGENCY_EVIDENCE_TYPES,
  AGENCY_RESOLUTION_STATUS_VALUES,
  type AgencyEvidenceType,
  type AgencySourceResolution,
} from "../lib/resolution-types"
import type { GHSource } from "../lib/sweep-types"

// ---------------------------------------------------------------------------
// The forbidden sentinel. No resolution on any path may carry this string in
// agency_name (frozen-spec:280, :300; resolution-types.ts:11). Asserted directly.
// ---------------------------------------------------------------------------
const UNKNOWN_AGENCY = "Unknown Agency"

// ---------------------------------------------------------------------------
// Live-grounded fixtures. The id 4000007004 is overloaded: it is the agency source
// TYPE id, AND it is the own id of "Prospectly" (a Prospecting source, type.id 4000003004).
// Both appear in the live /sources list (phase2-360-review:769-771).
// ---------------------------------------------------------------------------

const PROSPECTING_TYPE_ID = 4000003004

/** A real agency source: its TYPE is Agencies. id is an ordinary source id. */
function agencySource(overrides: Partial<GHSource> = {}): GHSource {
  return {
    id: 5000001001,
    name: "Riviera Partners",
    type: { id: AGENCY_SOURCE_TYPE_ID, name: "Agencies" },
    ...overrides,
  }
}

/** THE COLLISION ROW. Its own id === AGENCY_SOURCE_TYPE_ID, but its type is Prospecting.
 *  A resolver keying on src.id would wrongly admit this; keying on src.type.id rejects it. */
function prospectlySource(overrides: Partial<GHSource> = {}): GHSource {
  return {
    id: AGENCY_SOURCE_TYPE_ID, // 4000007004 — same numeral as the agency TYPE id
    name: "Prospectly",
    type: { id: PROSPECTING_TYPE_ID, name: "Prospecting" },
    ...overrides,
  }
}

/** A plain non-agency source (job board) — neither id nor type matches. */
function jobBoardSource(overrides: Partial<GHSource> = {}): GHSource {
  return {
    id: 6000002002,
    name: "LinkedIn",
    type: { id: 4000001004, name: "Third-party boards" },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Injected stub registry resolver. The agency_source_registry (migration 001) is the thin
// id->name cache the A1 rung consults; agency_source_resolution (005) is the evidence
// companion. The resolver under test takes this lookup as a dependency so it stays PURE and
// unit-testable (mirrors the DI pattern of YtdConflictFetchers, frozen-spec:450). The stub
// answers by source id and, separately, can answer a name->id reverse lookup.
// ---------------------------------------------------------------------------

interface RegistryFixtureEntry {
  source_id: number
  source_name: string
  agency_name: string | null
}

/** Build a stub AgencyRegistryResolver from a fixture list. byId returns a registry hit
 *  (A1 -> confirmed); byName lets a source carrying a name-but-no-id resolve its id. A miss
 *  returns null on both — the source then has no registry/type evidence and is unresolved. */
function stubRegistry(entries: RegistryFixtureEntry[]): AgencyRegistryResolver {
  const byId = new Map(entries.map((e) => [e.source_id, e]))
  const byName = new Map(entries.map((e) => [e.source_name, e]))
  return {
    byId: (id) => byId.get(id) ?? null,
    byName: (name) => byName.get(name) ?? null,
  }
}

/** A registry that knows nothing — every lookup misses. Used to drive the unresolved path. */
const emptyRegistry: AgencyRegistryResolver = {
  byId: () => null,
  byName: () => null,
}

// ---------------------------------------------------------------------------
// Invariant assertion helper. Every resolution this module produces must obey the Stage-1
// contract regardless of which rung fired: status is within the narrow agency domain, the
// sentinel never appears, and a non-resolved status carries NULL identity (never a sentinel
// string, never source_id 0).
// ---------------------------------------------------------------------------
function expectContractInvariants(res: AgencySourceResolution): void {
  expect(AGENCY_RESOLUTION_STATUS_VALUES).toContain(res.status)
  for (const ev of res.evidence_types) {
    expect(AGENCY_EVIDENCE_TYPES).toContain(ev as AgencyEvidenceType)
  }
  // The sentinel is banned on EVERY path.
  expect(res.agency_name).not.toBe(UNKNOWN_AGENCY)
  expect(res.source_name).not.toBe(UNKNOWN_AGENCY)
  if (res.status !== "resolved") {
    // Defect contract: NULL identity, never a sentinel string, never source_id 0.
    expect(res.agency_name).toBeNull()
    expect(res.source_id).not.toBe(0)
  }
}

describe("isAgencySource — Prospectly collision guard", () => {
  test("AGENCY_SOURCE_TYPE_ID is the live-verified Agencies type id", () => {
    expect(AGENCY_SOURCE_TYPE_ID).toBe(4000007004)
  })

  test("admits a source whose TYPE id is the agency type id", () => {
    expect(isAgencySource(agencySource())).toBe(true)
  })

  test("REJECTS Prospectly: own id === 4000007004 but type is Prospecting", () => {
    const prospectly = prospectlySource()
    expect(prospectly.id).toBe(AGENCY_SOURCE_TYPE_ID) // the trap is real
    expect(prospectly.type?.id).toBe(PROSPECTING_TYPE_ID)
    // Keying on type.id (correct) rejects it; keying on src.id (the bug) would admit it.
    expect(isAgencySource(prospectly)).toBe(false)
  })

  test("rejects an ordinary non-agency source and a null-typed source", () => {
    expect(isAgencySource(jobBoardSource())).toBe(false)
    // A source with an id but no resolvable type is not an agency — the id alone never qualifies.
    expect(isAgencySource({ id: 7, type: null })).toBe(false)
  })
})

describe("resolveAllAgencySources — selection (type.id only) + the Prospectly exclusion", () => {
  test("selects ONLY sources whose type.id === AGENCY_SOURCE_TYPE_ID and EXCLUDES Prospectly", () => {
    const northlake = agencySource({ id: 5000001001, name: "Northlake Search" })
    const veridian = agencySource({ id: 5000001002, name: "Veridian Partners" })
    const prospectly = prospectlySource()
    const linkedin = jobBoardSource()

    const sources: GHSource[] = [northlake, prospectly, veridian, linkedin]
    const registry = stubRegistry([
      { source_id: northlake.id, source_name: "Northlake Search", agency_name: "Northlake Search" },
      { source_id: veridian.id, source_name: "Veridian Partners", agency_name: "Veridian Partners" },
      // Prospectly is deliberately ALSO present in the registry by its id, to prove that
      // selection happens on type.id BEFORE any registry consultation: an id-keyed
      // resolver would "successfully" resolve Prospectly here, so its absence is load-bearing.
      { source_id: prospectly.id, source_name: "Prospectly", agency_name: "Prospectly (should never appear)" },
    ])

    const results = resolveAllAgencySources(sources, { registry })

    const ids = results.map((r) => r.source_id)
    expect(ids).toContain(northlake.id)
    expect(ids).toContain(veridian.id)
    // The collision row is excluded purely on type.id, despite a registry hit on its id.
    expect(ids).not.toContain(prospectly.id)
    // The plain job board is excluded too — only the agency TYPE is selected.
    expect(ids).not.toContain(linkedin.id)
    expect(results).toHaveLength(2)

    for (const r of results) expectContractInvariants(r)
  })

  test("EXCLUDES Prospectly even when it is the only candidate keyed by the colliding numeral", () => {
    // A list of nothing but the collision row + a non-agency must yield ZERO agencies.
    const results = resolveAllAgencySources([prospectlySource(), jobBoardSource()], {
      registry: stubRegistry([
        { source_id: AGENCY_SOURCE_TYPE_ID, source_name: "Prospectly", agency_name: "Prospectly" },
      ]),
    })
    expect(results).toHaveLength(0)
    expect(results.map((r) => r.source_id)).not.toContain(AGENCY_SOURCE_TYPE_ID)
  })

  test("empty source list resolves to no agencies (no throw)", () => {
    expect(resolveAllAgencySources([], { registry: emptyRegistry })).toEqual([])
  })
})

describe("resolveAllAgencySources — per-source resolution rungs", () => {
  test("a known source id resolves through the registry/resolution table (A1 -> confirmed)", () => {
    const northlake = agencySource({ id: 5000001001, name: "Northlake Search" })
    const registry = stubRegistry([
      { source_id: northlake.id, source_name: "Northlake Search", agency_name: "Northlake Search" },
    ])

    const [res] = resolveAllAgencySources([northlake], { registry })

    expect(res.source_id).toBe(northlake.id)
    expect(res.agency_name).toBe("Northlake Search")
    expect(res.status).toBe("resolved")
    expect(res.confidence).toBe("confirmed")
    expect(res.evidence_types).toContain<AgencyEvidenceType>("registry")
    expectContractInvariants(res)
  })

  test("a source missing its name resolves by id through the registry", () => {
    // Live source rows can arrive id-only (name null/blank). The registry id lookup
    // backfills the name; resolution still succeeds off the id alone.
    const nameless = agencySource({ id: 5000001003, name: "" })
    const registry = stubRegistry([
      { source_id: 5000001003, source_name: "Sproutline", agency_name: "Sproutline" },
    ])

    const [res] = resolveAllAgencySources([nameless], { registry })

    expect(res.source_id).toBe(5000001003)
    expect(res.agency_name).toBe("Sproutline")
    expect(res.status).toBe("resolved")
    expectContractInvariants(res)
  })

  test("a source in the agency TYPE but NOT in the registry resolves high via source_type", () => {
    // A2 (frozen-spec:298): present with the agency type id but not yet registered ->
    // high, evidence source_type, flagged for registry write. Still 'resolved'.
    const fresh = agencySource({ id: 5000009999, name: "Brand New Agency" })

    const [res] = resolveAllAgencySources([fresh], { registry: emptyRegistry })

    expect(res.source_id).toBe(5000009999)
    expect(res.status).toBe("resolved")
    expect(res.confidence).toBe("high")
    expect(res.evidence_types).toContain<AgencyEvidenceType>("source_type")
    // Even on the no-registry path, the name comes off the source itself — never a sentinel.
    expect(res.agency_name).toBe("Brand New Agency")
    expectContractInvariants(res)
  })
})

describe("resolveAgencySource — the pure single-evidence resolver (frozen-spec:447)", () => {
  test("registry hit -> confirmed via 'registry'", () => {
    const ev: AgencyEvidence = {
      sourceId: 5000001001,
      sourceName: "Northlake Search",
      sourceTypeId: AGENCY_SOURCE_TYPE_ID,
      sourceTypeName: "Agencies",
      registryHit: true,
    }
    const res = resolveAgencySource(ev)
    expect(res.status).toBe("resolved")
    expect(res.confidence).toBe("confirmed")
    expect(res.evidence_types).toContain<AgencyEvidenceType>("registry")
    expectContractInvariants(res)
  })

  test("agency type, no registry hit -> high via 'source_type'", () => {
    const res = resolveAgencySource({
      sourceId: 5000002002,
      sourceName: "Delgado Partners",
      sourceTypeId: AGENCY_SOURCE_TYPE_ID,
      sourceTypeName: "Agencies",
      registryHit: false,
    })
    expect(res.status).toBe("resolved")
    expect(res.confidence).toBe("high")
    expect(res.evidence_types).toContain<AgencyEvidenceType>("source_type")
    expectContractInvariants(res)
  })
})

describe("resolveAllAgencySources / resolveAgencySource — the unresolved DEFECT path", () => {
  test("an unresolvable source yields status='unresolved' and NEVER writes 'Unknown Agency'", () => {
    // Construct an evidence record that clears the agency-TYPE gate (so it is NOT silently
    // dropped by selection) yet has NO registry hit AND no usable name AND no activity —
    // i.e. selection admitted it but every resolution rung misses. Contract: unresolved,
    // NULL agency_name, NULL source_id, evidence ['none'], and the sentinel is absent.
    const res = resolveAgencySource({
      sourceId: null,
      sourceName: null,
      sourceTypeId: null,
      sourceTypeName: null,
      registryHit: false,
      agencyUserActivity: false,
    })

    expect(res.status).toBe("unresolved")
    expect(res.confidence).toBe("unresolved")
    expect(res.agency_name).toBeNull() // the whole point of the canon
    expect(res.agency_name).not.toBe(UNKNOWN_AGENCY)
    expect(res.source_id).toBeNull()
    expect(res.source_id).not.toBe(0) // sentinel id is banned too (frozen-spec:280)
    expect(res.evidence_types).toContain<AgencyEvidenceType>("none")
    expectContractInvariants(res)
  })

  test("the unresolved name is NULL, not the empty string, not a sentinel", () => {
    const res = resolveAgencySource({
      sourceId: null,
      sourceName: null,
      sourceTypeId: null,
      sourceTypeName: null,
      registryHit: false,
    })
    // Explicitly distinguish the three wrong answers a naive impl might produce.
    expect(res.agency_name).not.toBe(UNKNOWN_AGENCY)
    expect(res.agency_name).not.toBe("Unknown")
    expect(res.agency_name).not.toBe("")
    expect(res.agency_name).toBeNull()
  })
})
