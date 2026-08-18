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
import { evaluateStagingKillSwitchStates } from "./staging-kill-switch"
import {
  planStagingStructuralNormalization,
  type StagingStructuralNormalizationSpec,
} from "./staging-structural-normalization"
import { projectStagingStructuralNormalizationState } from "./staging-structural-normalization-observer"
import {
  stagingStructuralNormalizationFingerprint,
  type StagingStructuralWritePermit,
} from "./staging-structural-write-permit"
import {
  buildWeeklyRecruitmentRowLifecycle,
  type WeeklyRecruitmentRowLifecycleSummary,
} from "./weekly-recruitment-row-lifecycle"
import {
  requireAvailableWeeklyRecruitmentFriday,
  weeklyRecruitmentCycle,
} from "./weekly-recruitment-rollover"

const MAXIMUM_OBSERVED_ROWS = 1_000
const LIFECYCLE_READ_FIELDS = [
  "spreadsheetId",
  "sheets(properties(sheetId,title))",
  "sheets(data(startRow,startColumn,rowData(values(userEnteredValue(stringValue,numberValue,boolValue,formulaValue),userEnteredFormat,dataValidation))))",
].join(",")

export interface WeeklyRecruitmentRowLifecyclePlanSummary
  extends WeeklyRecruitmentRowLifecycleSummary {
  normalizationId: string
  driveVersion: string
  structureFingerprint?: string
  preimageFingerprint?: string
  afterStateFingerprint?: string
  forwardRequestsFingerprint?: string
  rollbackRequestsFingerprint?: string
  literalRangeCount?: number
  literalCellUpperBound?: number
}

export interface WeeklyRecruitmentRowLifecycleFailureSummary {
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

export interface WeeklyRecruitmentRowLifecycleOutcome {
  artifactKey: "weekly_recruitment"
  status: "dry_run" | "already_normalized" | "normalized" | "blocked"
  plan?: WeeklyRecruitmentRowLifecyclePlanSummary
  write?: StagingSheetStructuralWriteSummary
  failure?: WeeklyRecruitmentRowLifecycleFailureSummary
  reason?: string
}

export interface WeeklyRecruitmentRowLifecycleRun {
  runId: string
  mode: "dry_run" | "write"
  reportingWeekFriday: string
  copyOnly: false
  canonicalWriteAuthorized: true
  outcomes: readonly [WeeklyRecruitmentRowLifecycleOutcome]
}

/**
 * Places open roles above the legacy divider, moves every manual cell with its
 * requisition, and repairs unmistakably unformatted platform-appended rows.
 */
export async function runWeeklyRecruitmentRowLifecycle(input: {
  clients: GoogleWorkspaceStagingClients
  reportingWeekFriday: string
  mode?: "dry_run" | "write"
  env?: Readonly<Record<string, string | undefined>>
  nowMs?: number
  currentTimeMs?: () => number
  loadKillSwitchStates?: () => Promise<readonly KillSwitchState[]>
}): Promise<WeeklyRecruitmentRowLifecycleRun> {
  const mode = input.mode ?? "dry_run"
  if (mode !== "dry_run" && mode !== "write") {
    throw new Error("Weekly Recruitment row lifecycle mode must be dry_run or write.")
  }
  const currentTimeMs = input.currentTimeMs ?? Date.now
  const cycleNowMs = input.nowMs ?? currentTimeMs()
  requireAvailableWeeklyRecruitmentFriday(input.reportingWeekFriday, cycleNowMs)
  const runId = `weekly_recruitment_row_lifecycle_${input.reportingWeekFriday.replaceAll("-", "")}_${new Date(cycleNowMs)
    .toISOString()
    .replace(/[^0-9]/g, "")}`

  let outcome: WeeklyRecruitmentRowLifecycleOutcome
  try {
    const prepared = await prepareWeeklyRecruitmentRowLifecycle({
      clients: input.clients,
      reportingWeekFriday: input.reportingWeekFriday,
    })
    if (mode === "dry_run") {
      outcome = {
        artifactKey: "weekly_recruitment",
        status: "dry_run",
        plan: prepared.summary,
      }
    } else if (!prepared.spec || !prepared.plan) {
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
        const permit = createWeeklyRecruitmentRowLifecycleWritePermit({
          spec: prepared.spec,
          expectedStatus: prepared.plan.status,
          structureFingerprint: prepared.summary.structureFingerprint as string,
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
    const failure = lifecycleFailureSummary(error)
    // `safeReason` is a public-safe constant by contract and the stored evidence
    // keeps only a status, so without this the mismatch between the lifecycle's
    // expectations and the real canonical tab exists nowhere at all. The
    // recurring lane already logs its blocks this way; this one did not, which
    // is why a block here could only be diagnosed by reading the sheet by hand.
    console.error(
      "[recruiting-ops-weekly-row-lifecycle] weekly_recruitment blocked:",
      safeDiagnostic(error)
    )
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
    reportingWeekFriday: input.reportingWeekFriday,
    copyOnly: false,
    canonicalWriteAuthorized: true,
    outcomes: [outcome],
  }
}

async function prepareWeeklyRecruitmentRowLifecycle(input: {
  clients: GoogleWorkspaceStagingClients
  reportingWeekFriday: string
}): Promise<{
  summary: WeeklyRecruitmentRowLifecyclePlanSummary
  spec?: StagingStructuralNormalizationSpec
  plan?: ReturnType<typeof planStagingStructuralNormalization>
}> {
  const cycle = weeklyRecruitmentCycle(input.reportingWeekFriday)
  const [spreadsheet, metadata] = await Promise.all([
    readStagingSpreadsheet("weekly_recruitment", input.clients, {
      ranges: [`'${cycle.targetSheetTitle.replaceAll("'", "''")}'!A1:Z${MAXIMUM_OBSERVED_ROWS}`],
      includeGridData: true,
      fields: LIFECYCLE_READ_FIELDS,
    }),
    readStagingDriveMetadata("weekly_recruitment", input.clients),
  ])
  assertEditableCanonicalMetadata(metadata, spreadsheet.spreadsheetId ?? "")
  const driveVersion = String(metadata.version ?? "").trim()
  if (!driveVersion) throw new Error("Copied Weekly Recruitment spreadsheet Drive version is missing.")
  const build = buildWeeklyRecruitmentRowLifecycle({
    spreadsheet,
    reportingWeekFriday: input.reportingWeekFriday,
    dataProvenance: "live",
    maximumRows: MAXIMUM_OBSERVED_ROWS,
  })
  const normalizationId = `weekly_recruitment_row_lifecycle_${input.reportingWeekFriday.replaceAll("-", "")}`
  if (build.status === "already_normalized") {
    return {
      summary: {
        ...build.summary,
        normalizationId,
        driveVersion,
      },
    }
  }

  const observed = await readStagingStructuralNormalizationSnapshot(build.spec, input.clients)
  const state = projectStagingStructuralNormalizationState(observed.spreadsheet, build.spec)
  const plan = planStagingStructuralNormalization(build.spec, state)
  if (plan.status !== "planned") {
    throw new Error("Weekly Recruitment row lifecycle narrow and full snapshots disagree.")
  }
  return {
    spec: build.spec,
    plan,
    summary: {
      ...build.summary,
      normalizationId: build.spec.id,
      driveVersion,
      structureFingerprint: observed.structure.structureHash,
      preimageFingerprint: plan.requestMetadata.preimageFingerprint,
      afterStateFingerprint: plan.requestMetadata.afterStateFingerprint,
      forwardRequestsFingerprint: plan.requestMetadata.forwardRequestsFingerprint,
      rollbackRequestsFingerprint: plan.requestMetadata.rollbackRequestsFingerprint,
      literalRangeCount: observed.literalRanges.length,
      literalCellUpperBound: observed.literalCellUpperBound,
    },
  }
}

function createWeeklyRecruitmentRowLifecycleWritePermit(input: {
  spec: StagingStructuralNormalizationSpec
  expectedStatus: "planned" | "already_normalized"
  structureFingerprint: string
  driveVersion: string
  runId: string
  issuedAtMs: number
}): StagingStructuralWritePermit {
  return {
    artifactKey: "weekly_recruitment",
    artifactId: input.spec.spreadsheetId,
    kind: "google_sheet",
    normalizationId: input.spec.id,
    normalizationFingerprint: stagingStructuralNormalizationFingerprint(input.spec),
    expectedStatus: input.expectedStatus,
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

function lifecycleFailureSummary(
  error: unknown
): WeeklyRecruitmentRowLifecycleFailureSummary | undefined {
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
  if (
    !expectedId ||
    metadata.id !== expectedId ||
    metadata.mimeType !== "application/vnd.google-apps.spreadsheet"
  ) {
    throw new Error("Weekly Recruitment lifecycle metadata is not the exact registered canonical artifact.")
  }
  if (metadata.trashed) throw new Error("Registered canonical Weekly Recruitment spreadsheet is trashed.")
  if (metadata.capabilities?.canEdit !== true || metadata.capabilities?.canModifyContent !== true) {
    throw new Error("Approved writer cannot edit the registered canonical Weekly Recruitment spreadsheet.")
  }
}

function safeReason(error: unknown): string {
  return error instanceof StagingStructuralNormalizationExecutionError
    ? "Staging structural normalization failed."
    : "Weekly Recruitment row lifecycle failed."
}

function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/g, " ").slice(0, 300)
}
