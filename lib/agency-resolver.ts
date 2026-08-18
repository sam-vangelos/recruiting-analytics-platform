/**
 * Agency-source resolution — the PURE agency half of the identity layer, plus the
 * bootstrap transport that seeds it (frozen-spec:296-300, :443-448; build-program S4).
 *
 * Two responsibilities, kept apart on purpose:
 *
 *   1. PURE resolution (no I/O, no DB, deterministic):
 *        - isAgencySource(src)            : the Prospectly-collision-safe type gate
 *        - resolveAgencySource(evidence)  : one evidence record -> one AgencySourceResolution
 *        - resolveAllAgencySources(srcs)  : select the agency-TYPE sources, resolve each
 *      These never write the literal "Unknown Agency". An unresolvable source comes back
 *      as a data-quality DEFECT — { status:'unresolved', agency_name:null, source_id:null,
 *      evidence_types:['none'] } — exactly as the Stage-1 contract demands
 *      (resolution-types.ts:9-11, :154-171; frozen-spec:280, :300, :389).
 *
 *   2. BOOTSTRAP transport (the only I/O here):
 *        - fetchAllAgencySources(): page GET /sources via greenhouse-client and return the
 *          subset whose type.id === AGENCY_SOURCE_TYPE_ID. The /api/sweeps/resolve-agencies
 *          route (a sibling W1 file) calls this, runs the result through resolveAllAgencySources,
 *          and persists. Persistence lives in the route, NEVER in this module.
 *
 * THE TRAP (build-program S4; frozen-spec:298; phase2-360-review:755-771): the live /sources
 * list contains a Prospecting source named "Prospectly" whose OWN id is 4000007004 — the same numeral
 * as the "Agencies" source TYPE id. Selecting agencies by `src.id === 4000007004` therefore seeds
 * exactly one bogus row (Prospectly) and ZERO real agencies. Selection MUST key on `src.type.id`. That
 * is the whole reason isAgencySource exists and is the single gate every selection path runs.
 *
 * Confidence + status are pure functions of which rung fired — NO model in the loop
 * (frozen-spec:302). The agency ladder, in confidence order:
 *   A1  source.id already in agency_source_registry            -> confirmed  (evidence 'registry')
 *   A2  agency-TYPE source not yet in the registry             -> high       (evidence 'source_type')
 *   A3  (reconcile) only agency-user activity / account signal -> inferred   (evidence 'activity' | 'agency_account')
 *   else                                                       -> unresolved (evidence 'none', NULL identity)
 */

import { greenhouseGetAll } from "./greenhouse-client"
import type { GHSource } from "./sweep-types"
import {
  type AgencyEvidenceType,
  type AgencyResolutionStatus,
  type AgencySourceResolution,
  type ResolutionConfidence,
} from "./resolution-types"

// ---------------------------------------------------------------------------
// The collision constant. Live-verified (frozen-spec:298, :387; migration 005:95): this is
// the id of the "Agencies" source TYPE. It is ALSO, by coincidence, the own id of an unrelated
// Prospecting source ("Prospectly"). Everything in this module that decides "is this an agency"
// compares against source.type.id, never source.id.
// ---------------------------------------------------------------------------

export const AGENCY_SOURCE_TYPE_ID = 4000007004

/** The Prospecting type id that "Prospectly" actually carries — kept for documentation/clarity of
 *  the collision. Selection never needs it (the type-id gate excludes anything != Agencies),
 *  but naming it makes the trap legible at the call site. */
export const PROSPECTING_SOURCE_TYPE_ID = 4000003004

/**
 * The Prospectly-safe agency gate. TRUE only when the source's TYPE is the Agencies type.
 * Keying on src.type.id (correct) rejects Prospectly, whose own id collides with the type id but
 * whose type is Prospecting; a src.id check (the bug) would wrongly admit it and seed zero
 * real agencies (frozen-spec:298). A null/absent type is never an agency.
 *
 * Param is narrowed to the fields the gate actually reads (Pick<GHSource, "id" | "type">) so it
 * accepts both a full /sources row and a minimal { id, type } projection — the gate's decision
 * depends on type alone, and `name` is never consulted.
 */
export function isAgencySource(src: Pick<GHSource, "id" | "type">): boolean {
  return src.type?.id === AGENCY_SOURCE_TYPE_ID
}

// ---------------------------------------------------------------------------
// Registry dependency (DI). The A1 rung consults agency_source_registry (migration 001 — the
// thin id->name cache, left UNCHANGED), but this module stays PURE: the caller injects a
// lookup so the resolver never imports supabase and stays unit-testable (mirrors the
// YtdConflictFetchers DI pattern, frozen-spec:450). byId is the primary A1 path; byName lets a
// source that arrived id-only (id missing/0) still resolve off a name match.
// ---------------------------------------------------------------------------

/** A single agency_source_registry row as the resolver needs it: the id, the registered source
 *  name, and the canonical agency_name (which the registry MAY leave null even on a hit). */
export interface AgencyRegistryEntry {
  source_id: number
  source_name: string
  agency_name: string | null
}

/** Injected registry lookup. A miss returns null on both axes; the source then has no registry
 *  evidence and falls through to the A2 (source_type) / unresolved rungs. */
export interface AgencyRegistryResolver {
  byId: (sourceId: number) => AgencyRegistryEntry | null
  byName: (sourceName: string) => AgencyRegistryEntry | null
}

// ---------------------------------------------------------------------------
// Evidence record — the single input to the pure resolver. One per source. Every field is the
// caller's already-in-hand projection of a /sources row (+ optional reconcile-time activity
// signals); the resolver decides nothing about transport, only which rung fires.
// ---------------------------------------------------------------------------

export interface AgencyEvidence {
  /** The source's OWN id (never the type id). NULL when the live row arrived id-less. */
  sourceId: number | null
  /** The source's display name off the /sources row. NULL/blank when the row is name-less. */
  sourceName: string | null
  /** source.type.id — should equal AGENCY_SOURCE_TYPE_ID for any source admitted by selection. */
  sourceTypeId: number | null
  /** source.type.name (e.g. "Agencies"). Carried through to the resolution row, never decisive. */
  sourceTypeName: string | null
  /** A1: this source id is present in agency_source_registry. Set by the caller from byId. */
  registryHit: boolean
  /** The canonical agency_name the registry holds for this source (A1). Preferred over the raw
   *  source name when present; null on an A2/unregistered source (name then comes off the row). */
  registryAgencyName?: string | null
  /** A3 (reconcile): a known agency account id correlates this source. Lifts unresolved -> inferred. */
  agencyAccountId?: number | null
  /** Agency-user ids associated with this source (carried onto the row; A3 evidence when present). */
  agencyUserIds?: number[]
  /** A3 (reconcile): agency-user activity was observed for this source. Lifts unresolved -> inferred. */
  agencyUserActivity?: boolean
  /** Whether the source is active. Defaults true (matches the column default, migration 005:100). */
  active?: boolean
}

// ---------------------------------------------------------------------------
// Pure resolver. Walks the ladder top-down; the FIRST rung that fires sets confidence + status
// + the resolved agency_name. Identity stays NULL (never a sentinel, never source_id 0) on the
// unresolved rung. Deterministic and side-effect-free.
// ---------------------------------------------------------------------------

/** First non-empty trimmed string, else null. Empty / whitespace names are treated as absent so
 *  a blank /sources name never masquerades as a resolved identity. */
function firstName(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (typeof c === "string") {
      const trimmed = c.trim()
      if (trimmed.length > 0) return trimmed
    }
  }
  return null
}

/** A finite, positive source id, else null. 0 is a banned sentinel (frozen-spec:280) and is
 *  collapsed to null so the defect contract holds on the unresolved path. */
function cleanSourceId(id: number | null | undefined): number | null {
  return typeof id === "number" && Number.isFinite(id) && id > 0 ? id : null
}

export function resolveAgencySource(evidence: AgencyEvidence): AgencySourceResolution {
  const sourceId = cleanSourceId(evidence.sourceId)
  const sourceName = firstName(evidence.sourceName)
  const sourceTypeId =
    typeof evidence.sourceTypeId === "number" && Number.isFinite(evidence.sourceTypeId)
      ? evidence.sourceTypeId
      : null
  const sourceTypeName = firstName(evidence.sourceTypeName)
  const agencyUserIds = uniqSortedIds(evidence.agencyUserIds ?? [])
  const agencyAccountId = cleanSourceId(evidence.agencyAccountId)
  const active = evidence.active ?? true

  const isAgencyType = sourceTypeId === AGENCY_SOURCE_TYPE_ID

  let confidence: ResolutionConfidence
  let status: AgencyResolutionStatus
  const evidenceTypes: AgencyEvidenceType[] = []
  let agencyName: string | null

  if (evidence.registryHit) {
    // A1 — registry hit -> confirmed. The canonical name is the registry's agency_name, falling
    // back to the source's own name when the registry left it null. A registry hit on a row with
    // NO name anywhere is implausible, but if it happens we demote to the unresolved defect rather
    // than assert a confirmed identity with a null name (an incoherent "resolved-but-nameless" row).
    agencyName = firstName(evidence.registryAgencyName, sourceName)
    if (agencyName !== null) {
      confidence = "confirmed"
      status = "resolved"
      evidenceTypes.push("registry")
    } else {
      ;({ confidence, status, agencyName } = unresolvedDefect(evidenceTypes))
    }
  } else if (isAgencyType) {
    // A2 — agency TYPE present, not yet registered -> high, flagged for registry write. The name
    // comes off the source row itself (never a sentinel). If the agency-typed row is name-less,
    // it cannot assert an identity, so it falls through to the unresolved defect rung below.
    if (sourceName !== null) {
      confidence = "high"
      status = "resolved"
      evidenceTypes.push("source_type")
      agencyName = sourceName
    } else {
      ;({ confidence, status, agencyName } = unresolvedDefect(evidenceTypes))
    }
  } else if (agencyAccountId !== null || evidence.agencyUserActivity === true) {
    // A3 (reconcile) — no registry, not (or not yet) confirmable by type, but an agency account
    // id or observed agency-user activity correlates it -> inferred. Prefer the account-id
    // evidence tag when an account id is present; otherwise the activity tag.
    confidence = "inferred"
    status = "resolved"
    evidenceTypes.push(agencyAccountId !== null ? "agency_account" : "activity")
    agencyName = sourceName
    // An inferred resolution with no name anywhere is still a defect, not a sentinel — demote.
    if (agencyName === null) {
      evidenceTypes.length = 0
      ;({ confidence, status, agencyName } = unresolvedDefect(evidenceTypes))
    }
  } else {
    // No rung fired — unresolved DEFECT. NULL identity, ['none'], NEVER 'Unknown Agency'.
    ;({ confidence, status, agencyName } = unresolvedDefect(evidenceTypes))
  }

  // Identity nulling on the defect path: a non-resolved row carries NULL source_id/name/agency
  // (the contract, resolution-types.ts:156-157). A resolved row keeps its real source_id.
  const resolved = status === "resolved"

  return {
    source_id: resolved ? sourceId : null,
    source_name: resolved ? sourceName : null,
    source_type_id: sourceTypeId,
    source_type_name: sourceTypeName,
    agency_name: agencyName,
    agency_account_id: resolved ? agencyAccountId : null,
    agency_user_ids: agencyUserIds,
    active,
    confidence,
    status,
    evidence_types: evidenceTypes,
    evidence_detail: buildEvidenceDetail({
      sourceId,
      sourceName,
      sourceTypeId,
      sourceTypeName,
      registryHit: evidence.registryHit,
      registryAgencyName: firstName(evidence.registryAgencyName),
      agencyAccountId,
      agencyUserIds,
      agencyUserActivity: evidence.agencyUserActivity === true,
    }),
  }
}

/** The unresolved DEFECT shape. Pushes the 'none' evidence tag onto the caller's array and
 *  returns NULL identity. Centralized so every miss path produces an identical defect and the
 *  sentinel ban ("Unknown Agency", "", 0) is impossible to violate by omission. */
function unresolvedDefect(evidenceTypes: AgencyEvidenceType[]): {
  confidence: ResolutionConfidence
  status: AgencyResolutionStatus
  agencyName: string | null
} {
  evidenceTypes.push("none")
  return { confidence: "unresolved", status: "unresolved", agencyName: null }
}

/** Diagnostic provenance (jsonb evidence_detail). Reference-layer only — the UI leads with the
 *  resolved name / defect chip, not this. Omits null/empty fields to keep the row lean. */
function buildEvidenceDetail(parts: {
  sourceId: number | null
  sourceName: string | null
  sourceTypeId: number | null
  sourceTypeName: string | null
  registryHit: boolean
  registryAgencyName: string | null
  agencyAccountId: number | null
  agencyUserIds: number[]
  agencyUserActivity: boolean
}): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    source_id: parts.sourceId,
    source_type_id: parts.sourceTypeId,
    registry_hit: parts.registryHit,
  }
  if (parts.sourceName !== null) detail.source_name = parts.sourceName
  if (parts.sourceTypeName !== null) detail.source_type_name = parts.sourceTypeName
  if (parts.registryAgencyName !== null) detail.registry_agency_name = parts.registryAgencyName
  if (parts.agencyAccountId !== null) detail.agency_account_id = parts.agencyAccountId
  if (parts.agencyUserIds.length > 0) detail.agency_user_ids = parts.agencyUserIds
  if (parts.agencyUserActivity) detail.agency_user_activity = true
  return detail
}

/** Unique, ascending, null/undefined/non-finite-stripped. Mirrors greenhouse-evidence
 *  uniqSortedIds semantics so id lists dedupe identically across the identity modules. */
function uniqSortedIds(values: Array<number | null | undefined>): number[] {
  const seen = new Set<number>()
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) seen.add(v)
  }
  return [...seen].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// List-level selector. Takes the raw /sources list (already fetched by the caller/route) and
// the injected registry, SELECTS the agency-TYPE rows (the Prospectly-safe gate — type.id only),
// builds each one's evidence from the registry, and resolves it. Pure + deterministic: no
// network, no DB, order-preserving on the input. The route persists the result.
// ---------------------------------------------------------------------------

export interface ResolveAllAgencySourcesOptions {
  registry: AgencyRegistryResolver
}

/**
 * Resolve every agency source in a /sources list. Non-agency sources (job boards, prospecting
 * incl. the Prospectly collision row) are DROPPED before any registry consultation, so an id-keyed
 * registry hit on Prospectly can never resurrect it (selection is on type.id, the bug-proof axis).
 */
export function resolveAllAgencySources(
  sources: GHSource[],
  options: ResolveAllAgencySourcesOptions
): AgencySourceResolution[] {
  const { registry } = options
  const out: AgencySourceResolution[] = []

  for (const src of sources) {
    // Selection gate FIRST — on type.id only. Prospectly (own id === AGENCY_SOURCE_TYPE_ID, type
    // Prospecting) and plain job boards are excluded here, before the registry is ever asked.
    if (!isAgencySource(src)) continue

    // A1 consultation: the registry is keyed by source id; a name-only fallback covers id-less
    // rows. registryAgencyName carries the canonical name into the evidence so a name-less
    // /sources row still resolves off the registry (the nameless-source contract).
    const hit =
      registry.byId(src.id) ??
      (src.name ? registry.byName(src.name) : null)

    out.push(
      resolveAgencySource({
        sourceId: src.id,
        sourceName: src.name,
        sourceTypeId: src.type?.id ?? null,
        sourceTypeName: src.type?.name ?? null,
        registryHit: hit !== null,
        registryAgencyName: hit?.agency_name ?? null,
      })
    )
  }

  return out
}

// ---------------------------------------------------------------------------
// Bootstrap transport — the ONLY I/O in this module. Pages GET /sources to exhaustion via the
// shared client and returns the agency-TYPE subset. The /api/sweeps/resolve-agencies route
// (sibling W1 file) calls this, runs it through resolveAllAgencySources(registry), and persists
// to agency_source_resolution / agency_source_registry. This function persists NOTHING.
//
// Keying note: greenhouseGetAll already follows the Link-header cursor to exhaustion, so the
// full /sources list (~all source rows, agencies + boards + prospecting) comes back in one call
// and isAgencySource trims it to the agencies. type.id is the filter — see the module header.
// ---------------------------------------------------------------------------

/**
 * Fetch the live /sources list and return ONLY the agency-TYPE sources (type.id ===
 * AGENCY_SOURCE_TYPE_ID). The Prospectly row is excluded because its type is Prospecting, even though
 * its own id collides with the agency type id. Surfaces transport errors to the caller (the
 * route owns retry/permission framing); does not catch.
 */
export async function fetchAllAgencySources(): Promise<GHSource[]> {
  const all = await greenhouseGetAll<GHSource>("/sources")
  return all.filter(isAgencySource)
}

// ---------------------------------------------------------------------------
// Bootstrap orchestrator — the seam the /api/sweeps/resolve-agencies route drives
// (frozen-spec:448, :468). Both lib/sweep-agency.ts:96 and lib/ytd-extract.ts:91 hard-fail on an
// empty agency_source_registry and point the operator here; this is the cold-start that seeds it.
//
// Cold start has NO registry yet — that is the whole point of seeding it — so every agency-TYPE
// source resolves through A2 (source_type -> high), never A1 (confirmed). We therefore resolve
// against the empty registry: byId/byName always miss, registryHit is always false, and the
// confirmed rung is correctly unavailable until the rows this seeds exist. Daily re-runs (and the
// reconcile cron) then re-walk the same path; a later A1 upgrade is the cron's job, not bootstrap's.
//
// Both I/O seams are INJECTED so this stays testable and the module owns no transport/DB itself:
//   * listSources — the route binds this to greenhouseGetAll('/sources', params).
//   * upsert      — the route binds this to its dual-table seed and returns the registry-row count.
// ---------------------------------------------------------------------------

/** Greenhouse list params, narrowed to what greenhouseGet accepts (client.ts:99). Exported so the
 *  route's injected `listSources` param infers a concrete type instead of implicit-any. */
export type SourceListParams = Record<string, string | number | boolean | undefined>

export interface BootstrapAgencySourcesDeps {
  /** List /sources to exhaustion. The route binds greenhouseGetAll<GHSource>('/sources', params). */
  listSources: (params?: SourceListParams) => Promise<GHSource[]>
  /** Persist EVERY resolution (resolved + defect) and return the count of seeded registry rows. */
  upsert: (resolutions: AgencySourceResolution[]) => Promise<number>
}

export interface BootstrapAgencySourcesResult {
  /** Count of agency-TYPE sources resolved (the size of the upserted resolution set). */
  agencies: number
  /** Every scanned source id (the full /sources list, not just agencies) — the route reports
   *  this as sources_scanned so "scanned N, resolved M agencies" stays truthful. */
  sourceIds: number[]
}

/**
 * Seed the agency identity tables from the live /sources list. Lists all sources, selects the
 * agency-TYPE subset (Prospectly-safe — type.id only), resolves each against an empty registry
 * (cold-start => A2/source_type), hands the full resolution set to `upsert`, and reports the
 * scan + resolve counts. Pure orchestration over injected I/O; persists nothing directly.
 */
export async function bootstrapAgencySources(
  deps: BootstrapAgencySourcesDeps
): Promise<BootstrapAgencySourcesResult> {
  const sources = await deps.listSources()
  const sourceIds = uniqSortedIds(sources.map((s) => s.id))

  // Empty registry: cold start has no rows yet, so A1 (confirmed) is correctly unreachable and
  // every agency-TYPE source resolves via A2 (source_type -> high). Selection still happens on
  // type.id inside resolveAllAgencySources, so Prospectly and job boards never reach the upsert.
  const resolutions = resolveAllAgencySources(sources, { registry: EMPTY_REGISTRY })

  await deps.upsert(resolutions)

  return { agencies: resolutions.length, sourceIds }
}

/** A registry that knows nothing. Used by bootstrap (no rows exist yet) so resolution falls to the
 *  source_type rung; reused rather than reallocated per call. */
const EMPTY_REGISTRY: AgencyRegistryResolver = {
  byId: () => null,
  byName: () => null,
}
