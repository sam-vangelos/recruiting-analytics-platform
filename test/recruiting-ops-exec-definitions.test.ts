import { describe, expect, test } from "vitest"

import {
  ACTIVITY_WINDOW_DAYS,
  ADVANCE_FROM_STAGE,
  ATTENTION_FEEDBACK_BACKLOG,
  ATTENTION_OFFER_WAIT_DAYS,
  ATTENTION_ONSITE_WAIT_DAYS,
  EXEC_FUNNEL_STAGES,
  FINALIST_FROM_STAGE,
  RAMP_UP_GRACE_DAYS,
  TIER_ACTIVITY_WINDOW_DAYS,
  UNCLASSIFIED_STAGE_LABEL,
  activityWindows,
  attentionOf,
  buildGovernedFunnelMap,
  classifyReq,
  fridayWeekLabels,
  fridayWeekStartUtc,
  healthOf,
  momentumOf,
  normalizeStageLabel,
  reportingQuarter,
  resolveFunnelStage,
  stageAtOrBeyond,
  tierOf,
  windowHalfOf,
  type AttentionFacts,
  type ReqActivityFacts,
  type TierFacts,
} from "../lib/recruiting-ops/exec-definitions"

const NO_GOVERNED = new Map()

function facts(overrides: Partial<ReqActivityFacts>): ReqActivityFacts {
  return {
    seats: 1,
    engagedDepth: 0,
    applicationPile: 0,
    unclassifiedCount: 0,
    daysOpen: 30,
    conductedLast7: 0,
    conductedPrior7: 0,
    advancedLast7: 0,
    advancedPrior7: 0,
    addedLast7: 0,
    ...overrides,
  }
}

describe("stage resolution", () => {
  test("governed mapping wins over the heuristic", () => {
    const governed = buildGovernedFunnelMap([
      { stageLabel: "Take Home Test", funnelStage: "Manager / Tech Screen" },
    ])
    const resolved = resolveFunnelStage("Take Home Test", governed)
    expect(resolved.stage).toBe("Manager / Tech Screen")
    expect(resolved.source).toBe("governed")
    // The heuristic alone would have called this Skills Assessment.
    const heuristic = resolveFunnelStage("Take Home Test", NO_GOVERNED)
    expect(heuristic.stage).toBe("Skills Assessment")
    expect(heuristic.source).toBe("heuristic")
  })

  test("governed lookup normalizes case and whitespace", () => {
    const governed = buildGovernedFunnelMap([{ stageLabel: "  Paper   Review ", funnelStage: "Onsite Interview" }])
    const resolved = resolveFunnelStage("paper review", governed)
    expect(resolved.stage).toBe("Onsite Interview")
    expect(resolved.source).toBe("governed")
  })

  test("unknown labels resolve to the unclassified bucket with a null order", () => {
    const resolved = resolveFunnelStage("Vibe Alignment Circle", NO_GOVERNED)
    expect(resolved.stage).toBe(UNCLASSIFIED_STAGE_LABEL)
    expect(resolved.order).toBeNull()
    expect(resolved.source).toBe("unclassified")
  })

  test("empty labels resolve to unclassified", () => {
    expect(resolveFunnelStage("", NO_GOVERNED).source).toBe("unclassified")
    expect(resolveFunnelStage("   ", NO_GOVERNED).order).toBeNull()
  })

  test("buildGovernedFunnelMap drops rows without a valid funnel stage", () => {
    const governed = buildGovernedFunnelMap([
      { stageLabel: "Legacy Row", funnelStage: null },
      { stageLabel: "Bad Stage", funnelStage: "Not A Stage" },
      { stageLabel: "Good Row", funnelStage: "Offer" },
    ])
    expect(governed.size).toBe(1)
    expect(governed.get(normalizeStageLabel("Good Row"))?.stage).toBe("Offer")
  })
})

describe("stageAtOrBeyond — the ordinal choke-point", () => {
  test("an unclassified stage is NEVER at-or-beyond anything", () => {
    const unclassified = resolveFunnelStage("Mystery Stage", NO_GOVERNED)
    expect(stageAtOrBeyond(unclassified, FINALIST_FROM_STAGE)).toBe(false)
    expect(stageAtOrBeyond(unclassified, ADVANCE_FROM_STAGE)).toBe(false)
    expect(stageAtOrBeyond(unclassified, "Sourced")).toBe(false)
  })

  test("classified stages compare by funnel order", () => {
    const onsite = resolveFunnelStage("Onsite Interview", NO_GOVERNED)
    const rps = resolveFunnelStage("Recruiter Phone Screen", NO_GOVERNED)
    expect(stageAtOrBeyond(onsite, FINALIST_FROM_STAGE)).toBe(true)
    expect(stageAtOrBeyond(rps, FINALIST_FROM_STAGE)).toBe(false)
    expect(stageAtOrBeyond(rps, ADVANCE_FROM_STAGE)).toBe(true)
  })

  test("the funnel order is the canonical eight stages", () => {
    expect(EXEC_FUNNEL_STAGES).toHaveLength(8)
    expect(EXEC_FUNNEL_STAGES[0]).toBe("Sourced")
    expect(EXEC_FUNNEL_STAGES[7]).toBe("Offer")
  })
})

describe("req classification", () => {
  test("is_template field wins before any name pattern", () => {
    expect(classifyReq({ name: "Senior Engineer", isTemplate: true }).reqClass).toBe("template")
  })

  test("known non-role names classify with a signal", () => {
    expect(classifyReq({ name: "Job Template" }).reqClass).toBe("template")
    expect(classifyReq({ name: "General Pool - ICLR" }).reqClass).toBe("pool")
    expect(classifyReq({ name: "ICML 2026 Candidates" }).reqClass).toBe("pool")
    expect(classifyReq({ name: "Opportunistic Hires" }).reqClass).toBe("pool")
    expect(classifyReq({ name: "Recruiting Strike Mercor - US" }).reqClass).toBe("campaign")
    expect(classifyReq({ name: "AGI Hunters" }).reqClass).toBe("role")
    expect(classifyReq({ name: "General Pool - ICLR" }).signal).toBeTruthy()
  })

  test("ordinary roles classify as role with no signal", () => {
    const plain = classifyReq({ name: "Senior Software Engineer, Delivery - US" })
    expect(plain.reqClass).toBe("role")
    expect(plain.signal).toBeUndefined()
  })
})

describe("healthOf — named rules, every row gets a reason", () => {
  test("no_pipeline: open seats with zero candidates is red", () => {
    const verdict = healthOf(facts({ seats: 2 }))
    expect(verdict).toMatchObject({ health: "red", ruleId: "no_pipeline" })
    expect(verdict.reason).toContain("2 open seats")
  })

  test("stalled_14d: candidates but zero conducted and zero advances on an aging req is red", () => {
    const verdict = healthOf(facts({ engagedDepth: 33, applicationPile: 4754, daysOpen: 120 }))
    expect(verdict).toMatchObject({ health: "red", ruleId: "stalled_14d" })
  })

  test("a huge application pile alone never makes a req green", () => {
    // The retired workbook's worst failure: 4,787 'active' candidates, green.
    const verdict = healthOf(facts({ applicationPile: 4787, engagedDepth: 0, daysOpen: 200 }))
    expect(verdict.health).toBe("red")
  })

  test("ramping: a young req with no activity yet is amber, not red", () => {
    const verdict = healthOf(facts({ applicationPile: 10, daysOpen: 5 }))
    expect(verdict).toMatchObject({ health: "amber", ruleId: "ramping" })
  })

  test("stopped_this_week: activity last week, none this week is amber", () => {
    const verdict = healthOf(facts({ engagedDepth: 5, seats: 1, conductedPrior7: 3, daysOpen: 40 }))
    expect(verdict).toMatchObject({ health: "amber", ruleId: "stopped_this_week" })
    expect(verdict.reason).toContain("3 events")
  })

  test("thin_vs_seats: moving but fewer engaged candidates than seats is amber", () => {
    const verdict = healthOf(facts({ engagedDepth: 1, seats: 5, conductedLast7: 2, daysOpen: 40 }))
    expect(verdict).toMatchObject({ health: "amber", ruleId: "thin_vs_seats" })
  })

  test("green carries a data-bearing reason, never an empty status", () => {
    const verdict = healthOf(
      facts({ engagedDepth: 6, seats: 2, conductedLast7: 2, conductedPrior7: 1, advancedLast7: 1, daysOpen: 40 })
    )
    expect(verdict).toMatchObject({ health: "green", ruleId: "active_pipeline" })
    expect(verdict.reason).toContain("3 interviews")
    expect(verdict.reason).toContain("1 advance")
  })

  test("young reqs are not flagged thin while ramping", () => {
    const verdict = healthOf(facts({ engagedDepth: 0, applicationPile: 12, seats: 3, daysOpen: 7 }))
    expect(verdict.ruleId).toBe("ramping")
  })
})

describe("momentumOf", () => {
  test("labels each trend state", () => {
    expect(momentumOf({ conductedLast7: 2, conductedPrior7: 1, advancedLast7: 0, advancedPrior7: 0, addedLast7: 0 })).toBe("moving")
    expect(momentumOf({ conductedLast7: 1, conductedPrior7: 3, advancedLast7: 0, advancedPrior7: 1, addedLast7: 0 })).toBe("slowing")
    expect(momentumOf({ conductedLast7: 0, conductedPrior7: 2, advancedLast7: 0, advancedPrior7: 0, addedLast7: 0 })).toBe("stalled this week")
    expect(momentumOf({ conductedLast7: 0, conductedPrior7: 0, advancedLast7: 0, advancedPrior7: 0, addedLast7: 4 })).toBe("sourcing only")
    expect(momentumOf({ conductedLast7: 0, conductedPrior7: 0, advancedLast7: 0, advancedPrior7: 0, addedLast7: 0 })).toBe("dormant")
  })
})

describe("reporting windows", () => {
  test("fridayWeekStartUtc anchors to the most recent Friday", () => {
    expect(fridayWeekStartUtc(new Date("2026-07-06T12:00:00.000Z"))).toBe("2026-07-03") // a Monday
    expect(fridayWeekStartUtc(new Date("2026-07-03T00:00:00.000Z"))).toBe("2026-07-03") // Friday itself
    expect(fridayWeekStartUtc(new Date("2026-07-02T23:59:59.000Z"))).toBe("2026-06-26") // Thursday
  })

  test("week labels match the legacy document format", () => {
    const labels = fridayWeekLabels("2026-06-26")
    expect(labels.weekLabel).toBe("Jun 26, 2026 - Jul 2, 2026")
    expect(labels.weekShort).toBe("Jun 26 - Jul 2")
  })

  test("week labels carry both years across a year boundary", () => {
    const labels = fridayWeekLabels("2026-12-25")
    expect(labels.weekLabel).toBe("Dec 25, 2026 - Dec 31, 2026")
    expect(fridayWeekLabels("2027-01-01").weekLabel).toBe("Jan 1, 2027 - Jan 7, 2027")
  })

  test("QTD anchors to the reporting week's quarter, not today's", () => {
    expect(reportingQuarter("2026-06-26")).toEqual({ label: "Q2 2026", startIso: "2026-04-01" })
    expect(reportingQuarter("2026-07-03")).toEqual({ label: "Q3 2026", startIso: "2026-07-01" })
  })

  test("windowHalfOf splits the trailing 14 days and rejects everything else", () => {
    expect(ACTIVITY_WINDOW_DAYS).toBe(14)
    const now = Date.parse("2026-07-06T00:00:00.000Z")
    const windows = activityWindows(now)
    const day = 86_400_000
    expect(windowHalfOf(now - 1 * day, windows)).toBe("last7")
    expect(windowHalfOf(now - 7 * day, windows)).toBe("last7") // boundary belongs to last7
    expect(windowHalfOf(now - 8 * day, windows)).toBe("prior7")
    expect(windowHalfOf(now - 14 * day, windows)).toBe("prior7")
    expect(windowHalfOf(now - 15 * day, windows)).toBe(null)
    expect(windowHalfOf(now + 1 * day, windows)).toBe(null)
    expect(windowHalfOf(Number.NaN, windows)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Tiers + attention (content contract §1) — first-match rules, every verdict
// carries its reason, thresholds tested at their exact boundaries.

const QUIET_TIER: TierFacts = {
  conducted30: 0,
  advanced30: 0,
  addedLast7: 0,
  lastAdvanceDays: null,
  daysOpen: 100,
  engagedDepth: 0,
  offersAccepted12wk: 0,
}

describe("tierOf — liveness, ordered first-match", () => {
  test("any conducted or advanced inside 30 days is in play", () => {
    expect(tierOf({ ...QUIET_TIER, conducted30: 1 })).toMatchObject({ tier: "in_play", ruleId: "moving_30d" })
    expect(tierOf({ ...QUIET_TIER, advanced30: 2 })).toMatchObject({ tier: "in_play", ruleId: "moving_30d" })
  })

  test("sourcing alone keeps a req in play", () => {
    expect(tierOf({ ...QUIET_TIER, addedLast7: 9 })).toMatchObject({ tier: "in_play", ruleId: "sourcing_now" })
  })

  test("the 30-day advance boundary is exact: 30 in play, 31 not", () => {
    expect(tierOf({ ...QUIET_TIER, lastAdvanceDays: TIER_ACTIVITY_WINDOW_DAYS, engagedDepth: 1 }).tier).toBe("in_play")
    const out = tierOf({ ...QUIET_TIER, lastAdvanceDays: TIER_ACTIVITY_WINDOW_DAYS + 1, engagedDepth: 1 })
    expect(out).toMatchObject({ tier: "gone_quiet", ruleId: "pipeline_parked" })
    expect(out.reason).toContain("31 days")
  })

  test("ramp-up grace: a brand-new empty req is in play, not abandoned", () => {
    expect(tierOf({ ...QUIET_TIER, daysOpen: RAMP_UP_GRACE_DAYS })).toMatchObject({
      tier: "in_play",
      ruleId: "ramping_grace",
    })
    expect(tierOf({ ...QUIET_TIER, daysOpen: RAMP_UP_GRACE_DAYS + 1 }).tier).toBe("no_search")
  })

  test("empty pipe + recent hires = filled_not_closed, not abandoned", () => {
    expect(tierOf({ ...QUIET_TIER, offersAccepted12wk: 3 })).toMatchObject({
      tier: "filled_not_closed",
      ruleId: "filled_still_open",
    })
  })

  test("empty, silent, hire-less reqs are no_search with a plain reason", () => {
    const verdict = tierOf(QUIET_TIER)
    expect(verdict).toMatchObject({ tier: "no_search", ruleId: "no_search" })
    expect(verdict.reason).toBe("No candidates, no interview activity, no recent hires")
  })

  test("parked pipeline with unknown movement still reads gone_quiet", () => {
    const verdict = tierOf({ ...QUIET_TIER, engagedDepth: 4, lastAdvanceDays: null })
    expect(verdict.tier).toBe("gone_quiet")
    expect(verdict.reason).toContain("no recorded stage movement")
  })
})

const CALM_ATTENTION: AttentionFacts = {
  offerCount: 0,
  offerOldestDays: null,
  onsiteCount: 0,
  onsiteOldestDays: null,
  conductedLast7: 1,
  conductedPrior7: 0,
  advancedLast7: 0,
  advancedPrior7: 0,
  addedLast7: 0,
  engagedDepth: 3,
  pendingWriteups: 0,
  owned: true,
  lastAdvanceDays: 2,
}

describe("attentionOf — severity-ordered flags", () => {
  test("a calm moving req fires nothing", () => {
    expect(attentionOf(CALM_ATTENTION)).toEqual([])
  })

  test("offer waiting fires at the exact threshold and outranks everything", () => {
    expect(attentionOf({ ...CALM_ATTENTION, offerCount: 1, offerOldestDays: ATTENTION_OFFER_WAIT_DAYS - 1 })).toEqual([])
    const flags = attentionOf({
      ...CALM_ATTENTION,
      offerCount: 1,
      offerOldestDays: ATTENTION_OFFER_WAIT_DAYS,
      onsiteCount: 1,
      onsiteOldestDays: 90,
      owned: false,
    })
    expect(flags.map((flag) => flag.ruleId)).toEqual(["offer_waiting", "onsite_waiting", "unowned"])
    expect(flags[0].reason).toBe(`Offer out ${ATTENTION_OFFER_WAIT_DAYS} days — no response logged`)
  })

  test("plural offers read as a count with the oldest wait", () => {
    const flags = attentionOf({ ...CALM_ATTENTION, offerCount: 2, offerOldestDays: 62 })
    expect(flags[0].reason).toBe("2 offers out, oldest 62 days — no response logged")
  })

  test("onsite wait threshold is exact", () => {
    expect(attentionOf({ ...CALM_ATTENTION, onsiteCount: 1, onsiteOldestDays: ATTENTION_ONSITE_WAIT_DAYS - 1 })).toEqual([])
    expect(
      attentionOf({ ...CALM_ATTENTION, onsiteCount: 1, onsiteOldestDays: ATTENTION_ONSITE_WAIT_DAYS })[0].ruleId
    ).toBe("onsite_waiting")
  })

  test("stopped_this_week needs people mid-process — an emptied conveyor req stays calm", () => {
    const stopped = { ...CALM_ATTENTION, conductedLast7: 0, conductedPrior7: 2, engagedDepth: 2 }
    expect(attentionOf(stopped)[0].ruleId).toBe("stopped_this_week")
    expect(attentionOf({ ...stopped, engagedDepth: 0 })).toEqual([])
  })

  test("feedback backlog fires at the floor, not below", () => {
    expect(attentionOf({ ...CALM_ATTENTION, pendingWriteups: ATTENTION_FEEDBACK_BACKLOG - 1 })).toEqual([])
    expect(attentionOf({ ...CALM_ATTENTION, pendingWriteups: ATTENTION_FEEDBACK_BACKLOG })[0].ruleId).toBe(
      "feedback_backlog"
    )
  })

  test("quiet_two_weeks covers only the 15–30 day band — beyond it the TIER demotes instead", () => {
    const silent = {
      ...CALM_ATTENTION,
      conductedLast7: 0,
      conductedPrior7: 0,
      advancedLast7: 0,
      advancedPrior7: 0,
    }
    expect(attentionOf({ ...silent, lastAdvanceDays: ACTIVITY_WINDOW_DAYS })).toEqual([])
    expect(attentionOf({ ...silent, lastAdvanceDays: ACTIVITY_WINDOW_DAYS + 1 })[0].ruleId).toBe("quiet_two_weeks")
    expect(attentionOf({ ...silent, lastAdvanceDays: TIER_ACTIVITY_WINDOW_DAYS })[0].ruleId).toBe("quiet_two_weeks")
    expect(attentionOf({ ...silent, lastAdvanceDays: TIER_ACTIVITY_WINDOW_DAYS + 1 })).toEqual([])
  })

  test("within a severity band the longer wait sorts first", () => {
    const flags = attentionOf({
      ...CALM_ATTENTION,
      onsiteCount: 2,
      onsiteOldestDays: 45,
      pendingWriteups: ATTENTION_FEEDBACK_BACKLOG,
    })
    expect(flags.map((flag) => flag.ruleId)).toEqual(["onsite_waiting", "feedback_backlog"])
  })
})

describe("holding buckets classify as pools (content contract §1.2)", () => {
  test("the Bengaluru/Gurugram parking reqs leave the roles set", () => {
    expect(classifyReq({ name: "GenAI Engineer, Bengaluru holding bucket - India" }).reqClass).toBe("pool")
    expect(classifyReq({ name: "GenAI Engineer, Gurugram holding bucket - India" }).reqClass).toBe("pool")
  })
})
