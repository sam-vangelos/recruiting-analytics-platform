import type { KillSwitchState } from "../autonomy"
import { createPayloadFingerprint } from "../checksums"
import { readKillSwitchStates } from "../durable-safety-store"
import { fridayWeekLabels, fridayWeekStartUtc } from "../exec-definitions"
import { createSupabaseSafetyStoreClient } from "../supabase-safety-store-client"
import {
  normalizeStagingSheetStructure,
  readStagingDriveMetadata,
  readStagingSpreadsheet,
  readStagingStructuralNormalizationSnapshot,
  readStagingValueRanges,
  StagingStructuralNormalizationExecutionError,
  type GoogleSheet,
  type GoogleSpreadsheet,
  type GoogleWorkspaceStagingClients,
  type StagingMutationCertificationStatus,
  type StagingSheetStructuralWriteSummary,
  type StagingStructuralFailureStage,
} from "./google-workspace-staging-client"
import { getStagingArtifact } from "./staging-artifact-registry"
import { evaluateStagingKillSwitchStates } from "./staging-kill-switch"
import {
  deliveryRpsDatedRolloverNormalizationSpec,
  finalOfferQuarterRolloverNormalizationSpec,
  pipelineCandidateRolloverNormalizationSpec,
  planStagingStructuralNormalization,
  planWeeklyProgressRolloverNormalization,
  rpsTrackingCapacityNormalizationSpec,
  type DeliveryRpsLifecycleSheet,
  type DeliveryRpsProjectedValueTarget,
  type FinalOfferLifecycleSheet,
  type PipelineArtifactKey,
  type PipelineCandidateLifecycleSheet,
  type PipelineJobSummaryLifecycleSheet,
  type RpsTrackingLifecycleSheet,
  type StagingStructuralNormalizationPlan,
  type StagingStructuralNormalizationSpec,
  type WeeklyProgressLifecycleSheet,
  type WeeklyProgressQuarterClosingOffsets,
  type WeeklyProgressQuarterOpeningOffsets,
} from "./staging-structural-normalization"
import {
  buildPipelineJobWeekStagingValuePlanRange,
} from "./pipeline-weekly-progress-value-inputs"
import { pipelineLegacyWeekOrder, pipelineRenderContracts } from "./pipeline-sheet-renderer"
import {
  getStagingSheetContract,
  type StagingSheetContractId,
} from "./staging-sheet-contracts"
import type { ProjectedStagingStructureBasis, SheetCellValue } from "./staging-value-plan"
import {
  bindStagingStructuralFilterPreimages,
  projectStagingStructuralNormalizationState,
} from "./staging-structural-normalization-observer"
import {
  stagingStructuralNormalizationFingerprint,
  type StagingStructuralWritePermit,
} from "./staging-structural-write-permit"
import { assertStagingSourceFreshness } from "./staging-write-permit"

export type RecurringSheetLifecycleArtifactKey =
  | "weekly_progress"
  | "delivery_roles_rps"
  | "rps_tracking"
  | "final_offer"
  | PipelineArtifactKey

export interface RecurringSheetLifecyclePlanSummary {
  artifactKey: RecurringSheetLifecycleArtifactKey
  reportingWeekFriday: string
  normalizationId: string
  status: StagingStructuralNormalizationPlan["status"]
  forwardRequestCount: number
  rollbackRequestCount: number
  structureFingerprint: string
  driveVersion: string
  copyOnly: false
  canonicalWriteAuthorized: true
  projectedDryRun?: {
    target: DeliveryRpsProjectedValueTarget
    structure: ProjectedStagingStructureBasis
  }
}

export interface RecurringSheetLifecycleFailureSummary {
  artifactKey: RecurringSheetLifecycleArtifactKey
  normalizationId: string
  runId: string
  failureStage: StagingStructuralFailureStage
  mutationCallCount: number
  rollbackAttempted: boolean
  rollbackVerified: boolean
  safePreimageVerified: boolean
  beforeStructureFingerprint: string
  beforeDriveVersion: string | null
  afterDriveVersion: string | null
  certificationStatus: StagingMutationCertificationStatus
}

export interface RecurringSheetLifecycleOutcome {
  artifactKey: RecurringSheetLifecycleArtifactKey
  status: "dry_run" | "already_normalized" | "normalized" | "blocked"
  plan?: RecurringSheetLifecyclePlanSummary
  write?: StagingSheetStructuralWriteSummary
  failure?: RecurringSheetLifecycleFailureSummary
  reason?: string
}

export interface RecurringSheetLifecycleRun {
  runId: string
  mode: "dry_run" | "write"
  reportingWeekFriday: string
  copyOnly: false
  canonicalWriteAuthorized: true
  outcome: RecurringSheetLifecycleOutcome
}

/** Guarded copy-only entry point for observed-state recurring spreadsheet destinations. */
export async function runStagingRecurringSheetLifecycle(input: {
  artifactKey: RecurringSheetLifecycleArtifactKey
  clients: GoogleWorkspaceStagingClients
  reportingWeekFriday?: string
  deliveryRpsReportDate?: string
  mode?: "dry_run" | "write"
  env?: Readonly<Record<string, string | undefined>>
  nowMs?: number
  sourceGeneratedAt?: string
  currentTimeMs?: () => number
  loadKillSwitchStates?: () => Promise<readonly KillSwitchState[]>
  /** Exact projected merged-row count from the persisted source cut; required only for RPS Tracking. */
  requiredDataRows?: number
  /** Persisted source-cut quarter identity; required only for Final Offer. */
  quarterStart?: string
  /** Exact rendered summary rows from the same persisted source cut; required only for pipelines. */
  pipelineJobWeekRows?: readonly (readonly SheetCellValue[])[]
  /** Exact calendar-quarter counts before the first Friday column; required for Weekly Progress when non-empty. */
  weeklyProgressQuarterOpeningOffsets?: readonly WeeklyProgressQuarterOpeningOffsets[]
  /** Exact post-quarter counts inside a Fri-Thu column crossing quarter end; required when non-empty. */
  weeklyProgressQuarterClosingOffsets?: readonly WeeklyProgressQuarterClosingOffsets[]
}): Promise<RecurringSheetLifecycleRun> {
  const mode = input.mode ?? "dry_run"
  if (mode !== "dry_run" && mode !== "write") {
    throw new Error("Recurring sheet lifecycle mode must be dry_run or write.")
  }
  const currentTimeMs = input.currentTimeMs ?? Date.now
  const cycleNowMs = input.nowMs ?? currentTimeMs()
  if (!Number.isFinite(cycleNowMs)) throw new Error("Recurring sheet lifecycle nowMs must be finite.")
  const deliveryRpsReportDate = input.artifactKey === "delivery_roles_rps"
    ? requireDeliveryRpsReportDate(input.deliveryRpsReportDate)
    : undefined
  const availableFriday = deliveryRpsReportDate
    ? fridayWeekStartUtc(new Date(`${deliveryRpsReportDate}T00:00:00.000Z`))
    : fridayWeekStartUtc(new Date(cycleNowMs))
  const reportingWeekFriday = deliveryRpsReportDate
    ? availableFriday
    : input.reportingWeekFriday ?? availableFriday
  if (!deliveryRpsReportDate && reportingWeekFriday !== availableFriday) {
    throw new Error(
      `Recurring sheet lifecycle reporting week ${reportingWeekFriday} is not currently available; expected ${availableFriday}.`
    )
  }
  const cycleKey = input.artifactKey === "delivery_roles_rps"
    ? deliveryRpsReportDate!
    : reportingWeekFriday
  const runId = `${input.artifactKey}_lifecycle_${cycleKey.replaceAll("-", "")}_${new Date(cycleNowMs)
    .toISOString()
    .replace(/[^0-9]/g, "")}`

  let outcome: RecurringSheetLifecycleOutcome
  try {
    const prepared = await prepareRecurringSheetLifecycle({
      artifactKey: input.artifactKey,
      reportingWeekFriday,
      deliveryRpsReportDate: input.deliveryRpsReportDate,
      clients: input.clients,
      requiredDataRows: input.requiredDataRows,
      quarterStart: input.quarterStart,
      pipelineJobWeekRows: input.pipelineJobWeekRows,
      weeklyProgressQuarterOpeningOffsets: input.weeklyProgressQuarterOpeningOffsets,
      weeklyProgressQuarterClosingOffsets: input.weeklyProgressQuarterClosingOffsets,
    })
    if (mode === "dry_run") {
      outcome = { artifactKey: input.artifactKey, status: "dry_run", plan: prepared.summary }
    } else if (!prepared.spec || !prepared.plan) {
      outcome = {
        artifactKey: input.artifactKey,
        status: "already_normalized",
        plan: prepared.summary,
      }
    } else {
      const states = await (input.loadKillSwitchStates
        ? input.loadKillSwitchStates()
        : readKillSwitchStates(createSupabaseSafetyStoreClient()))
      const issuedAtMs = currentTimeMs()
      const killSwitch = evaluateStagingKillSwitchStates(input.artifactKey, states, issuedAtMs)
      if (!killSwitch.clear) {
        outcome = {
          artifactKey: input.artifactKey,
          status: "blocked",
          plan: prepared.summary,
          reason: killSwitch.reason,
        }
      } else {
        const write = await normalizeStagingSheetStructure({
          spec: prepared.spec,
          permit: createRecurringSheetLifecycleWritePermit({
            spec: prepared.spec,
            plan: prepared.plan,
            structureFingerprint: prepared.summary.structureFingerprint,
            driveVersion: prepared.summary.driveVersion,
            runId,
            sourceGeneratedAt: input.sourceGeneratedAt,
            issuedAtMs,
          }),
          clients: input.clients,
          env: input.env,
          nowMs: issuedAtMs,
          currentTimeMs,
          revalidateKillSwitchClear: async ({ artifactKey, nowMs }) => {
            const freshStates = await (input.loadKillSwitchStates
              ? input.loadKillSwitchStates()
              : readKillSwitchStates(createSupabaseSafetyStoreClient()))
            const fresh = evaluateStagingKillSwitchStates(artifactKey, freshStates, nowMs)
            if (!fresh.clear) throw new Error("Durable staging hydration kill switch blocks the mutation boundary.")
          },
        })
        outcome = {
          artifactKey: input.artifactKey,
          status: write.status,
          plan: prepared.summary,
          write,
        }
      }
    }
  } catch (error) {
    const failure = recurringLifecycleFailureSummary(input.artifactKey, error)
    // `safeReason` is a public-safe constant by contract, and the stored evidence
    // keeps only a status, so the actual mismatch between this artifact's
    // normalization spec and the real canonical sheet exists nowhere else.
    console.error(
      `[recruiting-ops-recurring-lifecycle] ${input.artifactKey} blocked:`,
      safeDiagnostic(error)
    )
    outcome = {
      artifactKey: input.artifactKey,
      status: "blocked",
      ...(failure ? { failure } : {}),
      reason: safeReason(error),
    }
  }

  return {
    runId,
    mode,
    reportingWeekFriday,
    copyOnly: false,
    canonicalWriteAuthorized: true,
    outcome,
  }
}

export function createRecurringSheetLifecycleWritePermit(input: {
  spec: StagingStructuralNormalizationSpec
  plan: StagingStructuralNormalizationPlan
  structureFingerprint: string
  driveVersion: string
  runId: string
  sourceGeneratedAt?: string
  issuedAtMs: number
}): StagingStructuralWritePermit {
  if (!isRecurringArtifact(input.spec.artifactKey)) {
    throw new Error("Recurring lifecycle permit requires a registered recurring spreadsheet copy.")
  }
  if (input.plan.status === "planned" && !input.sourceGeneratedAt?.trim()) {
    throw new Error("Recurring sheet lifecycle write requires its persisted source timestamp.")
  }
  if (input.sourceGeneratedAt !== undefined) {
    assertStagingSourceFreshness(input.sourceGeneratedAt, input.issuedAtMs)
  }
  return {
    artifactKey: input.spec.artifactKey,
    artifactId: input.spec.spreadsheetId,
    kind: "google_sheet",
    normalizationId: input.spec.id,
    normalizationFingerprint: stagingStructuralNormalizationFingerprint(input.spec),
    expectedStatus: input.plan.status,
    observedStructureFingerprint: input.structureFingerprint,
    expectedDriveVersion: input.driveVersion,
    runId: input.runId,
    ...(input.sourceGeneratedAt === undefined
      ? {}
      : { sourceGeneratedAt: input.sourceGeneratedAt }),
    issuedAt: new Date(input.issuedAtMs).toISOString(),
    expiresAt: new Date(input.issuedAtMs + 10 * 60_000).toISOString(),
    killSwitchStoreReachable: true,
    killSwitchClear: true,
    canonicalOnly: true,
  }
}

async function prepareRecurringSheetLifecycle(input: {
  artifactKey: RecurringSheetLifecycleArtifactKey
  reportingWeekFriday: string
  deliveryRpsReportDate?: string
  clients: GoogleWorkspaceStagingClients
  requiredDataRows?: number
  quarterStart?: string
  pipelineJobWeekRows?: readonly (readonly SheetCellValue[])[]
  weeklyProgressQuarterOpeningOffsets?: readonly WeeklyProgressQuarterOpeningOffsets[]
  weeklyProgressQuarterClosingOffsets?: readonly WeeklyProgressQuarterClosingOffsets[]
}): Promise<{
  spec: StagingStructuralNormalizationSpec | null
  plan: StagingStructuralNormalizationPlan | null
  summary: RecurringSheetLifecyclePlanSummary
}> {
  let discovery:
    | WeeklyProgressLifecycleSheet[]
    | PipelineCandidateLifecycleSheet[]
    | DeliveryRpsLifecycleSheet[]
    | FinalOfferLifecycleSheet[]
    | RpsTrackingLifecycleSheet
  let spec: StagingStructuralNormalizationSpec | null
  let projectedValueTarget: DeliveryRpsProjectedValueTarget | null = null
  let discoveryMetadata: Awaited<ReturnType<typeof readStagingDriveMetadata>> | null = null
  if (input.artifactKey === "weekly_progress") {
    discovery = await discoverWeeklyProgress(input.clients)
    spec = planWeeklyProgressRolloverNormalization({
      reportingWeekFriday: input.reportingWeekFriday,
      sheets: discovery,
      quarterOpeningOffsets: input.weeklyProgressQuarterOpeningOffsets,
      quarterClosingOffsets: input.weeklyProgressQuarterClosingOffsets,
    }).spec
  } else if (input.artifactKey === "delivery_roles_rps") {
    discovery = await discoverDeliveryRps(input.clients)
    const deliverySpec = deliveryRpsDatedRolloverNormalizationSpec({
      reportDate: requireDeliveryRpsReportDate(input.deliveryRpsReportDate),
      sheets: discovery,
    })
    projectedValueTarget = deliverySpec.projectedValueTarget
    spec = deliverySpec
  } else if (input.artifactKey === "rps_tracking") {
    if (!Number.isInteger(input.requiredDataRows) || (input.requiredDataRows ?? -1) < 0) {
      throw new Error("RPS Tracking lifecycle requires the persisted source cut's projected row count.")
    }
    discovery = await discoverRpsTracking(input.clients)
    spec = rpsTrackingCapacityNormalizationSpec({
      requiredDataRows: input.requiredDataRows as number,
      sheet: discovery,
    })
  } else if (input.artifactKey === "final_offer") {
    if (!input.quarterStart) {
      throw new Error("Final Offer lifecycle requires the persisted source cut's quarter start.")
    }
    const finalOfferSheets = await discoverFinalOffer(input.clients)
    discovery = finalOfferSheets
    spec = finalOfferQuarterRolloverNormalizationSpec({
      quarterStart: input.quarterStart,
      sheets: finalOfferSheets,
    })
  } else {
    const pipeline = await discoverPipeline(
      input.artifactKey,
      input.reportingWeekFriday,
      input.pipelineJobWeekRows ?? [],
      input.clients
    )
    discovery = pipeline.sheets
    discoveryMetadata = pipeline.metadata
    spec = pipelineCandidateRolloverNormalizationSpec({
      artifactKey: input.artifactKey,
      reportingWeekFriday: input.reportingWeekFriday,
      sheets: discovery,
      jobSummary: pipeline.jobSummary,
    })
  }
  const metadata = discoveryMetadata
    ?? await readStagingDriveMetadata(input.artifactKey, input.clients)
  const artifact = getStagingArtifact(input.artifactKey)
  assertEditableCanonicalMetadata(metadata, artifact.artifactId)
  const driveVersion = String(metadata.version ?? "").trim()
  if (!driveVersion) throw new Error("Copied recurring-lifecycle spreadsheet Drive version is missing.")

  if (!spec) {
    return {
      spec: null,
      plan: null,
      summary: {
        artifactKey: input.artifactKey,
        reportingWeekFriday: input.reportingWeekFriday,
        normalizationId: input.artifactKey === "weekly_progress"
          ? `weekly_progress_rollover_${input.reportingWeekFriday.replaceAll("-", "")}`
          : input.artifactKey === "final_offer"
            ? `final_offer_quarter_rollover_${input.quarterStart!.replaceAll("-", "")}`
          : `${input.artifactKey}_lifecycle_${input.reportingWeekFriday.replaceAll("-", "")}`,
        status: "already_normalized",
        forwardRequestCount: 0,
        rollbackRequestCount: 0,
        structureFingerprint: createPayloadFingerprint(discovery),
        driveVersion,
        copyOnly: false,
        canonicalWriteAuthorized: true,
      },
    }
  }

  const observed = await readStagingStructuralNormalizationSnapshot(spec, input.clients)
  const boundSpec = bindStagingStructuralFilterPreimages(spec, observed.spreadsheet)
  const state = projectStagingStructuralNormalizationState(observed.spreadsheet, boundSpec)
  const plan = planStagingStructuralNormalization(boundSpec, state)
  return {
    spec: boundSpec,
    plan,
    summary: {
      artifactKey: input.artifactKey,
      reportingWeekFriday: input.reportingWeekFriday,
      normalizationId: boundSpec.id,
      status: plan.status,
      forwardRequestCount: plan.requestMetadata.forwardRequestCount,
      rollbackRequestCount: plan.requestMetadata.rollbackRequestCount,
      structureFingerprint: observed.structure.structureHash,
      driveVersion,
      copyOnly: false,
      canonicalWriteAuthorized: true,
      ...(projectedValueTarget && plan.status === "planned"
        ? {
            projectedDryRun: {
              target: projectedValueTarget,
              structure: {
                kind: "projected_post_normalization" as const,
                normalizationId: boundSpec.id,
                normalizationFingerprint: stagingStructuralNormalizationFingerprint(boundSpec),
                observedDriveVersion: driveVersion,
                observedStructureFingerprint: observed.structure.structureHash,
                expectedAfterStateFingerprint: plan.requestMetadata.afterStateFingerprint,
                forwardRequestsFingerprint: plan.requestMetadata.forwardRequestsFingerprint,
                rollbackRequestsFingerprint: plan.requestMetadata.rollbackRequestsFingerprint,
              },
            },
          }
        : {}),
    },
  }
}

async function discoverWeeklyProgress(
  clients: GoogleWorkspaceStagingClients
): Promise<WeeklyProgressLifecycleSheet[]> {
  const configs = [
    { sheetId: 0, sheetTitle: "FDL (Code + RL)", formulaRowCount: 7 },
    { sheetId: 242118538, sheetTitle: "FDE/PE", formulaRowCount: 6 },
    { sheetId: 1450892249, sheetTitle: "FDL (Brazil + Colombia)", formulaRowCount: 7 },
  ] as const
  const spreadsheet = await readStagingSpreadsheet("weekly_progress", clients, {
    includeGridData: true,
    ranges: configs.map(({ sheetTitle }) => `'${sheetTitle.replaceAll("'", "''")}'!A1:ZZ8`),
    fields: "spreadsheetId,sheets(properties(sheetId,title,gridProperties(columnCount)),data(startRow,startColumn,rowData(values(userEnteredValue(stringValue,formulaValue)))))",
  })
  assertDiscoverySpreadsheet("weekly_progress", spreadsheet)
  return configs.map((config) => {
    const matches = (spreadsheet.sheets ?? []).filter(
      (sheet) => sheet.properties?.sheetId === config.sheetId && sheet.properties?.title === config.sheetTitle
    )
    if (matches.length !== 1) {
      throw new Error(`Weekly Progress discovery requires exact copied tab ${config.sheetTitle}.`)
    }
    const sheet = matches[0]
    const columnCount = sheet.properties?.gridProperties?.columnCount
    if (!Number.isInteger(columnCount) || (columnCount ?? 0) <= 0 || (columnCount ?? 0) > 702) {
      throw new Error(`${config.sheetTitle} column count is outside the bounded lifecycle read.`)
    }
    const headers = Array.from({ length: columnCount as number }, (_, column) =>
      enteredString(sheet, 0, column)
    )
    const qtdColumns = headers.flatMap((value, index) => value?.trim() === "QTD" ? [index] : [])
    if (qtdColumns.length !== 1) {
      throw new Error(`${config.sheetTitle} discovery requires exactly one QTD header.`)
    }
    return {
      sheetId: config.sheetId,
      sheetTitle: config.sheetTitle,
      headers,
      qtdFormulas: Array.from({ length: config.formulaRowCount }, (_, row) =>
        enteredFormula(sheet, row + 1, qtdColumns[0]) ?? ""
      ),
    }
  })
}

async function discoverPipeline(
  artifactKey: PipelineArtifactKey,
  reportingWeekFriday: string,
  desiredRows: readonly (readonly SheetCellValue[])[],
  clients: GoogleWorkspaceStagingClients
): Promise<{
  sheets: PipelineCandidateLifecycleSheet[]
  jobSummary: PipelineJobSummaryLifecycleSheet
  metadata: Awaited<ReturnType<typeof readStagingDriveMetadata>>
}> {
  const artifact = getStagingArtifact(artifactKey)
  const beforeMetadata = await readStagingDriveMetadata(artifactKey, clients)
  assertEditableCanonicalMetadata(beforeMetadata, artifact.artifactId)
  const beforeVersion = String(beforeMetadata.version ?? "").trim()
  if (!beforeVersion) throw new Error("Pipeline lifecycle discovery Drive version is missing.")
  const contract = getStagingSheetContract(`${artifactKey}_job_week` as StagingSheetContractId)
  const [spreadsheet, [values]] = await Promise.all([
    readStagingSpreadsheet(artifactKey, clients, {
      fields: "spreadsheetId,sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)),basicFilter(range))",
    }),
    readStagingValueRanges(
      artifactKey,
      [`'${contract.sheetTitle.replaceAll("'", "''")}'!A:${columnLabel(contract.headers.length - 1)}`],
      clients
    ),
  ])
  const afterMetadata = await readStagingDriveMetadata(artifactKey, clients)
  assertEditableCanonicalMetadata(afterMetadata, artifact.artifactId)
  if (String(afterMetadata.version ?? "").trim() !== beforeVersion) {
    throw new Error("Pipeline lifecycle discovery changed while observed; refusing an unstable target.")
  }
  assertDiscoverySpreadsheet(artifactKey, spreadsheet)
  const sheets = (spreadsheet.sheets ?? []).map((sheet) => pipelineSheetDescriptor(sheet))
  const matches = sheets.filter(
    (sheet) => sheet.sheetId === contract.sheetId && sheet.sheetTitle === contract.sheetTitle
  )
  if (matches.length !== 1) {
    throw new Error(`${artifactKey} lifecycle requires its exact copied job-summary tab.`)
  }
  return {
    sheets,
    metadata: afterMetadata,
    jobSummary: pipelineJobSummaryLifecycleSheet({
      artifactKey,
      reportingWeekFriday,
      sheet: matches[0],
      values: values.values,
      desiredRows,
    }),
  }
}

export function pipelineJobSummaryLifecycleSheet(input: {
  artifactKey: PipelineArtifactKey
  reportingWeekFriday: string
  sheet: PipelineCandidateLifecycleSheet
  values: readonly (readonly SheetCellValue[])[]
  desiredRows: readonly (readonly SheetCellValue[])[]
}): PipelineJobSummaryLifecycleSheet {
  const contract = getStagingSheetContract(`${input.artifactKey}_job_week` as StagingSheetContractId)
  const width = contract.headers.length
  const row = (index: number) =>
    Array.from({ length: width }, (_, column) => normalizeSheetCell(input.values[index]?.[column]))
  const requisitionIds = pipelineRenderContracts[input.artifactKey].requisitionIds
  const desiredRows = input.desiredRows.map((desired) =>
    Array.from({ length: width }, (_, column) => normalizeSheetCell(desired[column]))
  )
  const targetWeekOrder = String(
    pipelineLegacyWeekOrder(input.artifactKey, input.reportingWeekFriday)
  )
  const targetWeek = fridayWeekLabels(input.reportingWeekFriday).weekShort
  if (
    input.desiredRows.some((desired) => desired.length !== width) ||
    desiredRows.length !== requisitionIds.length ||
    desiredRows.some(
      (desired, index) =>
        String(desired[0] ?? "").trim() !== targetWeekOrder ||
        String(desired[1] ?? "").trim() !== targetWeek ||
        String(desired[2] ?? "").trim() !== requisitionIds[index]
    )
  ) {
    throw new Error(`${contract.id} desired reporting block is incomplete or drifted.`)
  }
  const valueTarget = buildPipelineJobWeekStagingValuePlanRange({
    artifactKey: input.artifactKey,
    target: { sheetTitle: input.sheet.sheetTitle, currentMatrix: input.values },
    desiredRows: input.desiredRows,
  })
  const targetA1 = /!A(\d+):/.exec(valueTarget.a1Range)
  const appendStartRowIndex = Number(targetA1?.[1]) - 1
  if (!Number.isInteger(appendStartRowIndex) || appendStartRowIndex < contract.headerRow) {
    throw new Error(`${contract.id} bounded value target could not be bound to a summary row.`)
  }

  const completeBlocks: number[] = []
  for (
    let startRowIndex = contract.headerRow;
    startRowIndex + requisitionIds.length <= input.values.length;
    startRowIndex += 1
  ) {
    const block = requisitionIds.map((_, offset) => row(startRowIndex + offset))
    const weekOrder = String(block[0][0] ?? "").trim()
    const week = String(block[0][1] ?? "").trim()
    if (
      weekOrder &&
      week &&
      block.every(
        (entry, offset) =>
          String(entry[0] ?? "").trim() === weekOrder &&
          String(entry[1] ?? "").trim() === week &&
          String(entry[2] ?? "").trim() === requisitionIds[offset]
      )
    ) {
      completeBlocks.push(startRowIndex)
    }
  }
  const targetBlocks = completeBlocks.filter((startRowIndex) => {
    const first = row(startRowIndex)
    return String(first[0] ?? "").trim() === targetWeekOrder &&
      String(first[1] ?? "").trim() === targetWeek
  })
  const targetIdentityRows = input.values.flatMap((_, index) => {
    const current = row(index)
    return String(current[0] ?? "").trim() === targetWeekOrder &&
      String(current[1] ?? "").trim() === targetWeek &&
      requisitionIds.includes(String(current[2] ?? "").trim())
      ? [index]
      : []
  })
  if (
    targetBlocks.length > 1 ||
    (targetIdentityRows.length > 0 &&
      (targetBlocks.length !== 1 || targetIdentityRows.length !== requisitionIds.length))
  ) {
    throw new Error(`${contract.id} current reporting block is partial or ambiguous.`)
  }
  const exactDesiredBlocks = completeBlocks.filter((startRowIndex) =>
    desiredRows.every((desired, offset) =>
      row(startRowIndex + offset).every((value, column) => value === desired[column])
    )
  )
  if (exactDesiredBlocks.length > 1) {
    throw new Error(`${contract.id} exact desired reporting block is ambiguous.`)
  }
  const templateStartRowIndex = completeBlocks
    .filter((startRowIndex) => startRowIndex + requisitionIds.length <= appendStartRowIndex)
    .at(-1)
  if (templateStartRowIndex === undefined) {
    throw new Error(`${contract.id} has no complete predecessor summary block.`)
  }

  return {
    sheetId: input.sheet.sheetId,
    sheetTitle: input.sheet.sheetTitle,
    gridRowCount: input.sheet.gridRowCount,
    gridColumnCount: input.sheet.gridColumnCount,
    basicFilter: input.sheet.basicFilter,
    templateStartRowIndex,
    appendStartRowIndex,
    blockRowCount: requisitionIds.length,
  }
}

async function discoverFinalOffer(
  clients: GoogleWorkspaceStagingClients
): Promise<FinalOfferLifecycleSheet[]> {
  const spreadsheet = await readStagingSpreadsheet("final_offer", clients, {
    fields: "spreadsheetId,sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)),basicFilter(range))",
  })
  assertDiscoverySpreadsheet("final_offer", spreadsheet)
  const pivotTitles = (spreadsheet.sheets ?? [])
    .map((sheet) => sheet.properties?.title ?? "")
    .filter((title) =>
      title.startsWith("Recruiter Performance Table_") ||
      title.startsWith("Sourcer Performance Table_")
    )
  const pivotSpreadsheet = await readStagingSpreadsheet("final_offer", clients, {
    includeGridData: true,
    ranges: pivotTitles.map((title) => `'${title.replaceAll("'", "''")}'!A1`),
    fields: [
      "spreadsheetId",
      "sheets(properties(sheetId,title))",
      "sheets(data(startRow,startColumn,rowData(values(pivotTable(source)))))",
    ].join(","),
  })
  assertDiscoverySpreadsheet("final_offer", pivotSpreadsheet)
  const pivotSources = new Map(
    (pivotSpreadsheet.sheets ?? []).map((sheet) => [
      sheet.properties?.sheetId,
      numericRange(sheet.data?.[0]?.rowData?.[0]?.values?.[0]?.pivotTable?.source),
    ] as const)
  )
  return (spreadsheet.sheets ?? []).map((sheet) => finalOfferSheetDescriptor(
    sheet,
    pivotSources.get(sheet.properties?.sheetId) ?? null
  ))
}

function finalOfferSheetDescriptor(
  sheet: GoogleSheet,
  pivotSource: Readonly<Record<string, number>> | null
): FinalOfferLifecycleSheet {
  const descriptor = pipelineSheetDescriptor(sheet)
  return {
    ...descriptor,
    pivotSource,
  }
}

function numericRange(value: unknown): Readonly<Record<string, number>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number"
  )
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

async function discoverRpsTracking(
  clients: GoogleWorkspaceStagingClients
): Promise<RpsTrackingLifecycleSheet> {
  const spreadsheet = await readStagingSpreadsheet("rps_tracking", clients, {
    includeGridData: true,
    ranges: ["'Data Dump'!A1", "'RPS Table'!A1"],
    fields: [
      "spreadsheetId",
      "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))",
      "sheets(data(startRow,startColumn,rowData(values(pivotTable(source)))))",
    ].join(","),
  })
  assertDiscoverySpreadsheet("rps_tracking", spreadsheet)
  const dataMatches = (spreadsheet.sheets ?? []).filter(
    (sheet) => sheet.properties?.sheetId === 1092300150 && sheet.properties?.title === "Data Dump"
  )
  const pivotMatches = (spreadsheet.sheets ?? []).filter(
    (sheet) => sheet.properties?.sheetId === 855929445 && sheet.properties?.title === "RPS Table"
  )
  if (dataMatches.length !== 1 || pivotMatches.length !== 1) {
    throw new Error("RPS Tracking lifecycle requires the exact copied Data Dump and RPS Table tabs.")
  }
  const dataGrid = dataMatches[0].properties?.gridProperties
  const pivot = pivotMatches[0]
  const source = pivot.data?.[0]?.rowData?.[0]?.values?.[0]?.pivotTable?.source
  if (
    !Number.isInteger(dataGrid?.rowCount) ||
    dataGrid?.columnCount !== 18 ||
    !source
  ) {
    throw new Error("RPS Tracking lifecycle discovery returned incomplete grid or pivot metadata.")
  }
  const pivotSource = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, number] => typeof entry[1] === "number")
  )
  return {
    dataSheetId: 1092300150,
    dataSheetTitle: "Data Dump",
    dataRowCount: dataGrid?.rowCount as number,
    dataColumnCount: 18,
    pivotSheetId: 855929445,
    pivotSheetTitle: "RPS Table",
    pivotSource,
  }
}

async function discoverDeliveryRps(
  clients: GoogleWorkspaceStagingClients
): Promise<DeliveryRpsLifecycleSheet[]> {
  const spreadsheet = await readStagingSpreadsheet("delivery_roles_rps", clients, {
    fields: "spreadsheetId,sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)),basicFilter(range))",
  })
  assertDiscoverySpreadsheet("delivery_roles_rps", spreadsheet)
  return (spreadsheet.sheets ?? []).map((sheet) => pipelineSheetDescriptor(sheet))
}

function pipelineSheetDescriptor(sheet: GoogleSheet): PipelineCandidateLifecycleSheet {
  const sheetId = sheet.properties?.sheetId
  const sheetTitle = sheet.properties?.title
  const sheetIndex = sheet.properties?.index
  const gridRowCount = sheet.properties?.gridProperties?.rowCount
  const gridColumnCount = sheet.properties?.gridProperties?.columnCount
  if (
    !Number.isInteger(sheetId) ||
    typeof sheetTitle !== "string" ||
    !Number.isInteger(sheetIndex) ||
    !Number.isInteger(gridRowCount) ||
    !Number.isInteger(gridColumnCount)
  ) {
    throw new Error("Pipeline lifecycle discovery returned incomplete sheet metadata.")
  }
  const range = sheet.basicFilter?.range
  const endRowIndex = typeof range?.endRowIndex === "number" ? range.endRowIndex : undefined
  const endColumnIndex = typeof range?.endColumnIndex === "number" ? range.endColumnIndex : undefined
  const basicFilter = range
    ? {
        sheetId: range.sheetId ?? (sheetId as number),
        startRowIndex: range.startRowIndex ?? 0,
        ...(endRowIndex === undefined || endRowIndex === gridRowCount
          ? {}
          : { endRowIndex }),
        startColumnIndex: range.startColumnIndex ?? 0,
        ...(endColumnIndex === undefined ? {} : { endColumnIndex }),
      }
    : null
  return {
    sheetId: sheetId as number,
    sheetTitle,
    sheetIndex: sheetIndex as number,
    gridRowCount: gridRowCount as number,
    gridColumnCount: gridColumnCount as number,
    basicFilter,
  }
}

function enteredString(sheet: GoogleSheet, row: number, column: number): string | null {
  const entered = enteredValue(sheet, row, column)
  return typeof entered?.stringValue === "string" ? entered.stringValue : null
}

function enteredFormula(sheet: GoogleSheet, row: number, column: number): string | null {
  const entered = enteredValue(sheet, row, column)
  return typeof entered?.formulaValue === "string" ? entered.formulaValue : null
}

function enteredValue(sheet: GoogleSheet, row: number, column: number) {
  for (const grid of sheet.data ?? []) {
    const startRow = grid.startRow ?? 0
    const startColumn = grid.startColumn ?? 0
    const rowOffset = row - startRow
    const columnOffset = column - startColumn
    if (rowOffset < 0 || columnOffset < 0) continue
    const cell = grid.rowData?.[rowOffset]?.values?.[columnOffset]
    if (cell?.userEnteredValue) return cell.userEnteredValue
  }
  return null
}

function normalizeSheetCell(value: SheetCellValue | undefined): SheetCellValue {
  return value === undefined || value === "" ? null : value
}

function requireDeliveryRpsReportDate(value: string | undefined): string {
  if (!value) throw new Error("Delivery RPS lifecycle requires the current business date.")
  return value
}

function columnLabel(columnIndex: number): string {
  let label = ""
  for (let current = columnIndex + 1; current > 0; current = Math.floor((current - 1) / 26)) {
    label = String.fromCharCode(65 + ((current - 1) % 26)) + label
  }
  return label
}

function assertDiscoverySpreadsheet(
  artifactKey: RecurringSheetLifecycleArtifactKey,
  spreadsheet: GoogleSpreadsheet
): void {
  const artifact = getStagingArtifact(artifactKey)
  if (artifact.kind !== "google_sheet" || spreadsheet.spreadsheetId !== artifact.artifactId) {
    throw new Error(`${artifactKey} lifecycle discovery is not the exact registered canonical spreadsheet.`)
  }
}

function assertEditableCanonicalMetadata(
  metadata: {
    id?: string | null
    mimeType?: string | null
    trashed?: boolean | null
    capabilities?: { canEdit?: boolean | null; canModifyContent?: boolean | null } | null
  },
  expectedId: string
): void {
  if (metadata.id !== expectedId || metadata.mimeType !== "application/vnd.google-apps.spreadsheet") {
    throw new Error("Recurring lifecycle preflight is not the exact registered canonical spreadsheet.")
  }
  if (metadata.trashed) throw new Error("Registered recurring-lifecycle spreadsheet is trashed.")
  if (metadata.capabilities?.canEdit !== true || metadata.capabilities?.canModifyContent !== true) {
    throw new Error("Approved writer cannot edit the registered recurring-lifecycle spreadsheet.")
  }
}

function recurringLifecycleFailureSummary(
  artifactKey: RecurringSheetLifecycleArtifactKey,
  error: unknown
): RecurringSheetLifecycleFailureSummary | undefined {
  if (!(error instanceof StagingStructuralNormalizationExecutionError)) return undefined
  return {
    artifactKey,
    normalizationId: error.normalizationId,
    runId: error.runId,
    failureStage: error.failureStage,
    mutationCallCount: error.mutationCallCount,
    rollbackAttempted: error.rollbackAttempted,
    rollbackVerified: error.rollbackVerified,
    safePreimageVerified: error.safePreimageVerified,
    beforeStructureFingerprint: error.beforeStructureFingerprint,
    beforeDriveVersion: error.beforeDriveVersion,
    afterDriveVersion: error.afterDriveVersion,
    certificationStatus: error.certificationStatus,
  }
}

function isRecurringArtifact(value: string): value is RecurringSheetLifecycleArtifactKey {
  return [
    "weekly_progress",
    "delivery_roles_rps",
    "rps_tracking",
    "final_offer",
    "pipeline_890",
    "pipeline_907",
    "pipeline_1026_1027",
    "pipeline_1118_1119",
  ].includes(value)
}

function safeReason(error: unknown): string {
  return error instanceof StagingStructuralNormalizationExecutionError
    ? "Staging structural normalization failed."
    : "Recurring sheet lifecycle failed."
}

/** Error text only. Source payloads and identifiers never reach a log. */
function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/g, " ").slice(0, 300)
}
