import type { CandidateStageEventRow } from "../delivery-source/candidate-stage-events"
import type { SheetCellValue } from "./staging-value-plan"

export type PipelineArtifactKey =
  | "pipeline_890"
  | "pipeline_907"
  | "pipeline_1026_1027"
  | "pipeline_1118_1119"

export interface PipelineArtifactRenderContract {
  artifactKey: PipelineArtifactKey
  requisitionIds: readonly string[]
  includeWithdrawalColumns: boolean
  stageGroups: readonly {
    label: string
    matches: (row: CandidateStageEventRow) => boolean
  }[]
}

export interface PipelineJobWeekRow {
  requisitionId: string
  cells: readonly SheetCellValue[]
}

export const pipelineRenderContracts: Readonly<Record<PipelineArtifactKey, PipelineArtifactRenderContract>> = {
  pipeline_890: contract("pipeline_890", ["890"], true, [
    stage("Application Review", /application review/i),
    stage("Shortlisted", /shortlist/i),
    core("Recruiter Phone Screen"),
    core("Hiring Manager Review"),
    core("Manager / Tech Screen"),
    stage("Onsite Interviews", /onsite|on-site|panel|final/i, "Onsite Interview"),
    stage("Offer Extended", /offer/i, "Offer"),
    stage("Offer Signed", /offer signed|accepted/i),
  ]),
  pipeline_907: contract("pipeline_907", ["907"], false, [
    stage("Application Review", /application review/i),
    stage("Shortlisted", /shortlist/i),
    core("Recruiter Phone Screen"),
    core("Hiring Manager Review"),
    core("Manager / Tech Screen"),
    stage("Onsite Interviews", /onsite|on-site|panel|final/i, "Onsite Interview"),
    core("Offer"),
    stage("Offer Signed", /offer signed|accepted/i),
  ]),
  pipeline_1026_1027: contract("pipeline_1026_1027", ["1026", "1027"], false, [
    stage("Application Review", /application review/i),
    stage("Reached Out", /reached out|sourc/i, "Sourced"),
    core("Recruiter Phone Screen"),
    stage("HM Review", /hm review|hiring manager/i, "Hiring Manager Review"),
    stage("Manage/Tech Screen", /manager|tech|technical/i, "Manager / Tech Screen"),
    core("Skills Assessment"),
    stage("Onsite", /onsite|on-site|panel|final/i, "Onsite Interview"),
    stage("Verbal Offer", /verbal offer/i),
    stage("Offer/Offer Extend", /offer/i, "Offer"),
  ]),
  pipeline_1118_1119: contract("pipeline_1118_1119", ["1118", "1119"], false, [
    stage("Application Review", /application review/i),
    core("Recruiter Phone Screen"),
    core("Hiring Manager Review"),
    core("Manager / Tech Screen"),
    core("Skills Assessment"),
    stage("Onsite Interviews", /onsite|on-site|panel|final/i, "Onsite Interview"),
    stage("Verbal Offer", /verbal offer/i),
    stage("Offer Extend", /offer/i, "Offer"),
    stage("Offer Signed", /offer signed|accepted/i),
  ]),
}

/**
 * The copied legacy reports do not share one week-order epoch. These anchors
 * were observed read-only in the staging copies on 2026-07-11:
 * - 890 and 1026/1027: Jun 26-Jul 2 is 30;
 * - 907: its Jul 3-Jul 9 candidate tab and job snapshots are 29;
 * - 1118/1119: May 8-May 14 is 24.
 *
 * Keep this display-only vocabulary at the artifact boundary. The platform's
 * canonical event fact retains its own global week_order.
 */
const PIPELINE_LEGACY_WEEK_ORDER_ANCHORS: Readonly<
  Record<PipelineArtifactKey, { reportingWeekFriday: string; weekOrder: number }>
> = {
  pipeline_890: { reportingWeekFriday: "2026-06-26", weekOrder: 30 },
  pipeline_907: { reportingWeekFriday: "2026-07-03", weekOrder: 29 },
  pipeline_1026_1027: { reportingWeekFriday: "2026-06-26", weekOrder: 30 },
  pipeline_1118_1119: { reportingWeekFriday: "2026-05-08", weekOrder: 24 },
}

/** Exact A:N/A:Q legacy candidate rows for one completed Fri-Thu week. */
export function renderPipelineCandidateRows(input: {
  artifactKey: PipelineArtifactKey
  reportingWeekFriday: string
  rows: readonly CandidateStageEventRow[]
}): SheetCellValue[][] {
  const contract = pipelineRenderContracts[input.artifactKey]
  const reqs = new Set(contract.requisitionIds)
  const legacyWeekOrder = pipelineLegacyWeekOrder(
    input.artifactKey,
    input.reportingWeekFriday
  )
  return input.rows
    .filter((row) => row.reporting_week_friday === input.reportingWeekFriday && row.requisition_id && reqs.has(row.requisition_id))
    .sort(compareEvents)
    .map((row) => {
      const common: SheetCellValue[] = [
        legacyWeekOrder,
        row.week,
        row.requisition_id,
        row.job_name,
        row.application_id,
        row.candidate_name,
        row.recruiter_name,
        row.stage_name,
        row.core_stage,
        row.event_type,
        row.event_ts,
        row.application_status,
        row.rejected_at,
        row.current_stage_name,
      ]
      if (!contract.includeWithdrawalColumns) return common
      return [...common, row.withdrew, row.rejected_by, row.rejection_reason]
    })
}

/**
 * Exact legacy job-week triplets. Counts are derived from explicit platform
 * event types; the renderer never infers a pass from the destination stage.
 */
export function renderPipelineJobWeekRows(input: {
  artifactKey: PipelineArtifactKey
  reportingWeekFriday: string
  rows: readonly CandidateStageEventRow[]
  jobOpenDateByReq?: ReadonlyMap<string, string | null>
}): PipelineJobWeekRow[] {
  const contract = pipelineRenderContracts[input.artifactKey]
  const weekRows = input.rows.filter((row) => row.reporting_week_friday === input.reportingWeekFriday)
  const weekOrder = pipelineLegacyWeekOrder(input.artifactKey, input.reportingWeekFriday)
  return contract.requisitionIds.map((requisitionId) => {
    const rows = weekRows.filter((row) => row.requisition_id === requisitionId)
    const exemplar = rows[0]
    const week = exemplar?.week ?? weekShort(input.reportingWeekFriday)
    const stageCells = contract.stageGroups.flatMap((group) => {
      const matching = rows.filter(group.matches)
      return [
        uniqueApplications(matching.filter((row) => row.event_type === "entered")),
        uniqueApplications(matching.filter((row) => row.event_type === "passed")),
        uniqueApplications(matching.filter((row) => row.event_type === "rejected" || row.event_type === "withdrawn")),
      ]
    })
    return {
      requisitionId,
      cells: [
        weekOrder,
        week,
        requisitionId,
        exemplar?.job_name ?? null,
        input.jobOpenDateByReq?.get(requisitionId) ?? null,
        ...stageCells,
      ],
    }
  })
}

function uniqueApplications(rows: readonly CandidateStageEventRow[]): number {
  return new Set(rows.map((row) => row.application_id)).size
}

function contract(
  artifactKey: PipelineArtifactKey,
  requisitionIds: readonly string[],
  includeWithdrawalColumns: boolean,
  stageGroups: PipelineArtifactRenderContract["stageGroups"]
): PipelineArtifactRenderContract {
  return { artifactKey, requisitionIds, includeWithdrawalColumns, stageGroups }
}

function core(label: string): PipelineArtifactRenderContract["stageGroups"][number] {
  return { label, matches: (row) => row.core_stage === label }
}

function stage(
  label: string,
  raw: RegExp,
  canonical?: string
): PipelineArtifactRenderContract["stageGroups"][number] {
  return {
    label,
    matches: (row) => raw.test(row.stage_name ?? "") || (canonical !== undefined && row.core_stage === canonical),
  }
}

function compareEvents(left: CandidateStageEventRow, right: CandidateStageEventRow): number {
  return (
    left.requisition_id!.localeCompare(right.requisition_id!) ||
    left.application_id.localeCompare(right.application_id) ||
    left.event_ts.localeCompare(right.event_ts) ||
    left.event_type.localeCompare(right.event_type) ||
    left.event_key.localeCompare(right.event_key)
  )
}

function weekShort(friday: string): string {
  const start = new Date(`${friday}T00:00:00Z`)
  const end = new Date(start.getTime() + 6 * 86_400_000)
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
  return `${fmt.format(start)} - ${fmt.format(end)}`
}

export function pipelineLegacyWeekOrder(
  artifactKey: PipelineArtifactKey,
  reportingWeekFriday: string
): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportingWeekFriday)) {
    throw new Error("Pipeline legacy week order requires an ISO Friday.")
  }
  const dateMs = Date.parse(`${reportingWeekFriday}T00:00:00.000Z`)
  const normalized = new Date(dateMs)
  if (
    Number.isNaN(dateMs) ||
    normalized.toISOString().slice(0, 10) !== reportingWeekFriday ||
    normalized.getUTCDay() !== 5
  ) {
    throw new Error("Pipeline legacy week order requires a valid Friday.")
  }
  const anchor = PIPELINE_LEGACY_WEEK_ORDER_ANCHORS[artifactKey]
  const anchorMs = Date.parse(`${anchor.reportingWeekFriday}T00:00:00.000Z`)
  const weekDelta = (dateMs - anchorMs) / (7 * 86_400_000)
  if (!Number.isInteger(weekDelta)) {
    throw new Error("Pipeline legacy week order must advance in complete weeks.")
  }
  return anchor.weekOrder + weekDelta
}
