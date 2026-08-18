import { ghStageName } from "./sweep-types"
import {
  appliedAt,
  hoursBetween,
  normalizeEmail,
  normalizePhone,
  normalizeProfileUrl,
  normalizeText,
  sourceId,
} from "./ytd-normalize"
import type {
  DuplicateConfidence,
  DuplicateEvidenceType,
  FeeRiskState,
  YtdApplicationFact,
  YtdCandidateSummary,
  YtdGHApplication,
  YtdPriorApplication,
  YtdConflictType,
  YtdDataQualityFlag,
  YtdJobSummary,
} from "./ytd-types"

export interface YtdConflictFetchers {
  findCandidatesByEmail(email: string): Promise<Array<{ id: number }>>
  findApplicationsByCandidateId(candidateId: number): Promise<YtdGHApplication[]>
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let index = 0

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++
      results[currentIndex] = await fn(items[currentIndex])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  )
  return results
}

function before(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  return new Date(a).getTime() < new Date(b).getTime()
}

const CONFIDENCE_RANK: Record<DuplicateConfidence, number> = {
  insufficient_data: 0,
  none: 1,
  possible: 2,
  high: 3,
  confirmed: 4,
}

function highestConfidence(a: DuplicateConfidence, b: DuplicateConfidence): DuplicateConfidence {
  return CONFIDENCE_RANK[b] > CONFIDENCE_RANK[a] ? b : a
}

function addFlag(fact: YtdApplicationFact, flag: YtdDataQualityFlag) {
  if (!fact.data_quality_flags.includes(flag)) fact.data_quality_flags.push(flag)
}

function addConflictType(fact: YtdApplicationFact, type: YtdConflictType) {
  if (!fact.conflict_types.includes(type)) fact.conflict_types.push(type)
  fact.conflict_detected = true
}

function addEvidence(fact: YtdApplicationFact, evidence: DuplicateEvidenceType) {
  if (!fact.duplicate_evidence_types.includes(evidence)) fact.duplicate_evidence_types.push(evidence)
}

function addDuplicateCandidateId(fact: YtdApplicationFact, candidateId: number) {
  if (candidateId === fact.candidate_id) return
  if (!fact.duplicate_candidate_ids.includes(candidateId)) {
    fact.duplicate_candidate_ids.push(candidateId)
    fact.duplicate_candidate_ids.sort((a, b) => a - b)
  }
}

function mergeConflictDetail(
  fact: YtdApplicationFact,
  next: Record<string, unknown>
) {
  fact.conflict_detail = { ...(fact.conflict_detail ?? {}), ...next }
}

function identitySignals(candidate: YtdCandidateSummary | null | undefined) {
  const first = normalizeText(candidate?.first_name)
  const last = normalizeText(candidate?.last_name)
  const company = normalizeText(candidate?.company)
  const title = normalizeText(candidate?.title)
  return {
    email: normalizeEmail(candidate?.email),
    phones: new Set(candidate?.phones.map(normalizePhone).filter((v): v is string => Boolean(v)) ?? []),
    profileUrls: new Set(
      candidate?.profile_urls.map(normalizeProfileUrl).filter((v): v is string => Boolean(v)) ?? []
    ),
    nameCompanyTitle:
      first && last && company && title ? `${first}::${last}::${company}::${title}` : null,
    hasAny: Boolean(
      candidate?.email ||
        candidate?.phones.length ||
        candidate?.profile_urls.length ||
        (first && last && company && title)
    ),
  }
}

function overlap(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) if (b.has(value)) return true
  return false
}

function compareCandidates(
  a: YtdCandidateSummary | null | undefined,
  b: YtdCandidateSummary | null | undefined
): { confidence: DuplicateConfidence; evidence: DuplicateEvidenceType[] } {
  const aSig = identitySignals(a)
  const bSig = identitySignals(b)
  if (!aSig.hasAny || !bSig.hasAny) return { confidence: "insufficient_data", evidence: [] }

  const evidence: DuplicateEvidenceType[] = []
  if (aSig.email && bSig.email && aSig.email === bSig.email) evidence.push("email_exact")
  if (overlap(aSig.phones, bSig.phones)) evidence.push("phone_exact")
  if (overlap(aSig.profileUrls, bSig.profileUrls)) evidence.push("profile_url_exact")
  if (a?.id && b?.id && a.id === b.id) evidence.push("candidate_id")
  if (aSig.nameCompanyTitle && aSig.nameCompanyTitle === bSig.nameCompanyTitle) {
    evidence.push("name_company_title")
  }

  if (evidence.includes("email_exact") || evidence.includes("candidate_id")) {
    return { confidence: "confirmed", evidence }
  }
  if (evidence.includes("phone_exact") || evidence.includes("profile_url_exact")) {
    return { confidence: "high", evidence }
  }
  if (evidence.includes("name_company_title")) return { confidence: "possible", evidence }
  return { confidence: "none", evidence: [] }
}

function markDuplicate(input: {
  fact: YtdApplicationFact
  matchedCandidateId: number
  confidence: DuplicateConfidence
  evidence: DuplicateEvidenceType[]
}) {
  if (input.confidence === "none" || input.confidence === "insufficient_data") return
  input.fact.duplicate_confidence = highestConfidence(
    input.fact.duplicate_confidence,
    input.confidence
  )
  for (const evidence of input.evidence) addEvidence(input.fact, evidence)
  addDuplicateCandidateId(input.fact, input.matchedCandidateId)
}

interface DualAgencyApplicationRef {
  application_id: number
  candidate_id: number
  agency_source_id: number | null
  agency_source_name: string | null
  submitted_at: string | null
}

interface DualAgencyDetail {
  confidence: DuplicateConfidence
  evidence: DuplicateEvidenceType[]
  applications: DualAgencyApplicationRef[]
}

/**
 * Per-application dual-agency verdict. Pure output of {@link computeDualAgencyConflicts};
 * the caller writes these onto the facts it is persisting. Designed so an incremental run
 * that re-touches only ONE side of a dual-agency pair still receives the full verdict (the
 * persisted partner is supplied via `existingFacts`), which is what stops the blind upsert
 * from erasing a known conflict.
 */
export interface DualAgencyVerdict {
  application_id: number
  /** Connected-components key: every application in the same conflict component shares it,
   *  independent of iteration order — so a 3+-agency conflict groups under ONE key. */
  group_key: string
  confidence: DuplicateConfidence
  evidence: DuplicateEvidenceType[]
  /** Other candidate_ids in the same conflict component (excludes this application's own). */
  duplicate_candidate_ids: number[]
  detail: DualAgencyDetail
}

export interface DualAgencyResult {
  verdictsByApplicationId: Map<number, DualAgencyVerdict>
}

/**
 * Build the identity view used for cross-application comparison. Prefer the full candidate
 * summary (carries phone/profile/name signals); fall back to a minimal summary synthesized
 * from the fact's own candidate_id + email when the partner lives only in `existingFacts`
 * and its summary was not loaded this run. The fallback still supports the confirmed-tier
 * evidence that defines a real dual-agency case (email_exact / candidate_id).
 */
function identityViewForFact(
  fact: YtdApplicationFact,
  candidatesById: Map<number, YtdCandidateSummary>
): YtdCandidateSummary | null {
  const summary = candidatesById.get(fact.candidate_id)
  if (summary) return summary
  if (fact.candidate_email) {
    return {
      id: fact.candidate_id,
      name: fact.candidate_name,
      email: fact.candidate_email,
      first_name: null,
      last_name: null,
      company: null,
      title: null,
      phones: [],
      profile_urls: [],
    }
  }
  return null
}

class UnionFind {
  private parent = new Map<number, number>()

  private find(x: number): number {
    let root = this.parent.get(x)
    if (root === undefined) {
      this.parent.set(x, x)
      return x
    }
    while (root !== this.parent.get(root)) {
      const grandparent = this.parent.get(root) as number
      this.parent.set(root, this.parent.get(grandparent) as number)
      root = this.parent.get(root) as number
    }
    return root
  }

  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    // Deterministic merge: lower id is always the root, independent of union order.
    if (ra < rb) this.parent.set(rb, ra)
    else this.parent.set(ra, rb)
  }

  /** Component root (smallest id in the component) for `x`. */
  root(x: number): number {
    return this.find(x)
  }
}

/**
 * PURE. Detect dual-agency conflicts over a PERSISTED SUPERSET — the in-run batch UNION the
 * already-persisted facts for the same job_ids — and return one deterministic verdict per
 * participating application. Mutates nothing. Idempotent: the verdict for any application
 * depends only on the set of applications supplied, not on which subset was re-touched this
 * run or the order they appear in.
 */
export function computeDualAgencyConflicts(input: {
  inBatchFacts: YtdApplicationFact[]
  existingFacts: YtdApplicationFact[]
  candidatesById: Map<number, YtdCandidateSummary>
}): DualAgencyResult {
  // Superset, de-duplicated by application_id. In-batch facts win over persisted copies so a
  // re-touched application is compared with its freshest identity/source values this run.
  const byApplicationId = new Map<number, YtdApplicationFact>()
  for (const fact of input.existingFacts) byApplicationId.set(fact.application_id, fact)
  for (const fact of input.inBatchFacts) byApplicationId.set(fact.application_id, fact)

  // Sort the superset deterministically so component roots and detail ordering are stable
  // across runs regardless of batch/load order.
  const superset = [...byApplicationId.values()].sort(
    (a, b) => a.job_id - b.job_id || a.application_id - b.application_id
  )

  // C7 — application_id is the unique key of the superset above, and an application's source
  // is single-valued (GHApplication.source is `{ id; name } | null`; ytd-normalize.sourceId
  // collapses it to ONE id — ytd-normalize.ts:122-124). The same application_id therefore
  // cannot arrive under two channels, so a referral-vs-agency collision on application_id is
  // structurally impossible. Guard documents the invariant; it never fires in practice.
  if (byApplicationId.size !== superset.length) {
    throw new Error("dual-agency superset has duplicate application_id (source must be single-valued)")
  }

  const components = new UnionFind()
  const pairEvidence = new Map<number, { confidence: DuplicateConfidence; evidence: Set<DuplicateEvidenceType> }>()
  const partners = new Map<number, Set<number>>()

  function addPartner(appId: number, otherCandidateId: number, ownCandidateId: number) {
    if (otherCandidateId === ownCandidateId) return
    const set = partners.get(appId) ?? new Set<number>()
    set.add(otherCandidateId)
    partners.set(appId, set)
  }

  function recordVerdictEvidence(
    appId: number,
    confidence: DuplicateConfidence,
    evidence: DuplicateEvidenceType[]
  ) {
    const current = pairEvidence.get(appId) ?? {
      confidence: "none" as DuplicateConfidence,
      evidence: new Set<DuplicateEvidenceType>(),
    }
    current.confidence = highestConfidence(current.confidence, confidence)
    for (const item of evidence) current.evidence.add(item)
    pairEvidence.set(appId, current)
  }

  for (let i = 0; i < superset.length; i++) {
    const a = superset[i]
    const aIdentity = identityViewForFact(a, input.candidatesById)
    for (let j = i + 1; j < superset.length; j++) {
      const b = superset[j]
      if (a.job_id !== b.job_id) break // superset is job-sorted; no further partners for `a`
      if (!a.agency_source_id || !b.agency_source_id) continue
      if (a.agency_source_id === b.agency_source_id) continue

      const bIdentity = identityViewForFact(b, input.candidatesById)
      const match = compareCandidates(aIdentity, bIdentity)
      if (match.confidence === "none" || match.confidence === "insufficient_data") continue

      components.union(a.application_id, b.application_id)
      recordVerdictEvidence(a.application_id, match.confidence, match.evidence)
      recordVerdictEvidence(b.application_id, match.confidence, match.evidence)
      addPartner(a.application_id, b.candidate_id, a.candidate_id)
      addPartner(b.application_id, a.candidate_id, b.candidate_id)
    }
  }

  // Group the superset by connected component, then emit one verdict per participating
  // application. The component key is `${job_id}::${minApplicationId}` — every member of a
  // 3+-agency conflict resolves to the same root, so they share ONE key regardless of which
  // pair was discovered first.
  const membersByRoot = new Map<number, YtdApplicationFact[]>()
  for (const fact of superset) {
    if (!pairEvidence.has(fact.application_id)) continue
    const root = components.root(fact.application_id)
    const members = membersByRoot.get(root) ?? []
    members.push(fact)
    membersByRoot.set(root, members)
  }

  const verdictsByApplicationId = new Map<number, DualAgencyVerdict>()
  for (const [root, members] of membersByRoot) {
    const sortedMembers = [...members].sort((a, b) => a.application_id - b.application_id)
    const jobId = sortedMembers[0].job_id
    const groupKey = `dual_agency::${jobId}::${root}`
    // Component-level confidence/evidence: the strongest signal anywhere in the component, so
    // every member reports the same severity (a confirmed link between two of three agencies
    // makes the whole group fee-material).
    let componentConfidence: DuplicateConfidence = "none"
    const componentEvidence = new Set<DuplicateEvidenceType>()
    for (const member of sortedMembers) {
      const evidence = pairEvidence.get(member.application_id)
      if (!evidence) continue
      componentConfidence = highestConfidence(componentConfidence, evidence.confidence)
      for (const item of evidence.evidence) componentEvidence.add(item)
    }
    const evidenceList = [...componentEvidence]
    const applications: DualAgencyApplicationRef[] = sortedMembers.map((member) => ({
      application_id: member.application_id,
      candidate_id: member.candidate_id,
      agency_source_id: member.agency_source_id,
      agency_source_name: member.agency_source_name,
      submitted_at: member.submitted_at,
    }))
    const detail: DualAgencyDetail = {
      confidence: componentConfidence,
      evidence: evidenceList,
      applications,
    }
    for (const member of sortedMembers) {
      const own = pairEvidence.get(member.application_id)
      verdictsByApplicationId.set(member.application_id, {
        application_id: member.application_id,
        group_key: groupKey,
        // Group severity is a property of the COMPONENT, not the member's own pair: a confirmed
        // link anywhere makes the whole group fee-material, so a weak-link member must report the
        // component max — not its own weaker pair confidence (matches detail.confidence above).
        confidence: componentConfidence,
        evidence: own ? [...own.evidence] : evidenceList,
        duplicate_candidate_ids: [...(partners.get(member.application_id) ?? [])].sort((a, b) => a - b),
        detail,
      })
    }
  }

  return { verdictsByApplicationId }
}

/**
 * Mutating entry point. Writes dual-agency verdicts onto the in-batch facts being persisted,
 * computed over the persisted superset (in-batch UNION `existingFacts`). `existingFacts`
 * defaults to `[]` so single-batch callers (and the unit tests) keep the exact prior
 * behavior; the extract orchestrator loads the related persisted facts for the batch job_ids
 * and passes them in so a one-sided incremental re-touch does not erase a known verdict.
 */
export function applyDualAgencyConflicts(input: {
  facts: YtdApplicationFact[]
  candidatesById: Map<number, YtdCandidateSummary>
  existingFacts?: YtdApplicationFact[]
}): void {
  // Missing-identity flag is a per-fact data-quality concern on the facts being persisted.
  for (const fact of input.facts) {
    const candidate = input.candidatesById.get(fact.candidate_id)
    if (!identitySignals(candidate).hasAny) addFlag(fact, "cannot_check_conflict_missing_email")
  }

  const { verdictsByApplicationId } = computeDualAgencyConflicts({
    inBatchFacts: input.facts,
    existingFacts: input.existingFacts ?? [],
    candidatesById: input.candidatesById,
  })

  for (const fact of input.facts) {
    const verdict = verdictsByApplicationId.get(fact.application_id)
    if (!verdict) continue
    addConflictType(fact, "dual_agency")
    fact.dual_agency_group_key = verdict.group_key
    markDuplicate({
      fact,
      matchedCandidateId: fact.candidate_id, // no-op id; real partners added below
      confidence: verdict.confidence,
      evidence: verdict.evidence,
    })
    for (const candidateId of verdict.duplicate_candidate_ids) addDuplicateCandidateId(fact, candidateId)
    mergeConflictDetail(fact, { dual_agency: verdict.detail })
  }
}

export async function applyPriorHistoryConflicts(input: {
  facts: YtdApplicationFact[]
  agencySourceIds: Set<number>
  jobsById: Map<number, YtdJobSummary>
  fetchers: YtdConflictFetchers
}): Promise<void> {
  const factsByEmail = new Map<string, YtdApplicationFact[]>()

  for (const fact of input.facts) {
    const email = normalizeEmail(fact.candidate_email)
    if (!email) {
      addFlag(fact, "cannot_check_conflict_missing_email")
      continue
    }

    const factsForEmail = factsByEmail.get(email) ?? []
    factsForEmail.push(fact)
    factsByEmail.set(email, factsForEmail)
  }

  const applicationsByEmail = new Map<string, YtdGHApplication[]>()
  await mapWithConcurrency([...factsByEmail.keys()], 5, async (email) => {
    const candidates = await input.fetchers.findCandidatesByEmail(email)
    const appsById = new Map<number, YtdGHApplication>()
    for (const candidate of candidates) {
      const apps = await input.fetchers.findApplicationsByCandidateId(candidate.id)
      for (const app of apps) appsById.set(app.id, app)
    }
    applicationsByEmail.set(email, [...appsById.values()])
  })

  for (const [email, facts] of factsByEmail) {
    const apps = applicationsByEmail.get(email) ?? []
    for (const fact of facts) {
      const priorApplications: YtdPriorApplication[] = []

      for (const app of apps) {
        if (app.id === fact.application_id) continue
        const appSourceId = sourceId(app)
        if (appSourceId && input.agencySourceIds.has(appSourceId)) continue
        if (!before(appliedAt(app), fact.applied_at)) continue

        priorApplications.push({
          application_id: app.id,
          candidate_id: app.candidate_id,
          job_id: app.job_id,
          job_title: input.jobsById.get(app.job_id)?.title ?? null,
          source_id: appSourceId,
          source_name: app.source?.name ?? null,
          status: app.status ?? null,
          current_stage_name: ghStageName(app),
          applied_at: appliedAt(app),
        })
        markDuplicate({
          fact,
          matchedCandidateId: app.candidate_id,
          confidence: "confirmed",
          evidence: ["email_exact"],
        })
      }

      if (priorApplications.length === 0) continue

      addConflictType(fact, "prior_history")
      fact.prior_internal_application_ids = [
        ...new Set([
          ...fact.prior_internal_application_ids,
          ...priorApplications.map((app) => app.application_id),
        ]),
      ].sort((a, b) => a - b)
      mergeConflictDetail(fact, { prior_history: priorApplications })
    }
  }
}

export function applyFeeRiskStates(input: {
  facts: YtdApplicationFact[]
  nowIso: string
}): void {
  for (const fact of input.facts) {
    if (fact.channel !== "agency") continue

    const confidence = fact.duplicate_confidence
    const actionHours = fact.first_action_time_hours
    const ageHours = hoursBetween(fact.submitted_at, input.nowIso)
    const duplicateIsFeeMaterial = confidence === "confirmed" || confidence === "high"
    const duplicateIsPossible = confidence === "possible"
    const noIdentity = confidence === "insufficient_data"

    let state: FeeRiskState = "not_duplicate"
    let reason: string | null = null

    if (noIdentity) {
      state = "insufficient_data"
      reason = "Not enough candidate identity data to rule out duplication."
    } else if (duplicateIsFeeMaterial) {
      if (typeof actionHours === "number" && actionHours <= 168) {
        state = "cleared_in_window"
        reason = "Duplicative candidate was actioned within 7 days."
      } else if (typeof actionHours === "number" && actionHours > 168) {
        state = "exposed"
        reason = "Duplicative candidate was first actioned after the 7-day window."
      } else if (typeof ageHours === "number" && ageHours > 168) {
        state = "exposed"
        reason = "Duplicative candidate has no first action after 7 days."
      } else if (typeof ageHours === "number" && ageHours >= 120) {
        state = "at_risk"
        reason = "Duplicative candidate is approaching the 7-day action window."
      } else {
        state = "pending_in_window"
        reason = "Duplicative candidate is still inside the 7-day action window."
      }
    } else if (duplicateIsPossible) {
      state = "at_risk"
      reason = "Possible duplicate needs evidence review before fee risk can be ruled out."
    } else {
      state = "not_duplicate"
      reason = null
    }

    fact.fee_risk_state = state
    fact.fee_risk_reason = reason
  }
}
