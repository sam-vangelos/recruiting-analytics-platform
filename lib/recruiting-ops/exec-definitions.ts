/**
 * Exec state-of-play business definitions — the single home for the funnel
 * order, stage resolution, health and momentum rules, requisition
 * classification, and reporting windows. Pure: no I/O, no env reads, no
 * candidate-identifying fields. The module, the page, and the ELT renderer
 * consume these; none of them re-declare a threshold or a stage order.
 *
 * The load-bearing correction over the retired sidecar: the unclassified
 * bucket is TERMINAL-UNORDERED (`order: null`), so it can never satisfy an
 * at-or-beyond comparison. The sidecar placed its catch-all at the top of the
 * ordinal scale and three `>=` comparisons silently promoted unknown stages
 * into finalists and advances.
 */

export const EXEC_FUNNEL_STAGES = [
  "Sourced",
  "Application Review",
  "Recruiter Phone Screen",
  "Hiring Manager Review",
  "Manager / Tech Screen",
  "Skills Assessment",
  "Onsite Interview",
  "Offer",
] as const

export type ExecFunnelStage = (typeof EXEC_FUNNEL_STAGES)[number]

/** Display label for in-process candidates whose stage could not be classified. */
export const UNCLASSIFIED_STAGE_LABEL = "Other in-process"

export const FINALIST_FROM_STAGE: ExecFunnelStage = "Skills Assessment"
export const ADVANCE_FROM_STAGE: ExecFunnelStage = "Recruiter Phone Screen"

export const ACTIVITY_WINDOW_DAYS = 14
export const OFFERS_TRAILING_DAYS = 84
export const RAMP_UP_GRACE_DAYS = 14

export interface FunnelStageResolution {
  stage: ExecFunnelStage | typeof UNCLASSIFIED_STAGE_LABEL
  /** Position in EXEC_FUNNEL_STAGES; null when unclassified — excluded from every ordinal comparison. */
  order: number | null
  source: "governed" | "heuristic" | "unclassified"
  rawLabel: string
}

export interface GovernedFunnelEntry {
  stage: ExecFunnelStage
  order: number
}

/**
 * Build the governed lookup from taxonomy rows that carry funnel columns.
 * Rows with no funnel mapping (legacy 3-class rows) are simply absent here —
 * they fall through to the heuristic and emit a gap upstream.
 */
export function buildGovernedFunnelMap(
  rows: readonly { stageLabel: string; funnelStage?: string | null }[]
): ReadonlyMap<string, GovernedFunnelEntry> {
  const map = new Map<string, GovernedFunnelEntry>()
  for (const row of rows) {
    const funnelStage = row.funnelStage?.trim()
    if (!funnelStage) continue
    const order = (EXEC_FUNNEL_STAGES as readonly string[]).indexOf(funnelStage)
    if (order < 0) continue
    map.set(normalizeStageLabel(row.stageLabel), { stage: EXEC_FUNNEL_STAGES[order], order })
  }
  return map
}

export function normalizeStageLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ")
}

export function resolveFunnelStage(
  rawLabel: string,
  governed: ReadonlyMap<string, GovernedFunnelEntry>
): FunnelStageResolution {
  const raw = rawLabel ?? ""
  const normalized = normalizeStageLabel(raw)
  if (!normalized) {
    return { stage: UNCLASSIFIED_STAGE_LABEL, order: null, source: "unclassified", rawLabel: raw }
  }
  const governedHit = governed.get(normalized)
  if (governedHit) {
    return { stage: governedHit.stage, order: governedHit.order, source: "governed", rawLabel: raw }
  }
  const heuristic = heuristicFunnelStage(normalized)
  if (heuristic) {
    const order = EXEC_FUNNEL_STAGES.indexOf(heuristic)
    return { stage: heuristic, order, source: "heuristic", rawLabel: raw }
  }
  return { stage: UNCLASSIFIED_STAGE_LABEL, order: null, source: "unclassified", rawLabel: raw }
}

function heuristicFunnelStage(normalized: string): ExecFunnelStage | null {
  if (normalized.includes("offer")) return "Offer"
  if (
    normalized.includes("onsite") ||
    normalized.includes("on-site") ||
    normalized.includes("panel") ||
    normalized.includes("final")
  ) {
    return "Onsite Interview"
  }
  if (
    normalized.includes("assessment") ||
    normalized.includes("take home") ||
    normalized.includes("take-home") ||
    normalized.includes("test")
  ) {
    return "Skills Assessment"
  }
  if (
    normalized.includes("tech screen") ||
    normalized.includes("technical") ||
    normalized.includes("manager /") ||
    normalized.includes("manager screen") ||
    normalized.includes("hiring manager screen")
  ) {
    return "Manager / Tech Screen"
  }
  if (normalized.includes("hiring manager") || normalized === "hm" || normalized.startsWith("hm ") || normalized.includes("hiring team")) {
    return "Hiring Manager Review"
  }
  if (
    normalized.includes("phone screen") ||
    normalized.includes("recruiter screen") ||
    normalized.includes("rps") ||
    normalized.includes("preliminary")
  ) {
    return "Recruiter Phone Screen"
  }
  if (normalized.includes("application review") || normalized.includes("new application") || normalized.includes("application")) {
    return "Application Review"
  }
  if (normalized.includes("sourc") || normalized.includes("prospect")) return "Sourced"
  if (normalized.includes("interview")) return "Onsite Interview"
  return null
}

/**
 * The single choke-point for every "at or beyond stage X" question. An
 * unclassified resolution (order null) is NEVER at-or-beyond anything.
 */
export function stageAtOrBeyond(resolution: Pick<FunnelStageResolution, "order">, target: ExecFunnelStage): boolean {
  if (resolution.order === null) return false
  return resolution.order >= EXEC_FUNNEL_STAGES.indexOf(target)
}

// ---------------------------------------------------------------- req class

export type ReqClass = "role" | "pool" | "campaign" | "template"

export interface ReqClassification {
  reqClass: ReqClass
  /** The signal that fired, for the gap message; absent for plain roles. */
  signal?: string
}

const POOL_PATTERNS: readonly RegExp[] = [/\bpool\b/i, /\bopportunistic\b/i, /\bicml\b/i, /holding bucket/i]
// "AGI Hunters" (req 865) is operated as a tracked role on the canonical
// Weekly Recruitment surface. A broad /hunters/ heuristic incorrectly hid it;
// only explicit recruiting-strike campaigns remain campaign-classified.
const CAMPAIGN_PATTERNS: readonly RegExp[] = [/recruiting strike/i]
const TEMPLATE_PATTERNS: readonly RegExp[] = [/\btemplate\b/i]

export function classifyReq(input: { name: string; isTemplate?: boolean }): ReqClassification {
  if (input.isTemplate === true) return { reqClass: "template", signal: "is_template" }
  const name = input.name ?? ""
  for (const pattern of TEMPLATE_PATTERNS) {
    if (pattern.test(name)) return { reqClass: "template", signal: String(pattern) }
  }
  for (const pattern of CAMPAIGN_PATTERNS) {
    if (pattern.test(name)) return { reqClass: "campaign", signal: String(pattern) }
  }
  for (const pattern of POOL_PATTERNS) {
    if (pattern.test(name)) return { reqClass: "pool", signal: String(pattern) }
  }
  return { reqClass: "role" }
}

// ------------------------------------------------------------------- health

export interface ReqActivityFacts {
  /** Open seats (openings with open=true). */
  seats: number
  /** In-process candidates at a classified stage >= Recruiter Phone Screen. */
  engagedDepth: number
  /** In-process candidates at Sourced / Application Review — the top-of-funnel mass. */
  applicationPile: number
  /** In-process candidates whose stage could not be classified. */
  unclassifiedCount: number
  daysOpen: number | null
  conductedLast7: number
  conductedPrior7: number
  advancedLast7: number
  advancedPrior7: number
  addedLast7: number
}

export type ExecHealth = "red" | "amber" | "green"

export interface HealthVerdict {
  health: ExecHealth
  ruleId: "no_pipeline" | "stalled_14d" | "stopped_this_week" | "thin_vs_seats" | "ramping" | "active_pipeline"
  reason: string
}

/**
 * Named, ordered, first-match rules. Every row gets a reason — green included.
 * Idle-days is deliberately not an input: activity is interviews conducted
 * (scorecard events) and stage advances, never "someone touched the record".
 */
export function healthOf(facts: ReqActivityFacts): HealthVerdict {
  const conducted14 = facts.conductedLast7 + facts.conductedPrior7
  const advanced14 = facts.advancedLast7 + facts.advancedPrior7
  const anyCandidates = facts.engagedDepth + facts.applicationPile + facts.unclassifiedCount > 0
  const last7 = facts.conductedLast7 + facts.advancedLast7
  const prior7 = facts.conductedPrior7 + facts.advancedPrior7
  const youngReq = facts.daysOpen !== null && facts.daysOpen <= RAMP_UP_GRACE_DAYS

  if (!anyCandidates && facts.seats > 0) {
    return {
      health: "red",
      ruleId: "no_pipeline",
      reason: `No candidates in process against ${facts.seats} open seat${facts.seats === 1 ? "" : "s"}`,
    }
  }
  if (anyCandidates && conducted14 === 0 && advanced14 === 0 && !youngReq) {
    return {
      health: "red",
      ruleId: "stalled_14d",
      reason: "No interviews conducted or stage advances in the last 14 days",
    }
  }
  if (anyCandidates && conducted14 === 0 && advanced14 === 0 && youngReq) {
    return {
      health: "amber",
      ruleId: "ramping",
      reason: `Recently opened (${facts.daysOpen}d) — pipeline forming, no interviews yet`,
    }
  }
  if (last7 === 0 && prior7 > 0) {
    return {
      health: "amber",
      ruleId: "stopped_this_week",
      reason: `Activity stopped this week — ${prior7} event${prior7 === 1 ? "" : "s"} the week before, none in the last 7 days`,
    }
  }
  if (facts.engagedDepth < facts.seats && !youngReq) {
    return {
      health: "amber",
      ruleId: "thin_vs_seats",
      reason: `${facts.engagedDepth} candidate${facts.engagedDepth === 1 ? "" : "s"} beyond screen for ${facts.seats} open seat${facts.seats === 1 ? "" : "s"}`,
    }
  }
  return {
    health: "green",
    ruleId: "active_pipeline",
    reason: `${conducted14} interview${conducted14 === 1 ? "" : "s"} conducted, ${advanced14} advance${advanced14 === 1 ? "" : "s"} in the last 14 days`,
  }
}

// ----------------------------------------------------------------- momentum

export type MomentumLabel = "moving" | "slowing" | "stalled this week" | "sourcing only" | "dormant"

export function momentumOf(facts: {
  conductedLast7: number
  conductedPrior7: number
  advancedLast7: number
  advancedPrior7: number
  addedLast7: number
}): MomentumLabel {
  const last7 = facts.conductedLast7 + facts.advancedLast7
  const prior7 = facts.conductedPrior7 + facts.advancedPrior7
  if (last7 > 0 && last7 >= prior7) return "moving"
  if (last7 > 0) return "slowing"
  if (prior7 > 0) return "stalled this week"
  if (facts.addedLast7 > 0) return "sourcing only"
  return "dormant"
}

// -------------------------------------------------------------------- tiers
// Content contract §1 (EXEC_SURFACE_CONTENT_SPEC.md): the liveness axis that
// health deliberately does not carry. Health asks "is hiring progressing";
// the tier asks "is this requisition a live search at all". Both are named,
// ordered, first-match rule sets so every verdict carries its reason.

export const TIER_ACTIVITY_WINDOW_DAYS = 30

export type ExecTier = "in_play" | "gone_quiet" | "filled_not_closed" | "no_search"

export interface TierFacts {
  /** Interviews conducted (submitted scorecards) in the trailing 30 days. */
  conducted30: number
  /** Stage advances (at/beyond the advance stage) in the trailing 30 days. */
  advanced30: number
  /** Top-of-funnel adds in the trailing 7 days — a recruiter feeding the req. */
  addedLast7: number
  /**
   * Days since the most recent stage entry across the req's engaged
   * applications' full histories (unbounded); null when no engaged apps.
   */
  lastAdvanceDays: number | null
  daysOpen: number | null
  engagedDepth: number
  offersAccepted12wk: number
}

export interface TierVerdict {
  tier: ExecTier
  ruleId:
    | "moving_30d"
    | "sourcing_now"
    | "advance_within_30d"
    | "ramping_grace"
    | "pipeline_parked"
    | "filled_still_open"
    | "no_search"
  reason: string
}

export function tierOf(facts: TierFacts): TierVerdict {
  if (facts.conducted30 > 0 || facts.advanced30 > 0) {
    return {
      tier: "in_play",
      ruleId: "moving_30d",
      reason: `${facts.conducted30} interview${facts.conducted30 === 1 ? "" : "s"} and ${facts.advanced30} advance${facts.advanced30 === 1 ? "" : "s"} in the last ${TIER_ACTIVITY_WINDOW_DAYS} days`,
    }
  }
  if (facts.addedLast7 > 0) {
    return {
      tier: "in_play",
      ruleId: "sourcing_now",
      reason: `${facts.addedLast7} applicant${facts.addedLast7 === 1 ? "" : "s"} added in the last 7 days`,
    }
  }
  if (facts.lastAdvanceDays !== null && facts.lastAdvanceDays <= TIER_ACTIVITY_WINDOW_DAYS) {
    return {
      tier: "in_play",
      ruleId: "advance_within_30d",
      reason: `Last stage advance ${facts.lastAdvanceDays} day${facts.lastAdvanceDays === 1 ? "" : "s"} ago`,
    }
  }
  if (facts.daysOpen !== null && facts.daysOpen <= RAMP_UP_GRACE_DAYS) {
    return {
      tier: "in_play",
      ruleId: "ramping_grace",
      reason: `Opened ${facts.daysOpen} day${facts.daysOpen === 1 ? "" : "s"} ago — pipeline forming`,
    }
  }
  if (facts.engagedDepth > 0) {
    return {
      tier: "gone_quiet",
      ruleId: "pipeline_parked",
      reason:
        facts.lastAdvanceDays === null
          ? `${facts.engagedDepth} candidate${facts.engagedDepth === 1 ? "" : "s"} parked mid-process with no recorded stage movement`
          : `Nothing has moved in ${facts.lastAdvanceDays} days; ${facts.engagedDepth} candidate${facts.engagedDepth === 1 ? "" : "s"} parked mid-process`,
    }
  }
  if (facts.offersAccepted12wk > 0) {
    return {
      tier: "filled_not_closed",
      ruleId: "filled_still_open",
      reason: `Hired ${facts.offersAccepted12wk} in the last 12 weeks; requisition still open with nothing in pipeline`,
    }
  }
  return {
    tier: "no_search",
    ruleId: "no_search",
    reason: "No candidates, no interview activity, no recent hires",
  }
}

// ---------------------------------------------------------------- attention
// Within Tier 1 only: what makes an in-play search lead the page. Ordered by
// severity; a req may fire several — the first is its sort key, all render.

export const ATTENTION_OFFER_WAIT_DAYS = 14
export const ATTENTION_ONSITE_WAIT_DAYS = 30
export const ATTENTION_FEEDBACK_BACKLOG = 8

export interface AttentionFacts {
  offerCount: number
  offerOldestDays: number | null
  onsiteCount: number
  onsiteOldestDays: number | null
  conductedLast7: number
  conductedPrior7: number
  advancedLast7: number
  advancedPrior7: number
  addedLast7: number
  engagedDepth: number
  pendingWriteups: number
  owned: boolean
  lastAdvanceDays: number | null
}

export interface AttentionFlag {
  ruleId:
    | "offer_waiting"
    | "onsite_waiting"
    | "stopped_this_week"
    | "feedback_backlog"
    | "unowned"
    | "quiet_two_weeks"
  /** Lower = more severe; the first flag is the row's sort key. */
  severity: number
  /** Tiebreak within a severity band; larger = waited longer = worse. */
  waitDays: number
  reason: string
}

export function attentionOf(facts: AttentionFacts): AttentionFlag[] {
  const flags: AttentionFlag[] = []
  if (facts.offerCount > 0 && (facts.offerOldestDays ?? 0) >= ATTENTION_OFFER_WAIT_DAYS) {
    const days = facts.offerOldestDays as number
    flags.push({
      ruleId: "offer_waiting",
      severity: 0,
      waitDays: days,
      reason:
        facts.offerCount === 1
          ? `Offer out ${days} days — no response logged`
          : `${facts.offerCount} offers out, oldest ${days} days — no response logged`,
    })
  }
  if (facts.onsiteCount > 0 && (facts.onsiteOldestDays ?? 0) >= ATTENTION_ONSITE_WAIT_DAYS) {
    const days = facts.onsiteOldestDays as number
    flags.push({
      ruleId: "onsite_waiting",
      severity: 1,
      waitDays: days,
      reason: `Onsite candidate waiting ${days} days`,
    })
  }
  const last7 = facts.conductedLast7 + facts.advancedLast7
  const prior7 = facts.conductedPrior7 + facts.advancedPrior7
  if (last7 === 0 && prior7 > 0 && facts.engagedDepth > 0) {
    flags.push({
      ruleId: "stopped_this_week",
      severity: 2,
      waitDays: prior7,
      reason: `Activity stopped this week — ${prior7} event${prior7 === 1 ? "" : "s"} the week before, none since`,
    })
  }
  if (facts.pendingWriteups >= ATTENTION_FEEDBACK_BACKLOG) {
    flags.push({
      ruleId: "feedback_backlog",
      severity: 3,
      waitDays: facts.pendingWriteups,
      reason: `${facts.pendingWriteups} interviews awaiting feedback`,
    })
  }
  if (!facts.owned) {
    flags.push({ ruleId: "unowned", severity: 4, waitDays: 0, reason: "No recruiter assigned" })
  }
  if (
    last7 + prior7 === 0 &&
    facts.addedLast7 === 0 &&
    facts.lastAdvanceDays !== null &&
    facts.lastAdvanceDays > ACTIVITY_WINDOW_DAYS &&
    facts.lastAdvanceDays <= TIER_ACTIVITY_WINDOW_DAYS
  ) {
    flags.push({
      ruleId: "quiet_two_weeks",
      severity: 5,
      waitDays: facts.lastAdvanceDays,
      reason: `Nothing has moved in ${facts.lastAdvanceDays} days`,
    })
  }
  flags.sort((a, b) => a.severity - b.severity || b.waitDays - a.waitDays)
  return flags
}

// ------------------------------------------------------------------ windows

const MS_PER_DAY = 86_400_000

/** ISO date (UTC) of the most recent Friday at or before `now` — the reporting week's anchor. */
export function fridayWeekStartUtc(now: Date): string {
  const day = now.getUTCDay()
  const sinceFriday = (day - 5 + 7) % 7
  const friday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - sinceFriday))
  return friday.toISOString().slice(0, 10)
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

function formatShort(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
}

/** Fri–Thu reporting-week labels in the legacy document's format. */
export function fridayWeekLabels(fridayIso: string): { weekLabel: string; weekShort: string } {
  const start = new Date(`${fridayIso}T00:00:00.000Z`)
  const end = new Date(start.getTime() + 6 * MS_PER_DAY)
  const weekLabel = `${formatShort(start)}, ${start.getUTCFullYear()} - ${formatShort(end)}, ${end.getUTCFullYear()}`
  return { weekLabel, weekShort: `${formatShort(start)} - ${formatShort(end)}` }
}

/** Quarter of the REPORTING week's Friday — not of "today" — so QTD survives quarter turns. */
export function reportingQuarter(fridayIso: string): { label: string; startIso: string } {
  const friday = new Date(`${fridayIso}T00:00:00.000Z`)
  const quarter = Math.floor(friday.getUTCMonth() / 3)
  const start = new Date(Date.UTC(friday.getUTCFullYear(), quarter * 3, 1))
  return { label: `Q${quarter + 1} ${friday.getUTCFullYear()}`, startIso: start.toISOString().slice(0, 10) }
}

/**
 * The ELT doc's reporting week (Fri–Thu). The legacy doc is written ON its
 * Thursday deadline covering the week ending that day; generated any other
 * day, the report covers the last COMPLETE week.
 */
export function eltReportingFriday(now: Date): string {
  const anchor = fridayWeekStartUtc(now)
  if (now.getUTCDay() === 4) return anchor // Thursday: the week ending today
  const prior = new Date(Date.parse(`${anchor}T00:00:00.000Z`) - 7 * MS_PER_DAY)
  return prior.toISOString().slice(0, 10)
}

// ------------------------------------------------------------- ELT contract

/** Legacy ELT sections: pinned focus requisitions, split by sub-role. */
export const ELT_SECTIONS = [
  { title: "FDE + PE", subs: [{ label: "PE", reqId: 890 }, { label: "FDE", reqId: 907 }] },
  { title: "FDL Code + RL (U.S.)", subs: [{ label: "Code", reqId: 1026 }, { label: "RL", reqId: 1027 }] },
  { title: "FDL (Brazil + Colombia)", subs: [{ label: "Brazil", reqId: 1118 }, { label: "Colombia", reqId: 1119 }] },
] as const

/** Legacy ELT stage lines mapped to the canonical funnel stages. */
export const ELT_STAGES = [
  { label: "RPS", funnelStage: "Recruiter Phone Screen" },
  { label: "HM Review", funnelStage: "Hiring Manager Review" },
  { label: "Manager/Tech Screen", funnelStage: "Manager / Tech Screen" },
  { label: "Assessment", funnelStage: "Skills Assessment" },
  { label: "Onsite Interviews", funnelStage: "Onsite Interview" },
] as const satisfies readonly { label: string; funnelStage: ExecFunnelStage }[]

export interface ActivityWindows {
  last7StartMs: number
  prior7StartMs: number
  nowMs: number
}

export function activityWindows(nowMs: number): ActivityWindows {
  return {
    nowMs,
    last7StartMs: nowMs - 7 * MS_PER_DAY,
    prior7StartMs: nowMs - 14 * MS_PER_DAY,
  }
}

/** Which half of the trailing 14-day window a timestamp falls in, if any. */
export function windowHalfOf(timestampMs: number, windows: ActivityWindows): "last7" | "prior7" | null {
  if (Number.isNaN(timestampMs)) return null
  if (timestampMs > windows.nowMs) return null
  if (timestampMs >= windows.last7StartMs) return "last7"
  if (timestampMs >= windows.prior7StartMs) return "prior7"
  return null
}
