/**
 * Governed compatibility vocabulary for the six legacy reporting roles. The
 * source job names remain available separately; these labels preserve the
 * copied artifacts' historical display contract without embedding mappings in
 * Google renderers.
 */
export const LEGACY_ARTIFACT_DISPLAY_VERSION = "v1-2026-07-11"

export interface LegacyArtifactDisplayEntry {
  requisitionId: string
  greenhouseJobName: string
  allHiresCategory: "PE + FDE" | "FDL"
  allHiresJobName: string
}

export const legacyArtifactDisplayV1: readonly LegacyArtifactDisplayEntry[] = [
  {
    requisitionId: "890",
    greenhouseJobName: "Principal Forward Deployed AI Engineer, NY",
    allHiresCategory: "PE + FDE",
    allHiresJobName: "Principal Engineer - US",
  },
  {
    requisitionId: "907",
    greenhouseJobName: "Forward Deployed Engineer - US | Bench",
    allHiresCategory: "PE + FDE",
    allHiresJobName: "Forward Deployed Engineer, US (Bench)",
  },
  {
    requisitionId: "1026",
    greenhouseJobName: "Research Engineer, Code - US",
    allHiresCategory: "FDL",
    allHiresJobName: "Frontier Data Lead, Code - US",
  },
  {
    requisitionId: "1027",
    greenhouseJobName: "Research Engineer, RL Gyms - US",
    allHiresCategory: "FDL",
    allHiresJobName: "Frontier Data Lead - RL Gyms",
  },
  {
    requisitionId: "1118",
    greenhouseJobName: "Research Engineer - Brazil",
    allHiresCategory: "FDL",
    allHiresJobName: "Frontier Data Lead - Brazil",
  },
  {
    requisitionId: "1119",
    greenhouseJobName: "Research Engineer - Colombia",
    allHiresCategory: "FDL",
    allHiresJobName: "Frontier Data Lead - Colombia",
  },
] as const

/**
 * Exact compatibility policy encoded by the canonical Final Offer query.
 * This remains isolated from the platform-native offer facts so a later report
 * can adopt broader scope without rewriting source semantics.
 */
export const legacyFinalOfferParityV1 = {
  excludedApplicationRecruiterNames: ["Vikas Mehta"],
  excludedJobNames: [
    "Campus 2025 Hires",
    "Final Campus 2025 Hires",
    "Campus 2024 Hires",
    "US Interns",
  ],
  excludedOfferStatuses: ["deprecated"],
  excludedRejectionReasonNames: ["Duplicate"],
  departmentHods: [
    ...["Finance & Accounting", "Accounting & Tax", "Business Systems", "FP&A"].map((departmentName) => ({ departmentName, hodName: "Rohit Anand" })),
    ...["R&D / Engineering", "Product", "Research Lab", "Data Science"].map((departmentName) => ({ departmentName, hodName: "Neha Bhatt" })),
    { departmentName: "Legal", hodName: "Claire Laurent" },
    ...["People", "Facilities", "Recruiting"].map((departmentName) => ({ departmentName, hodName: "Evan Kessler" })),
    ...["Marketplace", "Fulfillment StratOps", "Talent Ops"].map((departmentName) => ({ departmentName, hodName: "Nakul Ahuja" })),
    ...["IT", "Security"].map((departmentName) => ({ departmentName, hodName: "Peter Blake" })),
    ...["Delivery", "Production Engineering"].map((departmentName) => ({ departmentName, hodName: "Dev Kapoor" })),
    { departmentName: "Sales", hodName: "Rona Bell" },
    ...["Marketing", "Brand Marketing", "Demand Generation"].map((departmentName) => ({ departmentName, hodName: "Jay Sundaram" })),
  ],
} as const

/**
 * Compatibility constants observed in the copied Delivery Roles RPS dump.
 * Existing copied rows are a continuity seed and unseen platform timestamps
 * append for the current Fri-Thu reporting window. date_order deliberately
 * remains a continuous one-based series from this historical anchor instead
 * of resetting with the week or quarter. This is artifact parity behavior,
 * not the identity or clock contract for modern analytics.
 */
export const legacyDeliveryRpsParityV1 = {
  dateOrderStart: "2026-03-13",
  reportingClock: "legacy_bic_reporting_at",
  reportingWindow: "friday_through_thursday",
  /**
   * The manual Cleaned_RPS transform materializes Date values in the copied
   * workbook's legacy India-time wall clock. These are compatibility-only
   * display constants; the platform source and modern analytics stay in UTC.
   */
  cleanedSheetLocale: "en_US",
  cleanedSheetTimeZone: "Asia/Calcutta",
  cleanedSheetUtcOffsetMinutes: 330,
  /** Exact role portfolio observed in the copied canonical Raw_Daily_RPS dump. */
  requisitionIds: ["752", "774", "907", "993", "1193", "1206", "8888"],
} as const

/**
 * Compatibility bounds for the copied RPS Tracking ledger. The canonical
 * week_order is continuous from 02 Mar 2026 (week 1); this is not a quarterly
 * reset. The copied Data Dump currently has rows 2..4251 available for data.
 */
export const legacyRpsTrackingParityV1 = {
  submittedAtStart: "2026-03-02",
  periodStartMonday: "2026-03-02",
  dataRowCapacity: 4_250,
} as const

export function isGovernedDeliveryRole(input: {
  requisitionId?: string | null
  jobName?: string | null
  departmentName?: string | null
  classification?: string | null
}): boolean {
  const requisitionId = input.requisitionId?.trim()
  if (requisitionId) {
    return (legacyDeliveryRpsParityV1.requisitionIds as readonly string[]).includes(requisitionId)
  }
  return /delivery|fulfillment/i.test(
    [input.jobName, input.departmentName, input.classification].filter(Boolean).join(" ")
  )
}
