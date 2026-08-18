import { timingSafeEqual } from "node:crypto"
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"

import { readEnv } from "@/lib/env"
import {
  createEmployeeReferralReportPeriod,
  type EmployeeReferralReport,
} from "@/lib/recruiting-ops/employee-referral-report"
import {
  buildSyntheticEmployeeReferralFixture,
  dueScheduledPeriods,
  EmployeeReferralRunnerError,
  previewEmployeeReferralReport,
  runEmployeeReferralReport,
  sendSyntheticEmployeeReferralTest,
  syncEmployeeReferralMasterSheet,
} from "@/lib/recruiting-ops/employee-referral-report-runner"
import { EmployeeReferralReportStore } from "@/lib/recruiting-ops/employee-referral-report-store"
import { INTERNAL_SERVER_ERROR_MESSAGE, noStoreJson } from "../../ytd/route-utils"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 900

type OperatorAction =
  | "self_test"
  | "preview"
  | "sync_sheet"
  | "send_backfill"
  | "send_month"
  | "prepare_manual_delivery"
  | "send_synthetic_test"
  | "review"
  | "record_manual_delivery"
  | "dismiss_data_drift"
  | "resolve_reconciliation_issue"
  | "send_correction"
  | "resume_correction"

const ACTIONS = new Set<OperatorAction>([
  "self_test",
  "preview",
  "sync_sheet",
  "send_backfill",
  "send_month",
  "prepare_manual_delivery",
  "send_synthetic_test",
  "review",
  "record_manual_delivery",
  "dismiss_data_drift",
  "resolve_reconciliation_issue",
  "send_correction",
  "resume_correction",
])

export async function POST(request: Request) {
  if (readEnv("EMPLOYEE_REFERRAL_REPORT_OPERATOR_MODE") !== "true") {
    return noStoreJson({ error: "Not found" }, { status: 404 })
  }
  if (!isAuthorizedLoopbackRequest(request)) {
    return noStoreJson({ error: "Unauthorized" }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const action = body?.action
  if (typeof action !== "string" || !ACTIONS.has(action as OperatorAction)) {
    return noStoreJson({ error: "Unsupported operator action" }, { status: 400 })
  }

  try {
    const result = await executeAction(action as OperatorAction, body ?? {})
    return noStoreJson(result)
  } catch (error) {
    console.error(
      "[internal/employee-referral-report-operator] Failed; private diagnostics suppressed."
    )
    if (error instanceof EmployeeReferralRunnerError) {
      return noStoreJson(
        { error: INTERNAL_SERVER_ERROR_MESSAGE, code: error.code },
        { status: 409 }
      )
    }
    return noStoreJson({ error: INTERNAL_SERVER_ERROR_MESSAGE }, { status: 500 })
  }
}

async function executeAction(action: OperatorAction, body: Record<string, unknown>) {
  if (action === "self_test") {
    const report = buildSyntheticEmployeeReferralFixture()
    const artifacts = await writePrivateArtifacts(report)
    return { status: "self_test_passed", counts: report.counts, artifacts }
  }
  if (action === "preview") {
    const period = requiredPeriod(body)
    const preview = await previewEmployeeReferralReport(period)
    const artifacts = await writePrivateArtifacts(preview.report)
    return {
      status: "preview_ready",
      period_start_local: period.periodStartLocal,
      period_end_local_exclusive: period.periodEndLocalExclusive,
      counts: preview.report.counts,
      source_set_fingerprint: preview.sourceSetFingerprint,
      payload_fingerprint: preview.payloadFingerprint,
      policy_version: preview.report.policyVersion,
      policy_export_sha256: preview.report.policyExportSha256,
      artifacts,
    }
  }
  if (action === "sync_sheet") {
    return syncEmployeeReferralMasterSheet(requiredPeriod(body))
  }
  if (action === "send_synthetic_test") {
    return sendSyntheticEmployeeReferralTest()
  }
  if (action === "send_backfill") {
    return runEmployeeReferralReport({
      period: createEmployeeReferralReportPeriod("2026-04-01", "2026-07-01"),
      expectedPayloadFingerprint: requiredPayloadFingerprint(
        body.expected_payload_fingerprint
      ),
    })
  }
  if (action === "send_month") {
    const period = requiredPeriod(body)
    const eligible = dueScheduledPeriods(new Date(), readEnv).some(
      (candidate) =>
        candidate.periodStartLocal === period.periodStartLocal &&
        candidate.periodEndLocalExclusive === period.periodEndLocalExclusive
    )
    if (!eligible) {
      throw new EmployeeReferralRunnerError(
        "scheduled_period_not_due",
        "Requested month is not a due scheduled period"
      )
    }
    const state = await new EmployeeReferralReportStore().getPeriodState(
      period.periodStartLocal,
      period.periodEndLocalExclusive
    )
    if (state.runs.length > 0 || state.deliveries.length > 0) {
      throw new EmployeeReferralRunnerError(
        "scheduled_period_already_exists",
        "Missing-month recovery is allowed only when no run or delivery exists"
      )
    }
    return runEmployeeReferralReport({
      period,
      expectedPayloadFingerprint: requiredPayloadFingerprint(
        body.expected_payload_fingerprint
      ),
    })
  }
  if (action === "prepare_manual_delivery") {
    let artifacts: Awaited<ReturnType<typeof writePrivateArtifacts>> | null = null
    try {
      const result = await runEmployeeReferralReport({
        period: createEmployeeReferralReportPeriod("2026-04-01", "2026-07-01"),
        mode: "prepare_manual",
        manualArtifactWriter: async (report) => {
          artifacts = await writePrivateArtifacts(report)
          const directory = artifacts.directory
          return {
            rollback: async () => {
              await rm(directory, { recursive: true, force: true })
              artifacts = null
            },
          }
        },
      })
      return { ...result, artifacts }
    } catch (error) {
      if (
        error instanceof EmployeeReferralRunnerError &&
        error.code === "manual_delivery_commit_unconfirmed" &&
        artifacts
      ) {
        return {
          status: "manual_preparation_unconfirmed",
          code: error.code,
          payload_fingerprint: error.publicDiagnostics.payload_fingerprint,
          manual_preparation_token:
            error.publicDiagnostics.manual_preparation_token,
          artifacts,
        }
      }
      throw error
    }
  }

  const store = new EmployeeReferralReportStore()
  if (action === "review") {
    const period = requiredPeriod(body)
    const state = await store.getPeriodState(
      period.periodStartLocal,
      period.periodEndLocalExclusive
    )
    return sanitizePeriodState(state)
  }
  if (action === "record_manual_delivery") {
    const period = requiredPeriod(body)
    return {
      status: await store.recordManualDelivery({
        periodStartLocal: period.periodStartLocal,
        periodEndLocalExclusive: period.periodEndLocalExclusive,
        revision: requiredPositiveInteger(body.revision, "revision"),
        recipientSlot: requiredSlot(body.recipient_slot),
        deliveredAt: requiredIsoTimestamp(body.delivered_at, "delivered_at"),
        manualEvidenceRef: requiredOpaqueToken(body.manual_evidence_ref, "manual_evidence_ref"),
      }),
    }
  }
  if (action === "dismiss_data_drift") {
    return {
      proposal_id: await store.dismissDataDrift(
        requiredUuid(body.proposal_id, "proposal_id"),
        requiredReason(body.reason)
      ),
      status: "dismissed",
    }
  }
  if (action === "resolve_reconciliation_issue") {
    const period = requiredPeriod(body)
    return {
      issue_code: await store.resolveReconciliationIssue({
        periodStartLocal: period.periodStartLocal,
        periodEndLocalExclusive: period.periodEndLocalExclusive,
        revision: requiredPositiveInteger(body.revision, "revision"),
        issueCode: requiredSafeCode(body.issue_code, "issue_code"),
        reason: requiredReason(body.reason),
      }),
      status: "resolved",
    }
  }
  if (action === "send_correction") {
    const predecessorRevision = requiredPositiveInteger(
      body.predecessor_revision,
      "predecessor_revision"
    )
    return runEmployeeReferralReport({
      period: requiredPeriod(body),
      revision: predecessorRevision + 1,
      supersedesRevision: predecessorRevision,
      correctionReason: requiredReason(body.reason),
      promoteCorrection: true,
      acknowledgePossibleLateDelivery: body.acknowledge_possible_late_delivery === true,
      lateDeliveryReason:
        body.acknowledge_possible_late_delivery === true
          ? requiredReason(body.late_delivery_reason)
          : null,
      expectedPayloadFingerprint: requiredPayloadFingerprint(
        body.expected_payload_fingerprint
      ),
    })
  }
  if (action === "resume_correction") {
    const period = requiredPeriod(body)
    const revision = requiredPositiveInteger(body.revision, "revision")
    if (revision <= 1) throw new Error("Correction revision must be greater than one")
    const state = await store.getPeriodState(
      period.periodStartLocal,
      period.periodEndLocalExclusive
    )
    const run = state.runs.find((candidate) => Number(candidate.revision) === revision)
    if (!run || typeof run.correction_reason !== "string" || !run.correction_reason.trim()) {
      throw new Error("Correction revision is not resumable")
    }
    return runEmployeeReferralReport({
      period,
      revision,
      supersedesRevision: revision - 1,
      correctionReason: run.correction_reason,
    })
  }
  throw new Error("Unsupported operator action")
}

function isAuthorizedLoopbackRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
    return false
  }
  const expected = readEnv("RECOPS_JOB_BEARER_TOKEN")
  const header = request.headers.get("authorization")
  const actual = header?.startsWith("Bearer ") ? header.slice(7) : ""
  if (!expected || !actual) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function writePrivateArtifacts(report: EmployeeReferralReport) {
  const configuredRoot = readEnv("EMPLOYEE_REFERRAL_REPORT_ARTIFACT_ROOT")
  if (!configuredRoot || !isAbsolute(configuredRoot)) {
    throw new Error("A private absolute artifact root is required")
  }
  const artifactToken = requiredArtifactToken(report.publicDiagnostics.correlationId)
  const root = await realpath(configuredRoot)
  const rootStats = await stat(root)
  if (!rootStats.isDirectory()) throw new Error("Artifact root must be a directory")
  const repositoryRoot = resolve(process.cwd())
  if (
    root === repositoryRoot ||
    root.startsWith(`${repositoryRoot}/`) ||
    /(?:Dropbox|Google Drive|OneDrive|iCloud)/i.test(root)
  ) {
    throw new Error("Artifact root must be outside repository and cloud-synced folders")
  }
  const directory = await mkdtemp(join(root, `employee-referral-${artifactToken}-`))
  await chmod(directory, 0o700)
  const stem = `employee-referral-${report.period.periodStartLocal}-to-${report.period.periodEndLocalExclusive}-${artifactToken}`
  const htmlPath = join(directory, `${stem}.html`)
  const csvPath = join(directory, `${stem}.csv`)
  const manifestPath = join(directory, "manifest.json")
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schema_version: 1,
        artifact_token: artifactToken,
        period_start_local: report.period.periodStartLocal,
        period_end_local_exclusive: report.period.periodEndLocalExclusive,
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  )
  await writeFile(htmlPath, report.html, { encoding: "utf8", flag: "wx", mode: 0o600 })
  await writeFile(csvPath, report.csv, { encoding: "utf8", flag: "wx", mode: 0o600 })
  await chmod(manifestPath, 0o600)
  await chmod(htmlPath, 0o600)
  await chmod(csvPath, 0o600)
  return {
    directory,
    manifest_path: manifestPath,
    html_path: htmlPath,
    csv_path: csvPath,
  }
}

function requiredPeriod(body: Record<string, unknown>) {
  if (typeof body.period_start_local !== "string" || typeof body.period_end_local_exclusive !== "string") {
    throw new Error("An explicit period is required")
  }
  return createEmployeeReferralReportPeriod(
    body.period_start_local,
    body.period_end_local_exclusive
  )
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${name} is invalid`)
  return Number(value)
}

function requiredSlot(value: unknown): "ta_lead" | "requesting_manager" {
  if (value !== "ta_lead" && value !== "requesting_manager") {
    throw new Error("recipient_slot is invalid")
  }
  return value
}

function requiredReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1000) {
    throw new Error("A bounded nonblank reason is required")
  }
  return value.trim()
}

function requiredIsoTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} is invalid`)
  }
  return new Date(value).toISOString()
}

function requiredSafeCode(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,64}$/.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requiredOpaqueToken(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:_./-]{0,255}$/.test(value)
  ) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requiredUuid(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requiredArtifactToken(value: unknown): string {
  if (value === "synthetic-self-test") return value
  return requiredUuid(value, "artifact correlation token")
}

function requiredPayloadFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^hmac-sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error("An approved preview payload fingerprint is required")
  }
  return value
}

function sanitizePeriodState(state: Awaited<ReturnType<EmployeeReferralReportStore["getPeriodState"]>>) {
  return {
    status: "review_ready",
    runs: state.runs.map((run) => ({
      revision: run.revision,
      supersedes_revision: run.supersedes_revision,
      status: run.status,
      current_cohort_count: run.current_cohort_count,
      deprecated_review_count: run.deprecated_review_count,
      ungoverned_source_review_count: run.ungoverned_source_review_count,
      total_row_count: run.total_row_count,
      mapping_review_count: run.mapping_review_count,
      policy_version: run.policy_version,
      policy_export_sha256: run.policy_export_sha256,
      source_set_fingerprint: run.source_set_fingerprint,
      payload_fingerprint: run.payload_fingerprint,
      recipient_scope_version: run.recipient_scope_version,
      manual_preparation_token: run.manual_preparation_token,
      delivery_deadline_at: run.delivery_deadline_at,
      deadline_missed_at_creation: run.deadline_missed_at_creation,
      delivered_at: run.delivered_at,
    })),
    deliveries: state.deliveries.map((delivery) => ({
      revision: delivery.revision,
      recipient_slot: delivery.recipient_slot,
      delivery_channel: delivery.delivery_channel,
      status: delivery.status,
      attempt_count: delivery.attempt_count,
      provider_message_id: delivery.provider_message_id,
      provider_last_event: delivery.provider_last_event,
      delivered_at: delivery.delivered_at,
    })),
    proposals: state.proposals.map((proposal) => ({
      proposal_id: proposal.proposal_id,
      predecessor_revision: proposal.predecessor_revision,
      kind: proposal.kind,
      cause_code: proposal.cause_code,
      status: proposal.status,
      detected_at: proposal.detected_at,
      promoted_revision: proposal.promoted_revision,
      satisfied_by_revision: proposal.satisfied_by_revision,
    })),
    issues: state.issues.map((issue) => ({
      revision: issue.revision,
      issue_code: issue.issue_code,
      status: issue.status,
      first_seen_at: issue.first_seen_at,
      last_seen_at: issue.last_seen_at,
    })),
  }
}
