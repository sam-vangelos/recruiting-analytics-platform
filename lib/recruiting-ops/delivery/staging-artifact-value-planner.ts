import {
  legacyArtifactDisplayV1,
  legacyDeliveryRpsParityV1,
  legacyRpsTrackingParityV1,
  isGovernedDeliveryRole,
} from "../dimensions/config/legacy-artifact-display.v1"
import type { RecruiterTeamHodEntry } from "../dimensions/config/recruiter-team-hod.v1"
import { fridayWeekStartUtc } from "../exec-definitions"
import type { StagingHydrationFacts } from "../delivery-source/staging-hydration-source-loader"
import { projectAllHires } from "./all-hires-renderer"
import { buildAllHiresBoundedValueInput, buildFinalOfferBoundedValueInput } from "./bounded-value-plan-inputs"
import { projectFinalOfferSheet } from "./final-offer-sheet-renderer"
import { createPiiFingerprint } from "../checksums"
import {
  buildDeliveryRpsReportFormatPlanForDatedWrite,
  readStagingDriveMetadata,
  readStagingSpreadsheet,
  readStagingValueRanges,
  type GoogleWorkspaceStagingClients,
} from "./google-workspace-staging-client"
import {
  buildPipelineStagingValuePlanRanges,
  buildWeeklyProgressStagingValuePlanRanges,
  pipelineRangeContractIds,
  type SheetValueMatrix,
} from "./pipeline-weekly-progress-value-inputs"
import type { PipelineArtifactKey } from "./pipeline-sheet-renderer"
import {
  projectDeliveryRoleRps,
  projectRpsTrackingSheet,
  type DeliveryRoleRpsProjection,
  type RenderedScorecardSheetRow,
  type RpsTrackingProjection,
} from "./rps-sheet-projections"
import { assertExactHeaders, getStagingSheetContract, type StagingSheetContractId } from "./staging-sheet-contracts"
import type { SheetStructureSnapshot } from "./sheet-structure-snapshot"
import { getStagingArtifact, type StagingArtifactKey } from "./staging-artifact-registry"
import {
  candidateTabTitleForReportingWeek,
  deliveryRpsDatedTabTitle,
  deliveryRpsTargetSheetId,
  finalOfferMonthTabTitles,
  finalOfferQuarterMonthKeys,
  weeklyProgressHeaderForReportingWeek,
  type DeliveryRpsProjectedValueTarget,
} from "./staging-structural-normalization"
import {
  buildProjectedDeliveryRpsValuePlan,
  buildStagingSheetValuePlan,
  type BuildStagingSheetValuePlanInput,
  type ProjectedDeliveryRpsValuePlan,
  type ProjectedStagingStructureBasis,
  type SheetCellValue,
  type StagingSheetValuePlan,
} from "./staging-value-plan"
import { renderWeeklyRecruitmentRows } from "./weekly-recruitment-renderer"
import { weeklyRecruitmentCycle } from "./weekly-recruitment-rollover"

export {
  candidateTabTitleForReportingWeek,
  weeklyProgressHeaderForReportingWeek,
} from "./staging-structural-normalization"

export type StagingSheetArtifactKey = Exclude<StagingArtifactKey, "elt_doc">
export interface LegacyLedgerContinuityCounts {
  mode: "legacy_artifact_seed_append"
  preservedSeedRows: number
  appendedPlatformRows: number
  totalRows: number
}
type RpsTrackingPlanSourceScope = RpsTrackingProjection["scope"] & {
  dataRowCapacity: number
  remainingDataRowCapacity: number
  continuity: LegacyLedgerContinuityCounts
}
type DeliveryRpsPlanSourceScope = DeliveryRoleRpsProjection["scope"] & {
  continuity: {
    raw: LegacyLedgerContinuityCounts
    clean: LegacyLedgerContinuityCounts
    mergedIdentityCount: number
    reportDateRows: number
  }
}
interface AllHiresPlanSourceScope {
  projectedHireCount: number
  unmappedHireCount: number
  unmappedRequisitionIds: readonly string[]
}
type ArtifactSourceScope =
  | RpsTrackingPlanSourceScope
  | DeliveryRpsPlanSourceScope
  | AllHiresPlanSourceScope

export interface PlannedStagingArtifact {
  plan: StagingSheetValuePlan
  publicSummary: {
    artifactKey: StagingSheetArtifactKey
    rangeCount: number
    changedRangeCount: number
    noOp: boolean
    rowCount: number
    payloadFingerprint: string
    structureHash: string
    sourceScope?: ArtifactSourceScope
  }
}

export interface ProjectedDeliveryRpsArtifactPlan {
  plan: ProjectedDeliveryRpsValuePlan
  publicSummary: {
    artifactKey: "delivery_roles_rps"
    rangeCount: number
    projectedChangedRangeCount: number
    projectedValueNoOp: boolean
    projectedPreimageFingerprint: string
    desiredPayloadFingerprint: string
    formatFingerprint: string
  }
}

interface ArtifactValueRangeResult {
  ranges: BuildStagingSheetValuePlanInput["ranges"]
  sourceScope?: ArtifactSourceScope
}

export async function planStagingArtifactValues(input: {
  artifactKey: StagingSheetArtifactKey
  runId: string
  facts: StagingHydrationFacts
  roster: readonly RecruiterTeamHodEntry[]
  clients: GoogleWorkspaceStagingClients
  structure: SheetStructureSnapshot
  deliveryRpsReportDate?: string
}): Promise<PlannedStagingArtifact> {
  const rangeResult = await rangesForArtifact(input)
  const plan = buildStagingSheetValuePlan({
    artifactKey: input.artifactKey,
    runId: input.runId,
    sourceGeneratedAt: input.facts.generatedAt,
    structureHash: input.structure.structureHash,
    dataProvenance: "live",
    ranges: rangeResult.ranges,
  })
  return {
    plan,
    publicSummary: {
      artifactKey: input.artifactKey,
      rangeCount: plan.writes.length,
      changedRangeCount: plan.writes.filter((write) => write.changed).length,
      noOp: plan.noOp,
      rowCount: plan.writes.reduce((total, write) => total + write.values.length, 0),
      payloadFingerprint: plan.payloadFingerprint,
      structureHash: plan.structureHash,
      ...(rangeResult.sourceScope ? { sourceScope: rangeResult.sourceScope } : {}),
    },
  }
}

export async function planProjectedDeliveryRpsValues(input: {
  runId: string
  facts: StagingHydrationFacts
  roster: readonly RecruiterTeamHodEntry[]
  clients: GoogleWorkspaceStagingClients
  deliveryRpsReportDate: string
  target: DeliveryRpsProjectedValueTarget
  structure: ProjectedStagingStructureBasis
}): Promise<ProjectedDeliveryRpsArtifactPlan> {
  const expectedTitle = deliveryRpsDatedTabTitle(input.deliveryRpsReportDate)
  const expectedId = deliveryRpsTargetSheetId(input.deliveryRpsReportDate)
  const expectedNormalizationId = `delivery_rps_dated_rollover_${input.deliveryRpsReportDate.replaceAll("-", "")}`
  if (
    input.target.targetSheetTitle !== expectedTitle ||
    input.target.targetSheetId !== expectedId ||
    input.structure.normalizationId !== expectedNormalizationId ||
    input.target.firstValueRow !== 3 ||
    input.target.preservedValueRowCount !== 2 ||
    input.target.templateSheetId === input.target.targetSheetId ||
    input.target.templateSheetTitle === input.target.targetSheetTitle
  ) {
    throw new Error("Projected Delivery RPS target does not match the dated rollover contract.")
  }

  const before = await readStagingDriveMetadata("delivery_roles_rps", input.clients)
  requireProjectedDriveVersion(before, input.structure.observedDriveVersion)
  const rangeResult = await deliveryRpsRanges({
    facts: input.facts,
    roster: input.roster,
    clients: input.clients,
    deliveryRpsReportDate: input.deliveryRpsReportDate,
  }, input.target)
  const targetReadback = await readStagingSpreadsheet("delivery_roles_rps", input.clients, {
    fields: "spreadsheetId,sheets(properties(sheetId,title))",
  })
  const artifact = getStagingArtifact("delivery_roles_rps")
  if (targetReadback.spreadsheetId !== artifact.artifactId) {
    throw new Error("Projected Delivery RPS absence read returned an unexpected spreadsheet.")
  }
  const observedSheets = targetReadback.sheets ?? []
  const requiredSheets = [
    { sheetId: 1072762955, title: "Raw_Daily_RPS" },
    { sheetId: 1598905318, title: "Cleaned_RPS" },
    { sheetId: input.target.templateSheetId, title: input.target.templateSheetTitle },
  ]
  if (requiredSheets.some((required) =>
    observedSheets.filter((sheet) =>
      sheet.properties?.sheetId === required.sheetId && sheet.properties?.title === required.title
    ).length !== 1
  )) {
    throw new Error("Projected Delivery RPS absence read is incomplete.")
  }
  if (observedSheets.some((sheet) =>
    sheet.properties?.sheetId === input.target.targetSheetId ||
    sheet.properties?.title === input.target.targetSheetTitle
  )) {
    throw new Error("Projected Delivery RPS target appeared during planning.")
  }
  const after = await readStagingDriveMetadata("delivery_roles_rps", input.clients)
  requireProjectedDriveVersion(after, input.structure.observedDriveVersion)

  const projected = buildProjectedDeliveryRpsValuePlan({
    runId: input.runId,
    sourceGeneratedAt: input.facts.generatedAt,
    structure: input.structure,
    dataProvenance: "live",
    ranges: rangeResult.ranges,
  })
  const datedWrites = projected.writes.filter((write) => write.rangeId === "delivery_rps_dated")
  if (datedWrites.length !== 1) {
    throw new Error("Projected Delivery RPS plan requires one exact dated-report range.")
  }
  const formatFingerprint = buildDeliveryRpsReportFormatPlanForDatedWrite(
    datedWrites[0]
  ).desiredFingerprint
  const planFingerprint = createPiiFingerprint({
    projectedPlanFingerprint: projected.planFingerprint,
    formatFingerprint,
  }, {
    context: "recops:staging:delivery_roles_rps:projected-certificate",
    dataProvenance: "live",
  })
  const plan = { ...projected, planFingerprint }
  return {
    plan,
    publicSummary: {
      artifactKey: "delivery_roles_rps",
      rangeCount: plan.writes.length,
      projectedChangedRangeCount: plan.writes.filter((write) => write.changed).length,
      projectedValueNoOp: plan.noOp,
      projectedPreimageFingerprint: plan.projectedPreimageFingerprint,
      desiredPayloadFingerprint: plan.desiredPayloadFingerprint,
      formatFingerprint,
    },
  }
}

async function rangesForArtifact(
  input: Parameters<typeof planStagingArtifactValues>[0]
): Promise<ArtifactValueRangeResult> {
  switch (input.artifactKey) {
    case "weekly_recruitment":
      return { ranges: await weeklyRecruitmentRanges(input) }
    case "weekly_progress":
      return { ranges: await weeklyProgressRanges(input) }
    case "all_hires":
      return allHiresRanges(input)
    case "pipeline_890":
    case "pipeline_907":
    case "pipeline_1026_1027":
    case "pipeline_1118_1119":
      return { ranges: await pipelineRanges(input, input.artifactKey) }
    case "final_offer":
      return { ranges: await finalOfferRanges(input) }
    case "rps_tracking":
      return rpsTrackingRanges(input)
    case "delivery_roles_rps":
      return deliveryRpsRanges(input)
  }
}

async function weeklyRecruitmentRanges(
  input: Parameters<typeof planStagingArtifactValues>[0]
): Promise<BuildStagingSheetValuePlanInput["ranges"]> {
  const title = weeklyRecruitmentCycle(input.facts.reportingWeekFriday).targetSheetTitle
  const [read] = await readStagingValueRanges("weekly_recruitment", [`'${title}'!A1:Z1000`], input.clients)
  const matrix = rectangular(read.values, 1000, 26)
  assertExactHeaders("weekly_recruitment_current", matrix[0])
  const rendered = renderWeeklyRecruitmentRows({
    currentRows: matrix.slice(1),
    sourceRows: input.facts.reqWeeks,
  })
  const currentRows = rectangular(matrix.slice(1), rendered.desiredRows.length, 26)
  const segmentCoordinates = [
    ["weekly_recruitment_a_c", 0, 3],
    ["weekly_recruitment_e_f", 4, 6],
    ["weekly_recruitment_h_i", 7, 9],
    ["weekly_recruitment_m_w", 12, 23],
    ["weekly_recruitment_y_z", 24, 26],
  ] as const
  return segmentCoordinates.map(([rangeId, start, end], index) => ({
    rangeId,
    a1Range: `'${title}'!${columnLabel(start)}2:${columnLabel(end - 1)}${rendered.desiredRows.length + 1}`,
    currentValues: currentRows.map((row) => row.slice(start, end)),
    desiredValues: rendered.segments[index].values,
  }))
}

async function weeklyProgressRanges(
  input: Parameters<typeof planStagingArtifactValues>[0]
): Promise<BuildStagingSheetValuePlanInput["ranges"]> {
  const specs = [
    ["code_rl", "FDL (Code + RL)", "A1:AV1002"],
    ["fde_pe", "FDE/PE", "A1:AU1001"],
    ["brazil_colombia", "FDL (Brazil + Colombia)", "A1:AK1001"],
  ] as const
  const reads = await readStagingValueRanges(
    "weekly_progress",
    specs.map(([, title, range]) => `'${title}'!${range}`),
    input.clients
  )
  const header = weeklyProgressHeaderForReportingWeek(input.facts.reportingWeekFriday)
  return buildWeeklyProgressStagingValuePlanRanges({
    reportingWeekFriday: input.facts.reportingWeekFriday,
    candidateEvents: input.facts.candidateEvents,
    offers: input.facts.offers,
    scorecards: input.facts.scorecards,
    targets: Object.fromEntries(
      specs.map(([bucket, title], index) => [bucket, { sheetTitle: title, currentMatrix: reads[index].values, weekHeader: header }])
    ) as never,
  })
}

async function allHiresRanges(
  input: Parameters<typeof planStagingArtifactValues>[0]
): Promise<ArtifactValueRangeResult> {
  const [header, data] = await readStagingValueRanges(
    "all_hires",
    ["'Data sheet'!A1:I1", "'Data sheet'!A2:I"],
    input.clients
  )
  assertExactHeaders("all_hires_data", rectangular(header.values, 1, 9)[0])
  const projection = projectAllHires({
    offers: input.facts.offers,
    displayDimensions: legacyArtifactDisplayV1.map((entry) => ({
      requisitionId: entry.requisitionId,
      jobCategory: entry.allHiresCategory,
      jobName: entry.allHiresJobName,
    })),
  })
  return {
    ranges: [
      buildAllHiresBoundedValueInput({
        currentValues: data.values,
        projectedRows: projection.rows,
      }).range,
    ],
    sourceScope: {
      projectedHireCount: projection.rows.length,
      unmappedHireCount: projection.unmapped.length,
      // Requisition ids only. Candidate names never leave the projection.
      unmappedRequisitionIds: [
        ...new Set(projection.unmapped.map((hire) => hire.requisitionId ?? "unknown")),
      ].sort(),
    },
  }
}

async function pipelineRanges(
  input: Parameters<typeof planStagingArtifactValues>[0],
  artifactKey: PipelineArtifactKey
): Promise<BuildStagingSheetValuePlanInput["ranges"]> {
  const target = pipelineValueReadTargetForReportingWeek(
    artifactKey,
    input.facts.reportingWeekFriday
  )
  const reads = await readStagingValueRanges(
    artifactKey,
    target.ranges,
    input.clients
  )
  const openDates = new Map(input.facts.reqWeeks.map((row) => [row.requisitionId, row.earliestOpeningDate]))
  return buildPipelineStagingValuePlanRanges({
    artifactKey,
    reportingWeekFriday: input.facts.reportingWeekFriday,
    candidateEvents: input.facts.candidateEvents,
    jobOpenDateByReq: openDates,
    candidateTarget: { sheetTitle: target.candidateTitle, currentMatrix: reads[0].values },
    jobWeekTarget: { sheetTitle: target.jobTitle, currentMatrix: reads[1].values },
  })
}

/**
 * Derives open-ended, read-only ranges from the exact physical contract width.
 * The eventual write plan remains explicitly row-bounded; open reads prevent a
 * recurring run from silently ignoring a newly appended historical block.
 */
export function pipelineValueReadTargetForReportingWeek(
  artifactKey: PipelineArtifactKey,
  reportingWeekFriday: string
): {
  candidateTitle: string
  jobTitle: string
  ranges: readonly [string, string]
} {
  const ids = pipelineRangeContractIds[artifactKey]
  const candidate = getStagingSheetContract(ids.candidate)
  const job = getStagingSheetContract(ids.jobWeek)
  const candidateTitle = candidateTabTitleForReportingWeek(reportingWeekFriday)
  return {
    candidateTitle,
    jobTitle: job.sheetTitle,
    ranges: [
      `'${candidateTitle}'!A:${columnLabel(candidate.headers.length - 1)}`,
      `'${job.sheetTitle}'!A:${columnLabel(job.headers.length - 1)}`,
    ],
  }
}

/**
 * A reporting bucket runs Friday through Thursday. The legacy pipeline tabs
 * are stamped with the following Friday, so a recurring run must derive the
 * title instead of pinning the first tested week (10 July 2026).
 */
async function finalOfferRanges(
  input: Parameters<typeof planStagingArtifactValues>[0]
): Promise<BuildStagingSheetValuePlanInput["ranges"]> {
  const monthTargets = finalOfferQuarterMonthKeys(input.facts.quarterStart).map((monthKey) => {
    const title = finalOfferMonthTabTitles(monthKey).offerData
    return [
      `final_offer_${title.split(" ")[0].toLowerCase()}_data` as StagingSheetContractId,
      title,
    ] as const
  })
  const targets: readonly (readonly [StagingSheetContractId, string])[] = [
    ["final_offer_master", "Mastersheet"],
    ["final_offer_performance_data", "Performance Sheet data"],
    ...monthTargets,
  ]
  const reads = await readStagingValueRanges(
    "final_offer",
    targets.flatMap(([contractId, title]) => {
      const headerRow = getStagingSheetContract(contractId).headerRow
      return [`'${title}'!A${headerRow}:AE${headerRow}`, `'${title}'!A${headerRow + 1}:AE1000`]
    }),
    input.clients
  )
  targets.forEach(([contractId], index) => {
    assertExactHeaders(contractId, rectangular(reads[index * 2].values, 1, 31)[0])
  })
  const quarter = { startDate: input.facts.quarterStart, endDateExclusive: addMonths(input.facts.quarterStart, 3) }
  const projection = projectFinalOfferSheet({ rows: input.facts.offers, roster: input.roster, quarter })
  const desired = projection.rows.map((row) => row.values)
  return [
    buildFinalOfferBoundedValueInput({ currentValues: reads[1].values, projection, quarter }).range,
    fullReplacementRange(
      "final_offer_performance_data",
      "Performance Sheet data",
      "AE",
      reads[3].values,
      desired
    ),
    ...monthTargets.map(([contractId, title], targetIndex) => {
      const month = title.split(" ")[0]
      return fullReplacementRange(
        contractId,
        title,
        "AE",
        reads[(targetIndex + 2) * 2 + 1].values,
        projection.rows.filter((row) => row.values[22] === month).map((row) => row.values)
      )
    }),
  ]
}

async function rpsTrackingRanges(
  input: Parameters<typeof planStagingArtifactValues>[0]
): Promise<ArtifactValueRangeResult> {
  const dataRowCapacity = await readRpsTrackingDataRowCapacity(input.clients)
  const [header, data] = await readStagingValueRanges(
    "rps_tracking",
    [
      "'Data Dump'!A1:R1",
      `'Data Dump'!A2:R${dataRowCapacity + 1}`,
    ],
    input.clients
  )
  assertExactHeaders("rps_data_dump", rectangular(header.values, 1, 18)[0])
  const projection = projectRpsTrackingSheet({
    rows: input.facts.scorecards,
    roster: input.roster,
    periodStartMonday: legacyRpsTrackingParityV1.periodStartMonday,
    submittedAtStart: legacyRpsTrackingParityV1.submittedAtStart,
    submittedAtEndExclusive: addDays(input.facts.reportingWeekFriday, 7),
  })
  const merged = mergeLegacyScorecardLedger({
    label: "RPS Tracking Data Dump",
    currentValues: data.values,
    projectedRows: projection.rows,
    width: 18,
    timestampColumn: 9,
  })
  if (merged.rows.length > dataRowCapacity) {
    throw new Error(
      `RPS Tracking requires ${merged.rows.length} merged data rows but the copied Data Dump capacity is ` +
      `${dataRowCapacity}; structural row expansion is required before hydration.`
    )
  }
  return {
    ranges: [fullReplacementRange("rps_data_dump", "Data Dump", "R", data.values, merged.rows)],
    sourceScope: {
      ...projection.scope,
      dataRowCapacity,
      remainingDataRowCapacity: dataRowCapacity - merged.rows.length,
      continuity: merged.continuity,
    },
  }
}

export function rpsTrackingRequiredDataRows(input: {
  facts: StagingHydrationFacts
  roster: readonly RecruiterTeamHodEntry[]
}): number {
  return projectRpsTrackingSheet({
    rows: input.facts.scorecards,
    roster: input.roster,
    periodStartMonday: legacyRpsTrackingParityV1.periodStartMonday,
    submittedAtStart: legacyRpsTrackingParityV1.submittedAtStart,
    submittedAtEndExclusive: addDays(input.facts.reportingWeekFriday, 7),
  }).rows.length
}

async function readRpsTrackingDataRowCapacity(
  clients: GoogleWorkspaceStagingClients
): Promise<number> {
  const spreadsheet = await readStagingSpreadsheet("rps_tracking", clients, {
    fields: "spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))",
  })
  const matches = (spreadsheet.sheets ?? []).filter(
    (sheet) => sheet.properties?.sheetId === 1092300150 && sheet.properties?.title === "Data Dump"
  )
  if (matches.length !== 1) {
    throw new Error("RPS Tracking capacity read requires the exact copied Data Dump tab.")
  }
  const grid = matches[0].properties?.gridProperties
  if (!Number.isInteger(grid?.rowCount) || grid?.columnCount !== 18 || (grid?.rowCount ?? 0) < 1) {
    throw new Error("RPS Tracking copied Data Dump grid dimensions are invalid.")
  }
  return (grid?.rowCount as number) - 1
}

interface LegacyLedgerMergeResult {
  rows: readonly (readonly SheetCellValue[])[]
  normalizedTimestamps: readonly string[]
  continuity: LegacyLedgerContinuityCounts
}

/**
 * One-time compatibility migration for copied legacy ledgers. The copied rows
 * omit stable scorecard IDs, so a unique normalized reporting timestamp is the
 * audited bridge to the platform source. Once covered, seed rows stay
 * cell-value-for-cell-value and in place; only unseen platform timestamps append.
 * Modern analytics must continue to use ScorecardSubmissionRow.scorecard_id
 * rather than this legacy artifact-only identity.
 */
function mergeLegacyScorecardLedger(input: {
  label: string
  currentValues: SheetValueMatrix
  /** Rows eligible to append during this run's reporting window. */
  projectedRows: readonly RenderedScorecardSheetRow[]
  /** Broader source history used only to prove that every retained seed identity still exists. */
  continuityProjectedRows?: readonly RenderedScorecardSheetRow[]
  width: number
  timestampColumn: number
  /** Offset applied only when a legacy timestamp identity is stored as a Google serial. */
  numericSerialUtcOffsetMinutes?: number
}): LegacyLedgerMergeResult {
  const numericSerialUtcOffsetMinutes = input.numericSerialUtcOffsetMinutes ?? 0
  if (!Number.isInteger(numericSerialUtcOffsetMinutes) || Math.abs(numericSerialUtcOffsetMinutes) > 24 * 60) {
    throw new Error(`${input.label} has an invalid numeric timestamp offset contract.`)
  }
  const seedRows = trimRows(input.currentValues, input.width)
  const internalBlankRow = seedRows.findIndex((row) => !row.some(nonBlankCell))
  if (internalBlankRow >= 0) {
    throw new Error(
      `${input.label} existing seed contains an internal all-blank row at row ${internalBlankRow + 1}; ` +
      "refusing a position-collapsing continuity merge."
    )
  }
  const seedByTimestamp = new Map<string, readonly SheetCellValue[]>()
  seedRows.forEach((row, index) => {
    const timestamp = requireNormalizedLedgerTimestamp(
      row[input.timestampColumn],
      input.label,
      "existing seed",
      index + 1,
      numericSerialUtcOffsetMinutes
    )
    if (seedByTimestamp.has(timestamp)) {
      throw new Error(
        `${input.label} existing seed contains duplicate normalized reporting timestamps; ` +
        "refusing an ambiguous continuity merge."
      )
    }
    seedByTimestamp.set(timestamp, row)
  })

  const indexProjectedRows = (
    rows: readonly RenderedScorecardSheetRow[]
  ): Map<string, RenderedScorecardSheetRow> => {
    const indexed = new Map<string, RenderedScorecardSheetRow>()
    rows.forEach((row, index) => {
      if (row.values.length !== input.width) {
        throw new Error(`${input.label} projected source row ${index + 1} has an invalid width.`)
      }
      const timestamp = requireNormalizedLedgerTimestamp(
        row.values[input.timestampColumn],
        input.label,
        "projected source",
        index + 1,
        numericSerialUtcOffsetMinutes
      )
      if (indexed.has(timestamp)) {
        throw new Error(
          `${input.label} projected source contains duplicate normalized reporting timestamps; ` +
          "refusing an ambiguous continuity merge."
        )
      }
      indexed.set(timestamp, row)
    })
    return indexed
  }

  const continuityByTimestamp = indexProjectedRows(
    input.continuityProjectedRows ?? input.projectedRows
  )
  const projectedByTimestamp = input.continuityProjectedRows
    ? indexProjectedRows(input.projectedRows)
    : continuityByTimestamp

  const uncoveredSeedCount = [...seedByTimestamp.keys()].filter(
    (timestamp) => !continuityByTimestamp.has(timestamp)
  ).length
  if (uncoveredSeedCount > 0) {
    throw new Error(
      `${input.label} has ${uncoveredSeedCount} existing seed row(s) without exactly one projected source ` +
      "timestamp match; refusing continuity merge."
    )
  }

  const appended = [...projectedByTimestamp.entries()]
    .filter(([timestamp]) => !seedByTimestamp.has(timestamp))
    .sort(([leftTimestamp, left], [rightTimestamp, right]) =>
      Number(leftTimestamp) - Number(rightTimestamp) || left.scorecardId.localeCompare(right.scorecardId, "en-US")
    )
    .map(([, row]) => row.values)
  const rows = [...seedRows, ...appended]
  return {
    rows,
    normalizedTimestamps: [
      ...seedByTimestamp.keys(),
      ...appended.map((row, index) => requireNormalizedLedgerTimestamp(
        row[input.timestampColumn],
        input.label,
        "appended platform",
        index + 1,
        numericSerialUtcOffsetMinutes
      )),
    ],
    continuity: {
      mode: "legacy_artifact_seed_append",
      preservedSeedRows: seedRows.length,
      appendedPlatformRows: appended.length,
      totalRows: rows.length,
    },
  }
}

function keyCell(value: SheetCellValue | undefined): string {
  return value === null || value === undefined ? "" : String(value).trim()
}

function nonBlankCell(value: SheetCellValue): boolean {
  return value !== null && value !== ""
}

function requireNormalizedLedgerTimestamp(
  value: SheetCellValue | undefined,
  label: string,
  source: string,
  oneBasedRow: number,
  numericSerialUtcOffsetMinutes = 0
): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} ${source} row ${oneBasedRow} has a missing or invalid reporting timestamp.`)
    }
    return String(Math.round(
      (value - 25_569) * 86_400_000 - numericSerialUtcOffsetMinutes * 60_000
    ))
  }
  const raw = keyCell(value)
  const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)
    ? Date.parse(`${raw.replace(" ", "T")}Z`)
    : Date.parse(raw)
  if (Number.isNaN(timestamp)) {
    throw new Error(`${label} ${source} row ${oneBasedRow} has a missing or invalid reporting timestamp.`)
  }
  return String(timestamp)
}

async function deliveryRpsRanges(
  input: Pick<
    Parameters<typeof planStagingArtifactValues>[0],
    "facts" | "roster" | "clients" | "deliveryRpsReportDate"
  >,
  projectedTarget?: DeliveryRpsProjectedValueTarget
): Promise<ArtifactValueRangeResult> {
  const reportDate = input.deliveryRpsReportDate
  if (!reportDate) throw new Error("Delivery RPS values require the current business date.")
  const datedTitle = deliveryRpsDatedTabTitle(reportDate)
  const datedReadTitle = projectedTarget?.templateSheetTitle ?? datedTitle
  const [reads, workbook] = await Promise.all([
    readStagingValueRanges(
      "delivery_roles_rps",
      [
        "'Raw_Daily_RPS'!A1:T1", "'Raw_Daily_RPS'!A2:T",
        "'Cleaned_RPS'!A1:T1", "'Cleaned_RPS'!A2:T",
        `'${datedReadTitle.replaceAll("'", "''")}'!A3:N`,
      ],
      input.clients
    ),
    readStagingSpreadsheet("delivery_roles_rps", input.clients, {
      fields: "spreadsheetId,properties(locale,timeZone)",
    }),
  ])
  if (
    workbook.properties?.locale !== legacyDeliveryRpsParityV1.cleanedSheetLocale ||
    workbook.properties?.timeZone !== legacyDeliveryRpsParityV1.cleanedSheetTimeZone
  ) {
    throw new Error(
      "Delivery Roles RPS copy no longer has the audited legacy locale/time-zone contract; " +
      "refusing a wall-clock compatibility projection."
    )
  }
  assertExactHeaders("delivery_rps_raw", rectangular(reads[0].values, 1, 20)[0])
  assertExactHeaders("delivery_rps_clean", rectangular(reads[2].values, 1, 20)[0])
  assertExactHeaders("delivery_rps_dated", rectangular(reads[4].values, 2, 14)[1].slice(0, 8))
  if (projectedTarget && reads[4].values[0]?.[0] !== "Summary by Team") {
    throw new Error("Projected Delivery RPS template is missing the governed A3 section label.")
  }
  const deliveryReportingWeekFriday = fridayWeekStartUtc(new Date(`${reportDate}T00:00:00.000Z`))
  const projection = projectDeliveryRoleRps({
    rows: input.facts.scorecards,
    roster: input.roster,
    isDeliveryRole: (job) => isGovernedDeliveryRole({
      requisitionId: job.requisitionId,
      jobName: job.jobName,
    }),
    dateOrderStart: legacyDeliveryRpsParityV1.dateOrderStart,
    submittedAtStart: deliveryReportingWeekFriday,
    submittedAtEndExclusive: addDays(deliveryReportingWeekFriday, 7),
    reportDate,
  })
  const continuityProjection = projectDeliveryRoleRps({
    rows: input.facts.scorecards,
    roster: input.roster,
    isDeliveryRole: (job) => isGovernedDeliveryRole({
      requisitionId: job.requisitionId,
      jobName: job.jobName,
    }),
    dateOrderStart: legacyDeliveryRpsParityV1.dateOrderStart,
    submittedAtStart: legacyDeliveryRpsParityV1.dateOrderStart,
    submittedAtEndExclusive: addDays(deliveryReportingWeekFriday, 7),
    reportDate,
  })
  const rawMerged = mergeLegacyScorecardLedger({
    label: "Delivery Raw_Daily_RPS",
    currentValues: reads[1].values,
    projectedRows: projection.raw.rows,
    continuityProjectedRows: continuityProjection.raw.rows,
    width: 20,
    timestampColumn: 9,
  })
  const cleanMerged = mergeLegacyScorecardLedger({
    label: "Delivery Cleaned_RPS",
    currentValues: reads[3].values,
    projectedRows: projection.clean.rows,
    continuityProjectedRows: continuityProjection.clean.rows,
    width: 20,
    timestampColumn: 9,
    numericSerialUtcOffsetMinutes: legacyDeliveryRpsParityV1.cleanedSheetUtcOffsetMinutes,
  })
  assertSameLegacyLedgerTimestampSet(rawMerged, cleanMerged)
  // The append runway's number format is published by the write itself and
  // certified against the sheet afterwards (countDeliveryRpsLedgerDateFormatGaps).
  // Refusing here instead only ever blocked the append that would have fixed it,
  // because rows below the sheet's last formatted row are never pre-formatted.
  // Raw_Daily_RPS is the legacy summary authority. Its retained display values
  // intentionally win over mutable platform job/team attribution for seeded rows.
  const dated = renderDeliveryDatedReportFromMergedLedger(rawMerged.rows, reportDate)
  return {
    ranges: [
      fullReplacementRange("delivery_rps_raw", "Raw_Daily_RPS", "T", reads[1].values, rawMerged.rows),
      fullReplacementRange("delivery_rps_clean", "Cleaned_RPS", "T", reads[3].values, cleanMerged.rows),
      fullReplacementRangeFromRow(
        "delivery_rps_dated",
        datedTitle,
        3,
        "N",
        projectedTarget
          ? rectangular(reads[4].values, projectedTarget.preservedValueRowCount, 14)
          : reads[4].values,
        dated.rows
      ),
    ],
    sourceScope: {
      ...projection.scope,
      datedIncludedRowCount: dated.reportDateRows,
      continuity: {
        raw: rawMerged.continuity,
        clean: cleanMerged.continuity,
        mergedIdentityCount: rawMerged.normalizedTimestamps.length,
        reportDateRows: dated.reportDateRows,
      },
    },
  }
}

function requireProjectedDriveVersion(
  metadata: {
    id?: string | null
    version?: string | number | null
    mimeType?: string | null
    trashed?: boolean | null
    capabilities?: { canEdit?: boolean | null; canModifyContent?: boolean | null } | null
  },
  expectedVersion: string
): void {
  const artifact = getStagingArtifact("delivery_roles_rps")
  if (
    metadata.id !== artifact.artifactId ||
    String(metadata.version ?? "").trim() !== expectedVersion ||
    metadata.mimeType !== "application/vnd.google-apps.spreadsheet" ||
    metadata.trashed !== false ||
    metadata.capabilities?.canEdit !== true ||
    metadata.capabilities?.canModifyContent !== true
  ) {
    throw new Error("Delivery RPS changed during projected dry-run planning.")
  }
}

function assertSameLegacyLedgerTimestampSet(
  raw: LegacyLedgerMergeResult,
  clean: LegacyLedgerMergeResult
): void {
  const rawTimestamps = new Set(raw.normalizedTimestamps)
  const cleanTimestamps = new Set(clean.normalizedTimestamps)
  const setsMatch = rawTimestamps.size === cleanTimestamps.size
    && [...rawTimestamps].every((timestamp) => cleanTimestamps.has(timestamp))
  if (!setsMatch) {
    throw new Error(
      "Delivery Raw_Daily_RPS and Cleaned_RPS merged reporting timestamp identity sets diverge; " +
      "refusing to publish inconsistent legacy ledgers."
    )
  }
}

export function renderDeliveryDatedReportFromMergedLedger(
  mergedRows: readonly (readonly SheetCellValue[])[],
  reportDate: string
): { rows: readonly (readonly SheetCellValue[])[]; reportDateRows: number } {
  type Counts = {
    total: number
    match: number
    mismatch: number
    strongYes: number
    yes: number
    no: number
    other: number
  }
  const emptyCounts = (): Counts => ({
    total: 0, match: 0, mismatch: 0, strongYes: 0, yes: 0, no: 0, other: 0,
  })
  const dailyRows = mergedRows.filter((row, index) => {
    const timestamp = requireNormalizedLedgerTimestamp(
      row[9],
      "Delivery merged Raw_Daily_RPS",
      "daily report source",
      index + 1
    )
    return new Date(Number(timestamp)).toISOString().slice(0, 10) === reportDate
  })
  const addCount = (map: Map<string, Counts>, key: string, row: readonly SheetCellValue[]) => {
    const counts = map.get(key) ?? emptyCounts()
    counts.total += 1
    const match = normalizedDisplayToken(row[14])
    if (match === "match") counts.match += 1
    else if (match === "mismatch") counts.mismatch += 1
    const recommendation = normalizedDisplayToken(row[13])
    if (recommendation === "strong yes") counts.strongYes += 1
    else if (recommendation === "yes") counts.yes += 1
    else if (recommendation === "no") counts.no += 1
    else counts.other += 1
    map.set(key, counts)
  }
  const byTeam = new Map<string, Counts>()
  const bySubmitter = new Map<string, Counts>()
  const byMatch = new Map<string, number>()
  const byRole = new Map<string, {
    requisitionId: SheetCellValue
    jobName: string
    total: number
    submitters: Set<string>
    recruiters: Set<string>
    sourcers: Set<string>
  }>()
  for (const row of dailyRows) {
    addCount(byTeam, keyCell(row[16]), row)
    addCount(bySubmitter, keyCell(row[12]), row)
    const match = keyCell(row[14])
    byMatch.set(match, (byMatch.get(match) ?? 0) + 1)
    const roleKey = `${keyCell(row[2])}\0${keyCell(row[1])}`
    const role = byRole.get(roleKey) ?? {
      requisitionId: numericTextCell(row[2]),
      jobName: keyCell(row[1]),
      total: 0,
      submitters: new Set<string>(),
      recruiters: new Set<string>(),
      sourcers: new Set<string>(),
    }
    role.total += 1
    addDelimited(role.submitters, row[12])
    addDelimited(role.recruiters, row[4])
    addDelimited(role.sourcers, row[5])
    byRole.set(roleKey, role)
  }

  const summaryRows = (map: Map<string, Counts>) => [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([label, counts]) => [
      label, counts.total, counts.match, counts.mismatch,
      counts.strongYes, counts.yes, counts.no, counts.other,
    ] as const)
  const padded = (values: readonly SheetCellValue[]) =>
    Array.from({ length: 14 }, (_, index) => values[index] ?? null)
  const rows: SheetCellValue[][] = []
  const section = (
    label: string,
    headers: readonly string[],
    values: readonly (readonly SheetCellValue[])[],
    trailingSpace = true
  ) => {
    rows.push(padded([label]), padded(headers), ...values.map(padded))
    if (trailingSpace) rows.push(padded([]), padded([]))
  }
  const summaryHeaders = ["Team", "Total RPS", "Match", "Mismatch", "Strong Yes", "Yes", "No", "Other"]
  section("Summary by Team", summaryHeaders, summaryRows(byTeam))
  section("Summary by Submitter", ["Submitter", ...summaryHeaders.slice(1)], summaryRows(bySubmitter))
  section(
    "Match / Mismatch Check",
    ["Match Status", "Count"],
    [...byMatch.entries()]
      .sort(([left], [right]) => matchOrder(left) - matchOrder(right) || left.localeCompare(right, "en-US"))
  )
  section(
    "Role-Level Detail",
    ["Requisition ID", "Job Name", "Total RPS", "Submitters", "Recruiters", "Sourcers"],
    [...byRole.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([, role]) => [
        role.requisitionId,
        role.jobName,
        role.total,
        [...role.submitters].join(", "),
        [...role.recruiters].join(", "),
        [...role.sourcers].join(", "),
      ])
  )
  section(
    "Raw Detail",
    [
      "Candidate", "Job", "Req ID", "Status", "Submitter", "Submitter Team", "Interview",
      "Interviewer", "Recommendation", "Match/Mismatch", "Recruiters", "Sourcers", "Week", "Key Takeaways",
    ],
    dailyRows.map((row) => [
      row[0] ?? null,
      row[1] ?? null,
      numericTextCell(row[2]),
      row[3] ?? null,
      row[12] ?? null,
      row[16] ?? null,
      row[6] ?? null,
      row[7] ?? null,
      row[13] ?? null,
      row[14] ?? null,
      row[4] ?? null,
      row[5] ?? null,
      row[17] ?? null,
      row[19] ?? null,
    ]),
    false
  )

  return {
    rows,
    reportDateRows: dailyRows.length,
  }
}

function addDelimited(target: Set<string>, value: SheetCellValue | undefined): void {
  for (const part of keyCell(value).split(",").map((entry) => entry.trim()).filter(Boolean)) {
    target.add(part)
  }
}

function numericTextCell(value: SheetCellValue | undefined): SheetCellValue {
  const text = keyCell(value)
  return /^\d+$/.test(text) ? Number(text) : text
}

function matchOrder(value: string): number {
  const normalized = normalizedDisplayToken(value)
  if (normalized === "match") return 0
  if (normalized === "mismatch") return 1
  return 2
}

function normalizedDisplayToken(value: SheetCellValue | undefined): string {
  return keyCell(value)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function fullReplacementRange(
  rangeId: StagingSheetContractId,
  sheetTitle: string,
  endColumn: string,
  current: SheetValueMatrix,
  desired: readonly (readonly SheetCellValue[])[]
): BuildStagingSheetValuePlanInput["ranges"][number] {
  const contract = getStagingSheetContract(rangeId)
  const width = desired[0]?.length ?? contract.headers.length
  const currentTrimmed = trimRows(current, width)
  const height = Math.max(1, currentTrimmed.length, desired.length)
  const firstDataRow = contract.headerRow + 1
  const lastDataRow = firstDataRow + height - 1
  return {
    rangeId,
    a1Range: `'${sheetTitle.replaceAll("'", "''")}'!A${firstDataRow}:${endColumn}${lastDataRow}`,
    currentValues: rectangular(currentTrimmed, height, width),
    desiredValues: Array.from({ length: height }, (_, index) =>
      index < desired.length ? Array.from({ length: width }, (__, column) => desired[index][column] ?? null) : Array(width).fill(null)
    ),
  }
}

function fullReplacementRangeFromRow(
  rangeId: StagingSheetContractId,
  sheetTitle: string,
  firstRow: number,
  endColumn: string,
  current: SheetValueMatrix,
  desired: readonly (readonly SheetCellValue[])[]
): BuildStagingSheetValuePlanInput["ranges"][number] {
  const width = desired[0]?.length ?? getStagingSheetContract(rangeId).headers.length
  const currentTrimmed = trimRows(current, width)
  const height = Math.max(1, currentTrimmed.length, desired.length)
  return {
    rangeId,
    a1Range: `'${sheetTitle.replaceAll("'", "''")}'!A${firstRow}:${endColumn}${firstRow + height - 1}`,
    currentValues: rectangular(currentTrimmed, height, width),
    desiredValues: Array.from({ length: height }, (_, row) =>
      row < desired.length
        ? Array.from({ length: width }, (__, column) => desired[row][column] ?? null)
        : Array(width).fill(null)
    ),
  }
}

function rectangular(values: SheetValueMatrix, height: number, width: number): SheetCellValue[][] {
  return Array.from({ length: height }, (_, row) =>
    Array.from({ length: width }, (__, column) => values[row]?.[column] ?? null)
  )
}

function trimRows(values: SheetValueMatrix, width: number): SheetCellValue[][] {
  const rows = values.map((row) => Array.from({ length: width }, (_, column) => row[column] ?? null))
  while (rows.length > 0 && rows.at(-1)!.every((value) => value === null || value === "")) rows.pop()
  return rows
}

function columnLabel(index: number): string {
  let value = index + 1
  let label = ""
  while (value > 0) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}

function addMonths(isoDate: string, count: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + count)
  return date.toISOString().slice(0, 10)
}

function addDays(isoDate: string, count: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10)
}
