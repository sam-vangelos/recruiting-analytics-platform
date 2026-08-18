export const SWEEP_CONFIG = {
  referral: {
    // Greenhouse sources whose type.id === 4000002004 ("Referral"). Recon on
    // 2026-05-28 via mcp__greenhouse__list_sources (396 sources, complete page)
    // found exactly one: id 4000194004 ("Referral"). The spec's "found 2" was a
    // raw-string artifact — source id 4000002004 ("RepVue") collides with the
    // type-id string but is actually type.id 4000003004 ("Prospecting").
    // Kept as an array so consumers join with commas regardless of count.
    sourceIds: ["4000194004"],
    lookbackHours: 48,
    slaDeadlineHours: 48,
    slaBreachHours: 48,
    slaRiskHours: 36,
    slaAlertedHours: 24,
  },
  agency: {
    lookbackHours: 72,
    concurrency: 5,
    actionDeadlineDays: 7,
  },
  slack: {
    headOfTaUserId: process.env.SWEEP_HEAD_OF_TA_SLACK_ID || "U00000000001",
    // Who hears about the weekly recruiting-artifact runs. The same person as
    // headOfTaUserId today, kept separate because the two answer different
    // questions — one routes candidate SLA alerts, this one routes "did the
    // reports update" — and either can move without dragging the other along.
    recruitingOpsAlertUserId:
      process.env.SWEEP_RECRUITING_OPS_ALERT_SLACK_ID ||
      process.env.SWEEP_HEAD_OF_TA_SLACK_ID ||
      "U00000000001",
  },
  // Removed 2026-05-28: `nonAgencySourceTypes` (the "inverted filter" allowlist)
  // had zero readers repo-wide — agency identification now runs through the
  // source registry in lib/agency-resolver.ts. Dead config, not a live contract.
} as const
