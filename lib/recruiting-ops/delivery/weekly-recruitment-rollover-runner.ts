import type { KillSwitchState } from "../autonomy"
import { readKillSwitchStates } from "../durable-safety-store"
import { createSupabaseSafetyStoreClient } from "../supabase-safety-store-client"
import {
  normalizeStagingSheetStructure,
  readStagingDriveMetadata,
  readStagingSpreadsheet,
  readStagingStructuralNormalizationSnapshot,
  StagingStructuralNormalizationExecutionError,
  type GoogleWorkspaceStagingClients,
  type StagingMutationCertificationStatus,
  type StagingSheetStructuralWriteSummary,
  type StagingStructuralFailureStage,
} from "./google-workspace-staging-client"
import { getStagingArtifact } from "./staging-artifact-registry"
import { evaluateStagingKillSwitchStates } from "./staging-kill-switch"
import {
  planStagingStructuralNormalization,
  weeklyRecruitmentRolloverNormalizationSpec,
  type StagingStructuralNormalizationPlan,
  type StagingStructuralNormalizationSpec,
} from "./staging-structural-normalization"
import {
  bindStagingStructuralFilterPreimages,
  projectStagingStructuralNormalizationState,
} from "./staging-structural-normalization-observer"
import {
  stagingStructuralNormalizationFingerprint,
  type StagingStructuralWritePermit,
} from "./staging-structural-write-permit"
import {
  currentWeeklyRecruitmentFriday,
  requireAvailableWeeklyRecruitmentFriday,
  selectWeeklyRecruitmentPredecessorSheet,
  weeklyRecruitmentCycle,
  type WeeklyRecruitmentSheetDescriptor,
} from "./weekly-recruitment-rollover"

export interface WeeklyRecruitmentRolloverPlanSummary {
  artifactKey: "weekly_recruitment"
  reportingWeekFriday: string
  targetSheetId: number
  targetSheetTitle: string
  predecessorSheetId: number
  predecessorSheetTitle: string
  normalizationId: string
  status: StagingStructuralNormalizationPlan["status"]
  forwardRequestCount: number
  rollbackRequestCount: number
  structureFingerprint: string
  preimageFingerprint: string
  afterStateFingerprint: string
  forwardRequestsFingerprint: string
  rollbackRequestsFingerprint: string
  driveVersion: string
  literalRangeCount: number
  literalCellUpperBound: number
  copyOnly: false
  canonicalWriteAuthorized: true
}

export interface WeeklyRecruitmentRolloverFailureSummary {
  artifactKey: "weekly_recruitment"
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

export interface WeeklyRecruitmentRolloverOutcome {
  artifactKey: "weekly_recruitment"
  status: "dry_run" | "already_normalized" | "normalized" | "blocked"
  plan?: WeeklyRecruitmentRolloverPlanSummary
  write?: StagingSheetStructuralWriteSummary
  failure?: WeeklyRecruitmentRolloverFailureSummary
  reason?: string
}

export interface WeeklyRecruitmentRolloverRun {
  runId: string
  mode: "dry_run" | "write"
  reportingWeekFriday: string
  copyOnly: false
  canonicalWriteAuthorized: true
  outcomes: readonly [WeeklyRecruitmentRolloverOutcome]
}

/**
 * Creates one fresh Weekly Recruitment tab through the same guarded structural
 * writer used by audited copy migrations. A new tab still receives exact
 * predecessor-copy certification. A later hydrated target is recognized only
 * by its deterministic copy-bound identity and ordering, then independently
 * checked by the bounded value and row-lifecycle runners without a rollover write.
 */
export async function runWeeklyRecruitmentStagingRollover(input: {
  clients: GoogleWorkspaceStagingClients
  reportingWeekFriday?: string
  mode?: "dry_run" | "write"
  env?: Readonly<Record<string, string | undefined>>
  nowMs?: number
  currentTimeMs?: () => number
  loadKillSwitchStates?: () => Promise<readonly KillSwitchState[]>
}): Promise<WeeklyRecruitmentRolloverRun> {
  const mode = input.mode ?? "dry_run"
  if (mode !== "dry_run" && mode !== "write") {
    throw new Error("Weekly Recruitment rollover mode must be dry_run or write.")
  }
  const currentTimeMs = input.currentTimeMs ?? Date.now
  const cycleNowMs = input.nowMs ?? currentTimeMs()
  const reportingWeekFriday = input.reportingWeekFriday ?? currentWeeklyRecruitmentFriday(cycleNowMs)
  requireAvailableWeeklyRecruitmentFriday(reportingWeekFriday, cycleNowMs)
  const runId = `weekly_recruitment_rollover_${reportingWeekFriday.replaceAll("-", "")}_${new Date(cycleNowMs)
    .toISOString()
    .replace(/[^0-9]/g, "")}`

  let outcome: WeeklyRecruitmentRolloverOutcome
  try {
    const prepared = await prepareWeeklyRecruitmentRollover({
      clients: input.clients,
      reportingWeekFriday,
    })
    if (mode === "dry_run") {
      outcome = {
        artifactKey: "weekly_recruitment",
        status: "dry_run",
        plan: prepared.summary,
      }
    } else if (prepared.targetAlreadyExists) {
      outcome = {
        artifactKey: "weekly_recruitment",
        status: "already_normalized",
        plan: prepared.summary,
      }
    } else {
      const states = await (input.loadKillSwitchStates
        ? input.loadKillSwitchStates()
        : readKillSwitchStates(createSupabaseSafetyStoreClient()))
      const issuedAtMs = currentTimeMs()
      const killSwitch = evaluateStagingKillSwitchStates(
        "weekly_recruitment",
        states,
        issuedAtMs
      )
      if (!killSwitch.clear) {
        outcome = {
          artifactKey: "weekly_recruitment",
          status: "blocked",
          plan: prepared.summary,
          reason: killSwitch.reason,
        }
      } else {
        const permit = createWeeklyRecruitmentRolloverWritePermit({
          spec: prepared.spec,
          plan: prepared.plan,
          structureFingerprint: prepared.summary.structureFingerprint,
          driveVersion: prepared.summary.driveVersion,
          runId,
          issuedAtMs,
        })
        const write = await normalizeStagingSheetStructure({
          spec: prepared.spec,
          permit,
          clients: input.clients,
          env: input.env,
          nowMs: issuedAtMs,
          currentTimeMs,
          revalidateKillSwitchClear: async ({ nowMs }) => {
            const freshStates = await (input.loadKillSwitchStates
              ? input.loadKillSwitchStates()
              : readKillSwitchStates(createSupabaseSafetyStoreClient()))
            const fresh = evaluateStagingKillSwitchStates("weekly_recruitment", freshStates, nowMs)
            if (!fresh.clear) throw new Error("Durable staging hydration kill switch blocks the mutation boundary.")
          },
        })
        outcome = {
          artifactKey: "weekly_recruitment",
          status: write.status,
          plan: prepared.summary,
          write,
        }
      }
    }
  } catch (error) {
    const failure = rolloverFailureSummary(error)
    outcome = {
      artifactKey: "weekly_recruitment",
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
    outcomes: [outcome],
  }
}

export function createWeeklyRecruitmentRolloverWritePermit(input: {
  spec: StagingStructuralNormalizationSpec
  plan: StagingStructuralNormalizationPlan
  structureFingerprint: string
  driveVersion: string
  runId: string
  issuedAtMs: number
}): StagingStructuralWritePermit {
  if (input.spec.artifactKey !== "weekly_recruitment") {
    throw new Error("Weekly Recruitment rollover permit requires the weekly_recruitment copy.")
  }
  return {
    artifactKey: "weekly_recruitment",
    artifactId: input.spec.spreadsheetId,
    kind: "google_sheet",
    normalizationId: input.spec.id,
    normalizationFingerprint: stagingStructuralNormalizationFingerprint(input.spec),
    expectedStatus: input.plan.status,
    observedStructureFingerprint: input.structureFingerprint,
    expectedDriveVersion: input.driveVersion,
    runId: input.runId,
    issuedAt: new Date(input.issuedAtMs).toISOString(),
    expiresAt: new Date(input.issuedAtMs + 10 * 60_000).toISOString(),
    killSwitchStoreReachable: true,
    killSwitchClear: true,
    canonicalOnly: true,
  }
}

async function prepareWeeklyRecruitmentRollover(input: {
  clients: GoogleWorkspaceStagingClients
  reportingWeekFriday: string
}): Promise<{
  spec: StagingStructuralNormalizationSpec
  plan: StagingStructuralNormalizationPlan
  summary: WeeklyRecruitmentRolloverPlanSummary
  targetAlreadyExists: boolean
}> {
  const discovery = await readStagingSpreadsheet("weekly_recruitment", input.clients, {
    fields: "spreadsheetId,sheets(properties(sheetId,title,index))",
  })
  const target = getStagingArtifact("weekly_recruitment")
  if (target.kind !== "google_sheet") {
    throw new Error("Registered Weekly Recruitment staging artifact is not a spreadsheet.")
  }
  const expectedSpreadsheetId = target.artifactId
  if (discovery.spreadsheetId !== expectedSpreadsheetId) {
    throw new Error("Weekly Recruitment discovery is not the exact registered canonical spreadsheet.")
  }
  const sheets = weeklyRecruitmentSheetDescriptors(discovery.sheets)
  const predecessor = selectWeeklyRecruitmentPredecessorSheet(sheets, input.reportingWeekFriday)
  const cycle = weeklyRecruitmentCycle(input.reportingWeekFriday)
  const targetAlreadyExists = recognizeExistingWeeklyRecruitmentTarget(
    sheets,
    predecessor,
    cycle
  )
  const spec = weeklyRecruitmentRolloverNormalizationSpec({
    reportingWeekFriday: input.reportingWeekFriday,
    predecessorSheetId: predecessor.sheetId,
    predecessorSheetTitle: predecessor.title,
  })
  const [metadata, observed] = await Promise.all([
    readStagingDriveMetadata("weekly_recruitment", input.clients),
    readStagingStructuralNormalizationSnapshot(spec, input.clients),
  ])
  assertEditableCanonicalMetadata(metadata, spec.spreadsheetId)
  const driveVersion = String(metadata.version ?? "").trim()
  if (!driveVersion) throw new Error("Copied Weekly Recruitment spreadsheet Drive version is missing.")
  const boundSpec = bindStagingStructuralFilterPreimages(spec, observed.spreadsheet)
  if (targetAlreadyExists) {
    const observedSheets = weeklyRecruitmentSheetDescriptors(observed.spreadsheet.sheets)
    const observedPredecessor = selectWeeklyRecruitmentPredecessorSheet(
      observedSheets,
      input.reportingWeekFriday
    )
    if (
      observedPredecessor.sheetId !== predecessor.sheetId ||
      observedPredecessor.title !== predecessor.title ||
      !recognizeExistingWeeklyRecruitmentTarget(observedSheets, observedPredecessor, cycle)
    ) {
      throw new Error("Weekly Recruitment target changed during rollover observation.")
    }
  }
  const state = targetAlreadyExists
    ? boundSpec.expectedAfter
    : projectStagingStructuralNormalizationState(observed.spreadsheet, boundSpec)
  const plan = planStagingStructuralNormalization(boundSpec, state)
  if (targetAlreadyExists && plan.status !== "already_normalized") {
    throw new Error("Existing Weekly Recruitment target did not produce a zero-mutation rollover plan.")
  }
  return {
    spec: boundSpec,
    plan,
    targetAlreadyExists,
    summary: {
      artifactKey: "weekly_recruitment",
      reportingWeekFriday: input.reportingWeekFriday,
      targetSheetId: cycle.targetSheetId,
      targetSheetTitle: cycle.targetSheetTitle,
      predecessorSheetId: predecessor.sheetId,
      predecessorSheetTitle: predecessor.title,
      normalizationId: spec.id,
      status: plan.status,
      forwardRequestCount: plan.requestMetadata.forwardRequestCount,
      rollbackRequestCount: plan.requestMetadata.rollbackRequestCount,
      structureFingerprint: observed.structure.structureHash,
      preimageFingerprint: plan.requestMetadata.preimageFingerprint,
      afterStateFingerprint: plan.requestMetadata.afterStateFingerprint,
      forwardRequestsFingerprint: plan.requestMetadata.forwardRequestsFingerprint,
      rollbackRequestsFingerprint: plan.requestMetadata.rollbackRequestsFingerprint,
      driveVersion,
      literalRangeCount: observed.literalRanges.length,
      literalCellUpperBound: observed.literalCellUpperBound,
      copyOnly: false,
      canonicalWriteAuthorized: true,
    },
  }
}

function recognizeExistingWeeklyRecruitmentTarget(
  sheets: readonly WeeklyRecruitmentSheetDescriptor[],
  predecessor: WeeklyRecruitmentSheetDescriptor,
  cycle: ReturnType<typeof weeklyRecruitmentCycle>
): boolean {
  const collisions = sheets.filter(
    (sheet) => sheet.sheetId === cycle.targetSheetId || sheet.title === cycle.targetSheetTitle
  )
  if (collisions.length === 0) return false
  if (
    collisions.length !== 1 ||
    collisions[0].sheetId !== cycle.targetSheetId ||
    collisions[0].title !== cycle.targetSheetTitle ||
    collisions[0].index !== 0 ||
    predecessor.index !== 1
  ) {
    throw new Error("Weekly Recruitment target identity or rollover ordering is ambiguous.")
  }
  return true
}

function weeklyRecruitmentSheetDescriptors(
  sheets: readonly { properties?: unknown }[] | null | undefined
): WeeklyRecruitmentSheetDescriptor[] {
  return (sheets ?? []).map((sheet) => {
    const properties =
      sheet.properties && typeof sheet.properties === "object" && !Array.isArray(sheet.properties)
        ? sheet.properties as Record<string, unknown>
        : null
    const sheetId = properties?.sheetId
    const title = properties?.title
    const index = properties?.index
    if (
      typeof sheetId !== "number" ||
      !Number.isInteger(sheetId) ||
      sheetId < 0 ||
      typeof title !== "string" ||
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0
    ) {
      throw new Error("Weekly Recruitment discovery returned incomplete sheet metadata.")
    }
    return { sheetId, title, index }
  })
}

function rolloverFailureSummary(
  error: unknown
): WeeklyRecruitmentRolloverFailureSummary | undefined {
  if (!(error instanceof StagingStructuralNormalizationExecutionError)) return undefined
  return {
    artifactKey: "weekly_recruitment",
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
    throw new Error("Weekly Recruitment preflight metadata is not the exact registered canonical spreadsheet.")
  }
  if (metadata.trashed) throw new Error("Registered canonical Weekly Recruitment spreadsheet is trashed.")
  if (metadata.capabilities?.canEdit !== true || metadata.capabilities?.canModifyContent !== true) {
    throw new Error("Approved writer cannot edit the registered canonical Weekly Recruitment spreadsheet.")
  }
}

function safeReason(error: unknown): string {
  return error instanceof StagingStructuralNormalizationExecutionError
    ? "Staging structural normalization failed."
    : "Weekly Recruitment rollover failed."
}
