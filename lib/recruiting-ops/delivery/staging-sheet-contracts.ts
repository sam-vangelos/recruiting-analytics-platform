import type { StagingArtifactKey } from "./staging-artifact-registry"

export type StagingSheetContractId =
  | "weekly_recruitment_current"
  | "weekly_recruitment_a_c"
  | "weekly_recruitment_e_f"
  | "weekly_recruitment_h_i"
  | "weekly_recruitment_m_w"
  | "weekly_recruitment_y_z"
  | "weekly_progress_code_rl"
  | "weekly_progress_fde_pe"
  | "weekly_progress_brazil_colombia"
  | "all_hires_data"
  | "pipeline_890_candidate"
  | "pipeline_890_job_week"
  | "pipeline_907_candidate"
  | "pipeline_907_job_week"
  | "pipeline_1026_1027_candidate"
  | "pipeline_1026_1027_job_week"
  | "pipeline_1118_1119_candidate"
  | "pipeline_1118_1119_job_week"
  | "final_offer_master"
  | "final_offer_performance_data"
  | "final_offer_july_data"
  | "final_offer_august_data"
  | "final_offer_september_data"
  | "final_offer_october_data"
  | "final_offer_november_data"
  | "final_offer_december_data"
  | "final_offer_january_data"
  | "final_offer_february_data"
  | "final_offer_march_data"
  | "final_offer_april_data"
  | "final_offer_may_data"
  | "final_offer_june_data"
  | "rps_data_dump"
  | "delivery_rps_raw"
  | "delivery_rps_clean"
  | "delivery_rps_dated"

export interface StagingSheetRangeContract {
  id: StagingSheetContractId
  artifactKey: Exclude<StagingArtifactKey, "elt_doc">
  sheetId: number
  sheetTitle: string
  headerRow: number
  headers: readonly string[]
  /**
   * Optional physical header band above `headerRow`. Pipeline job summaries
   * use row 1 for merged stage-group labels and row 2 for the common fields
   * plus repeated Enter/Pass/Reject metrics.
   */
  groupedHeader?: {
    row: number
    headers: readonly string[]
  }
  upsertKeyHeaders: readonly string[]
  humanOwnedHeaders?: readonly string[]
  structuralNormalization?: string
  staticLayout?: {
    titleCell?: string
    titleTemplate?: string
    mergeRanges?: readonly string[]
    labels?: Readonly<Record<string, string>>
  }
}

const WEEKLY_RECRUITMENT_HEADERS = [
  "Job Name",
  "Job Status",
  "Req ID",
  "Billable (Y/N)",
  "Department Name",
  "Job Location",
  "Priority",
  "HC Open",
  "HC Closed",
  "Job Health",
  "Job Progress",
  "Comments/Updates",
  "Offer Extended",
  "Offer Signed",
  "Offer Declined",
  "Joined",
  "Earliest Opening Date",
  "Number Of Days Open",
  "Recruiters",
  "Recruiter Team",
  "Sourcers",
  "Hiring Manager",
  "Hod",
  "Role Type",
  "Job URL",
  "Job Closed Date",
] as const

export const PIPELINE_CANDIDATE_HEADERS = [
  "week_order",
  "week",
  "requisition_id",
  "job_name",
  "application_id",
  "candidate_name",
  "recruiter_name",
  "stage_name",
  "core_stage",
  "event_type",
  "event_ts",
  "application_status",
  "rejected_at",
  "current_stage_name",
] as const

export const PIPELINE_890_CANDIDATE_HEADERS = [
  ...PIPELINE_CANDIDATE_HEADERS,
  "withdrew",
  "rejected_by",
  "rejection_reason",
] as const

export const FINAL_OFFER_HEADERS = [
  "full_name",
  "application_status",
  "application_stage",
  "application_id",
  "recruiter_of_record",
  "rejection_reason_id",
  "name",
  "type",
  "recruiter_team",
  "sourcer",
  "sourcer_team",
  "source",
  "status",
  "created_at",
  "created_by",
  "sent_at",
  "resolved_at",
  "resolution_days",
  "job_name",
  "detailed_job_title",
  "requisition_id",
  "job_status",
  "month_name",
  "offer_order",
  "month_order",
  "job_level",
  "start_date",
  "department_name",
  "hod",
  "approver_name",
  "hiring_location",
] as const

export const FINAL_OFFER_MONTH_HEADERS = FINAL_OFFER_HEADERS.map((header, index) =>
  index === 19 ? "Detailed Job Title" : header
)

/** Canonical Google-assigned ids for the retained legacy Q3 triplet tabs. */
export const FINAL_OFFER_Q3_SHEET_IDS = {
  July: { offerData: 875303902, recruiterPerformance: 536416048, sourcerPerformance: 2030343642 },
  August: { offerData: 1503185686, recruiterPerformance: 329204596, sourcerPerformance: 387711499 },
  September: { offerData: 1209354173, recruiterPerformance: 950128212, sourcerPerformance: 1131599123 },
} as const

export const RPS_HEADERS = [
  "candidate_name",
  "job_name",
  "requisition_id",
  "status",
  "recruiters",
  "sourcers",
  "interview_name",
  "interviewer",
  "scheduled_interview_ended_at",
  "submitted_at",
  "submitter",
  "match_mismatch",
  "month",
  "submitter_team_name",
  "week",
  "week_order",
  "qa_summary",
  "key_takeaways",
] as const

export const DELIVERY_RPS_HEADERS = [
  "candidate_name",
  "job_name",
  "requisition_id",
  "status",
  "recruiters",
  "sourcers",
  "interview_name",
  "interviewer",
  "scheduled_interview_ended_at",
  "submitted_at",
  "submitted_date_formatted",
  "date_order",
  "submitter",
  "overall_recommendation",
  "match_mismatch",
  "month",
  "submitter_team_name",
  "week",
  "week_order",
  "key_takeaways",
] as const

export const DELIVERY_RPS_DATED_HEADERS = [
  "Team",
  "Total RPS",
  "Match",
  "Mismatch",
  "Strong Yes",
  "Yes",
  "No",
  "Other",
] as const

const WEEKLY_PROGRESS_CODE_HEADERS = [
  "Offer Accepted",
  "Offer",
  "Onsite Interviews",
  "Skills Assessment",
  "Manager / Tech Screen",
  "Hiring Manager Resume Review",
  "Recruiter Phone Screen Conducted",
] as const

const WEEKLY_PROGRESS_FDE_HEADERS = [
  "Offer Accepted",
  "Offer",
  "Onsite Interview",
  "Manager / Tech Screen",
  "Hiring Manager Resume Review",
  "Recruiter Phone Screen Conducted",
] as const

const ALL_HIRES_HEADERS = [
  "Job Category",
  "Job Name",
  "Candidate Name",
  "Accepted Date",
  "Accepted Month",
  "Month Order (Acc)",
  "Start Date",
  "Start Month",
  "Month Order(Start)",
] as const

function candidate(
  id: StagingSheetContractId,
  artifactKey: StagingSheetRangeContract["artifactKey"],
  sheetId: number,
  sheetTitle: string,
  headers: readonly string[] = PIPELINE_CANDIDATE_HEADERS
): StagingSheetRangeContract {
  return {
    id,
    artifactKey,
    sheetId,
    sheetTitle,
    headerRow: 1,
    headers,
    upsertKeyHeaders: ["application_id", "core_stage", "event_type", "event_ts"],
    structuralNormalization: "Duplicate the latest candidate template into the current reporting-date tab, clear data rows, and keep the header/filter contract exact.",
  }
}

function jobWeek(
  id: StagingSheetContractId,
  artifactKey: StagingSheetRangeContract["artifactKey"],
  sheetId: number,
  sheetTitle: string,
  stageHeaders: readonly string[]
): StagingSheetRangeContract {
  const groupedHeaders = [
    "",
    "",
    "",
    "",
    "",
    ...stageHeaders.flatMap((stage) => [stage, "", ""]),
  ]
  return {
    id,
    artifactKey,
    sheetId,
    sheetTitle,
    headerRow: 2,
    headers: [
      "week_order",
      "week",
      "requisition_id",
      "job_name",
      "job_open_date",
      ...stageHeaders.flatMap(() => ["Enter", "Pass", "Reject"]),
    ],
    groupedHeader: { row: 1, headers: groupedHeaders },
    upsertKeyHeaders: ["week", "requisition_id"],
    structuralNormalization: "Open the fixed summary filter through the grid and append a copied-format reporting-week block; never alter prior blocks.",
  }
}

export const stagingSheetContracts: readonly StagingSheetRangeContract[] = [
  {
    id: "weekly_recruitment_current",
    artifactKey: "weekly_recruitment",
    sheetId: 1994864183,
    sheetTitle: "Weekly Working Report Sheet 02 Jul to 09 Jul 2026",
    headerRow: 1,
    headers: WEEKLY_RECRUITMENT_HEADERS,
    upsertKeyHeaders: ["Req ID"],
    humanOwnedHeaders: ["Billable (Y/N)", "Priority", "Job Health", "Job Progress", "Comments/Updates", "Role Type"],
    structuralNormalization: "A future completed week duplicates the latest weekly tab; prior tabs remain immutable.",
  },
  ...(["weekly_recruitment_a_c", "weekly_recruitment_e_f", "weekly_recruitment_h_i", "weekly_recruitment_m_w", "weekly_recruitment_y_z"] as const).map(
    (id): StagingSheetRangeContract => ({
      id,
      artifactKey: "weekly_recruitment",
      sheetId: 1994864183,
      sheetTitle: "Weekly Working Report Sheet 02 Jul to 09 Jul 2026",
      headerRow: 1,
      headers: WEEKLY_RECRUITMENT_HEADERS,
      upsertKeyHeaders: ["Req ID"],
      humanOwnedHeaders: ["Billable (Y/N)", "Priority", "Job Health", "Job Progress", "Comments/Updates", "Role Type"],
    })
  ),
  {
    id: "weekly_progress_code_rl",
    artifactKey: "weekly_progress",
    sheetId: 0,
    sheetTitle: "FDL (Code + RL)",
    headerRow: 1,
    headers: WEEKLY_PROGRESS_CODE_HEADERS,
    upsertKeyHeaders: ["reporting_week", "stage"],
    structuralNormalization: "Insert the current-week value column immediately before QTD so the QTD formulas shift intact.",
  },
  {
    id: "weekly_progress_fde_pe",
    artifactKey: "weekly_progress",
    sheetId: 242118538,
    sheetTitle: "FDE/PE",
    headerRow: 1,
    headers: WEEKLY_PROGRESS_FDE_HEADERS,
    upsertKeyHeaders: ["reporting_week", "stage"],
  },
  {
    id: "weekly_progress_brazil_colombia",
    artifactKey: "weekly_progress",
    sheetId: 1450892249,
    sheetTitle: "FDL (Brazil + Colombia)",
    headerRow: 1,
    headers: WEEKLY_PROGRESS_CODE_HEADERS,
    upsertKeyHeaders: ["reporting_week", "stage"],
    structuralNormalization: "Insert the current-week value column immediately before QTD so the QTD formulas shift intact.",
  },
  {
    id: "all_hires_data",
    artifactKey: "all_hires",
    sheetId: 1324142221,
    sheetTitle: "Data sheet",
    headerRow: 1,
    headers: ALL_HIRES_HEADERS,
    upsertKeyHeaders: ["Job Name", "Candidate Name", "Accepted Date"],
    structuralNormalization: "Change Pivot Table 2 source from Data sheet!A1:I36 to the open Data sheet A:I range before appending.",
  },
  candidate("pipeline_890_candidate", "pipeline_890", 1760537585, "Candidate Level Data - 02 July", PIPELINE_890_CANDIDATE_HEADERS),
  jobWeek("pipeline_890_job_week", "pipeline_890", 958156097, "Job level pipeline", [
    "Application Review", "Shortlisted", "Recruiter Phone Screen", "Hiring Manager Review",
    "Manager / Tech Screen", "Onsite Interviews", "Offer Extended", "Offer Signed",
  ]),
  candidate("pipeline_907_candidate", "pipeline_907", 156193952, "Candidate Level Data - 10 July"),
  jobWeek("pipeline_907_job_week", "pipeline_907", 0, "Job level pipeline", [
    "Application Review", "Shortlisted", "Recruiter Phone Screen", "Hiring Manager Review",
    "Manager / Tech Screen", "Onsite Interviews", "Offer", "Offer Signed",
  ]),
  candidate("pipeline_1026_1027_candidate", "pipeline_1026_1027", 757546275, "Candidate Level Data - 02 July"),
  jobWeek("pipeline_1026_1027_job_week", "pipeline_1026_1027", 0, "Job Level Pipeline", [
    "Application Review", "Reached Out", "Recruiter Phone Screen", "HM Review", "Manage/Tech Screen",
    "Skills Assessment", "Onsite", "Verbal Offer", "Offer/Offer Extend",
  ]),
  candidate("pipeline_1118_1119_candidate", "pipeline_1118_1119", 213573418, "Candidate Level Data - 11 May"),
  jobWeek("pipeline_1118_1119_job_week", "pipeline_1118_1119", 0, "Job level pipeline", [
    "Application Review", "Recruiter Phone Screen", "Hiring Manager Review", "Manager / Tech Screen",
    "Skills Assessment", "Onsite Interviews", "Verbal Offer", "Offer Extend", "Offer Signed",
  ]),
  {
    id: "final_offer_master",
    artifactKey: "final_offer",
    sheetId: 0,
    sheetTitle: "Mastersheet",
    headerRow: 1,
    headers: FINAL_OFFER_HEADERS,
    upsertKeyHeaders: ["application_id", "created_at"],
    structuralNormalization: "Preserve Q2 tabs, add Q3 July/August/September data tabs from the existing templates, and open the quarterly pivot sources.",
  },
  {
    id: "final_offer_performance_data",
    artifactKey: "final_offer",
    sheetId: 1083291166,
    sheetTitle: "Performance Sheet data",
    // Row 1, read off canonical 2026-08-07: row 1 is the header run and row 2 is
    // already offer data. eed9882 moved this to 2 with no recorded evidence and
    // nothing live-verified it, because Final Offer has never completed a write.
    headerRow: 1,
    headers: FINAL_OFFER_HEADERS,
    upsertKeyHeaders: ["application_id", "created_at"],
    structuralNormalization: "Open the Quarterly Performance pivot over the Q3 performance-data rows.",
  },
  ...(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const).map(
    (month): StagingSheetRangeContract => ({
      id: `final_offer_${month.toLowerCase()}_data` as StagingSheetContractId,
      artifactKey: "final_offer",
      sheetId: finalOfferMonthContractSheetId(month),
      sheetTitle: finalOfferMonthContractTitle(month),
      // Every month tab puts its headers on row 1. eed9882 carved out August and
      // September as row 2; read off canonical 2026-08-07 their row 2 is empty and
      // row 1 carries the headers, same as every other month.
      headerRow: 1,
      headers: FINAL_OFFER_MONTH_HEADERS,
      upsertKeyHeaders: ["application_id", "created_at"],
      structuralNormalization: `Populate only the active ${month} quarter rows; lifecycle-created tabs are year-qualified and their copied pivots read this tab.`,
    })
  ),
  {
    id: "rps_data_dump",
    artifactKey: "rps_tracking",
    sheetId: 1092300150,
    sheetTitle: "Data Dump",
    headerRow: 1,
    headers: RPS_HEADERS,
    upsertKeyHeaders: ["requisition_id", "submitted_at", "submitter", "interview_name"],
    structuralNormalization: "Change RPS Table pivot source from Data Dump!A1:R4000 to the open Data Dump A:R range; preserve all formulas.",
  },
  {
    id: "delivery_rps_raw",
    artifactKey: "delivery_roles_rps",
    sheetId: 1072762955,
    sheetTitle: "Raw_Daily_RPS",
    headerRow: 1,
    headers: DELIVERY_RPS_HEADERS,
    upsertKeyHeaders: ["requisition_id", "submitted_at", "submitter", "interview_name"],
    structuralNormalization: "Open the fixed A1:T176 filter through A:T.",
  },
  {
    id: "delivery_rps_clean",
    artifactKey: "delivery_roles_rps",
    sheetId: 1598905318,
    sheetTitle: "Cleaned_RPS",
    headerRow: 1,
    headers: DELIVERY_RPS_HEADERS,
    upsertKeyHeaders: ["requisition_id", "submitted_at", "submitter", "interview_name"],
    structuralNormalization: "The platform renderer writes this clean projection and duplicates the latest dated output tab for the reporting date; legacy Apps Script is not invoked.",
  },
  {
    id: "delivery_rps_dated",
    artifactKey: "delivery_roles_rps",
    sheetId: 2061940582,
    sheetTitle: "09 Jul 2026",
    headerRow: 4,
    headers: DELIVERY_RPS_DATED_HEADERS,
    upsertKeyHeaders: ["Team"],
    structuralNormalization: "Duplicate the latest dated tab for the reporting date and replace its title plus the complete A3:N daily report.",
    staticLayout: {
      titleCell: "A1",
      titleTemplate: "Recruiter Role Report - {DD MMM YYYY}",
      mergeRanges: ["A1:N1"],
      labels: { A3: "Summary by Team" },
    },
  },
] as const

function finalOfferMonthContractSheetId(month: string): number {
  if (month === "July" || month === "August" || month === "September") {
    return FINAL_OFFER_Q3_SHEET_IDS[month].offerData
  }
  const monthIndex = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ].indexOf(month)
  const year = monthIndex <= 5 ? 2027 : 2026
  const ordinal = year * 12 + monthIndex - (2026 * 12 + 9)
  return 1_900_000_000 + ordinal * 3 + 1
}

function finalOfferMonthContractTitle(month: string): string {
  if (month === "July" || month === "August" || month === "September") {
    return `${month} Offer Data`
  }
  return `${month} ${["January", "February", "March", "April", "May", "June"].includes(month) ? 2027 : 2026} Offer Data`
}

const byId = new Map(stagingSheetContracts.map((contract) => [contract.id, contract]))

export function getStagingSheetContract(id: StagingSheetContractId): StagingSheetRangeContract {
  const contract = byId.get(id)
  if (!contract) throw new Error(`Unknown staging sheet contract: ${id}`)
  return contract
}

export function assertExactHeaders(id: StagingSheetContractId, observed: readonly unknown[]): void {
  const expected = getStagingSheetContract(id).headers
  const normalized = observed.slice(0, expected.length).map((value) => String(value ?? "").trim())
  if (normalized.length !== expected.length || normalized.some((value, index) => value !== expected[index])) {
    throw new Error(`${id} header contract drifted; refusing hydration.`)
  }
}
