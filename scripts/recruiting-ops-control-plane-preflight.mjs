#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const DEFAULT_GCLOUD = "gcloud"
const DEFAULT_PROJECT = "example-project"
const DEFAULT_REGION = "us-central1"
const DEFAULT_ACCOUNT = "jordan.rivera@example.com"
const PRIVATE_SERVICE = "ta-ops-staging-hydrator"
const PUBLIC_SERVICE = "ta-ops-analytics"
const HYDRATION_JOB = "ta-ops-staging-hydration"
const PRIVATE_ORIGIN = "https://ta-ops-staging-hydrator-000000000000.us-central1.run.app"
const PUBLIC_EXEC_ORIGIN = "https://ref-oidc-e49v5---ta-ops-analytics-abcdefghij-uc.a.run.app"
const HYDRATION_PATH = "/api/cron/recruiting-ops-staging-hydration"
const HYDRATION_SCHEDULER_ACCOUNT =
  "ta-ops-hydration-scheduler@example-project.iam.gserviceaccount.com"
const ACCEPTED_RUNTIME_RELEASE_SHA =
  "1111111111111111111111111111111111111111"
const ACCEPTED_PRIVATE_IMAGE =
  "us-central1-docker.pkg.dev/example-project/recruiting/ta-ops-staging-hydrator@sha256:1111111111111111111111111111111111111111111111111111111111111111"
const ACCEPTED_EXECUTION_FENCE = {
  count: 66,
  latestName: "ta-ops-staging-hydration-aaaaa",
  latestCreated: "2026-07-24T00:00:00.000000Z",
}
export const ACCEPTED_PUBLIC_AUTH_HEADER_SHA256 =
  "2222222222222222222222222222222222222222222222222222222222222222"
const ACCEPTED_LOG_FENCES = {
  failureCutoff: "2026-07-24T00:00:00.000000Z",
  unifiedScheduler: {
    acceptedThrough: "2026-07-21T06:30:39Z",
  },
}
const SCHEDULER_USER_AGENT = "Google-Cloud-Scheduler"
const IMMUTABLE_IMAGE_PATTERN = /^.+@sha256:[0-9a-f]{64}$/
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
const HYDRATION_EXECUTION_PATTERN =
  /^ta-ops-staging-hydration-[a-z0-9]{5}$/
const SAFE_SCHEDULER_LOCATIONS = new Set([
  "asia-east1",
  "asia-east2",
  "asia-northeast1",
  "asia-northeast2",
  "asia-northeast3",
  "asia-south1",
  "asia-southeast1",
  "asia-southeast2",
  "australia-southeast1",
  "europe-central2",
  "europe-west1",
  "europe-west2",
  "europe-west3",
  "europe-west4",
  "europe-west6",
  "me-central1",
  "me-central2",
  "me-west1",
  "northamerica-northeast1",
  "southamerica-east1",
  "us-central1",
  "us-east1",
  "us-east4",
  "us-central1",
  "us-west2",
  "us-west3",
  "us-west4",
])
const SAFE_NON_RUNTIME_MAIN_DIFFS = new Set([
  "scripts/recruiting-ops-control-plane-preflight.mjs",
  "test/fixtures/recruiting-ops-control-plane-accepted-boundaries.json",
  "test/recruiting-ops-control-plane-preflight.test.ts",
])
const SAFE_UNRELATED_SCHEDULER_NAMES = new Set([
  "employee-referral-monthly-report",
  "employee-referral-monthly-watchdog",
  "notify-drain",
  "reconcile-identity",
  "sweep-agency",
  "sweep-referral",
  "ytd-incremental",
])
const DEFAULT_SCHEDULER_RETRY = {
  maxBackoffDuration: "3600s",
  maxDoublings: 5,
  maxRetryDuration: "0s",
  minBackoffDuration: "5s",
}
const SAFE_LABEL_KEYS = new Set([
  "client.knative.dev/nonce",
  "cloud.googleapis.com/location",
  "cron-secret-version",
  "employee-referral-diagnostic",
  "employee-referral-release",
  "recops-scope",
  "run.googleapis.com/lastUpdatedTime",
  "run.googleapis.com/startupProbeType",
  "source-commit",
])
const SAFE_CONTROL_ANNOTATION_KEYS = new Set([
  "autoscaling.knative.dev/maxScale",
  "run.googleapis.com/client-name",
  "run.googleapis.com/client-version",
  "run.googleapis.com/creator",
  "run.googleapis.com/execution-environment",
  "run.googleapis.com/ingress",
  "run.googleapis.com/ingress-status",
  "run.googleapis.com/lastModifier",
  "run.googleapis.com/maxScale",
  "run.googleapis.com/operation-id",
  "run.googleapis.com/startup-cpu-boost",
  "run.googleapis.com/urls",
  "serving.knative.dev/creator",
  "serving.knative.dev/lastModifier",
])
const SAFE_IAM_MEMBERS = new Set([
  "allUsers",
  "serviceAccount:ta-ops-hydration-scheduler@example-project.iam.gserviceaccount.com",
  "serviceAccount:ta-ops-hydrator-run@example-project.iam.gserviceaccount.com",
  "serviceAccount:ta-ops-ref-report-scheduler@example-project.iam.gserviceaccount.com",
  "serviceAccount:ta-ops-ref-watchdog-scheduler@example-project.iam.gserviceaccount.com",
])
const SAFE_IAM_ROLES = new Set([
  "roles/run.invoker",
  "roles/run.jobsExecutorWithOverrides",
])
const SAFE_SERVICE_ACCOUNTS = new Set([
  "ta-ops-analytics-run@example-project.iam.gserviceaccount.com",
  "ta-ops-hydrator-run@example-project.iam.gserviceaccount.com",
])

export const ACCEPTED_BOUNDARIES = {
  privateServiceControlSha256:
    "c125fdd698d2d38f86b5bec9207ef0be3faacf673a5cfd76d358dcdf4ceee422",
  jobControlSha256:
    "ef09eefe0142daa409972d3f7aeb223ed77ba864bd7392a01977e72b803af098",
  privateServiceIamSha256:
    "d7e7eaa216ad839b118372a34cd795a3844bea035687525104626a676e251579",
  jobIamSha256:
    "0ce0fd6c14058008d92328f7ba861bb1d4dc4a9c03cce47c5a24c2140f64887d",
  publicServiceControlSha256:
    "ed799c4897bd2056a064d74989757651a5343482bf1c6e4c276315073f23808f",
  publicServiceIamSha256:
    "c5490e9ae3dd5912b55f01bdeab3cf9593572544eceb3cecbf6b450bb29d7613",
}

const POSTURE_ENV_NAMES = new Set([
  "RECOPS_JOB_MODE",
  "RECOPS_STAGING_HYDRATION_ENABLED",
  "RECOPS_JOB_ARTIFACTS",
  "RECOPS_HYDRATE_ELT_DOC",
  "RECOPS_HYDRATE_WEEKLY_RECRUITMENT",
  "RECOPS_HYDRATE_WEEKLY_PROGRESS",
  "RECOPS_HYDRATE_ALL_HIRES",
  "RECOPS_HYDRATE_PIPELINE_890",
  "RECOPS_HYDRATE_PIPELINE_907",
  "RECOPS_HYDRATE_PIPELINE_1026_1027",
  "RECOPS_HYDRATE_PIPELINE_1118_1119",
  "RECOPS_HYDRATE_FINAL_OFFER",
  "RECOPS_HYDRATE_RPS_TRACKING",
  "RECOPS_HYDRATE_DELIVERY_ROLES_RPS",
])
const SAFE_CONTROL_ENV_NAMES = new Set([
  ...POSTURE_ENV_NAMES,
  "CRON_SECRET",
  "EMPLOYEE_REFERRAL_REPORT_FIRST_SCHEDULED_PERIOD",
  "EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE",
  "EMPLOYEE_REFERRAL_REPORT_OPERATOR_MODE",
  "EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT",
  "EMPLOYEE_REFERRAL_REPORT_SEND_ENABLED",
  "EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT",
  "GREENHOUSE_CLIENT_ID",
  "GREENHOUSE_CLIENT_SECRET",
  "NODE_OPTIONS",
  "RECRUITING_OPS_DASHBOARD_BASIC_PASSWORD",
  "RECRUITING_OPS_DASHBOARD_BASIC_USER",
  "RECOPS_GOOGLE_WRITER_SERVICE_ACCOUNT",
  "RECOPS_EXEC_ENABLED",
  "RECOPS_PII_FINGERPRINT_SALT",
  "RECOPS_STAGING_HYDRATION_JOB_RESOURCE",
  "RECOPS_STAGING_HYDRATION_SCHEDULER_SERVICE_ACCOUNT",
  "RECOPS_STAGING_HYDRATOR_OIDC_AUDIENCE",
  "RECOPS_STAGING_ORCHESTRATION_SCHEDULER_JOB_NAME",
  "RESEND_API_KEY",
  "SLACK_BOT_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
  "EMPLOYEE_REFERRAL_REPORT_RECIPIENT_SCOPE_VERSION",
])
const HASHED_CONTROL_ENV_NAMES = new Set([
  "EMPLOYEE_REFERRAL_REPORT_RECIPIENTS",
  "NOTIFY_EMAIL_FROM",
])

// Per the operator's 2026-08-06 canonical-cutover directive, the steady-state posture
// flipped from dark (dry_run, every flag false) to live: RECOPS_JOB_MODE is
// "write" and every one of these flags is "true". The list of flag names is
// unchanged by the cutover; only the expected value is.
const WRITE_CONTROL_FLAG_NAMES = [
  "RECOPS_STAGING_HYDRATION_ENABLED",
  "RECOPS_HYDRATE_ELT_DOC",
  "RECOPS_HYDRATE_WEEKLY_RECRUITMENT",
  "RECOPS_HYDRATE_WEEKLY_PROGRESS",
  "RECOPS_HYDRATE_ALL_HIRES",
  "RECOPS_HYDRATE_PIPELINE_890",
  "RECOPS_HYDRATE_PIPELINE_907",
  "RECOPS_HYDRATE_PIPELINE_1026_1027",
  "RECOPS_HYDRATE_PIPELINE_1118_1119",
  "RECOPS_HYDRATE_FINAL_OFFER",
  "RECOPS_HYDRATE_RPS_TRACKING",
  "RECOPS_HYDRATE_DELIVERY_ROLES_RPS",
]
// The single unified scheduler that now drives every weekday hydration run.
const UNIFIED_STAGING_SCHEDULER_NAME = "recops-staging-orchestration-weekday"
const KNOWN_ARTIFACTS = new Set([
  "elt_doc",
  "weekly_recruitment",
  "weekly_progress",
  "all_hires",
  "pipeline_890",
  "pipeline_907",
  "pipeline_1026_1027",
  "pipeline_1118_1119",
  "final_offer",
  "rps_tracking",
  "delivery_roles_rps",
])

function privateLegacy(name, schedule, artifact, extraQuery = {}) {
  return {
    name,
    schedule,
    timeZone: "America/Los_Angeles",
    httpMethod: "GET",
    attemptDeadline: "900s",
    retryConfigSha256: sha256(stableJson(DEFAULT_SCHEDULER_RETRY)),
    target: {
      origin: PRIVATE_ORIGIN,
      path: HYDRATION_PATH,
      query: {
        artifact,
        mode: "dry_run",
        ...extraQuery,
      },
      oidcServiceAccountEmail: HYDRATION_SCHEDULER_ACCOUNT,
      oidcAudience: PRIVATE_ORIGIN,
      oauthServiceAccountEmail: null,
      oauthScope: null,
      headerNames: ["User-Agent"],
      bodyLength: 0,
    },
  }
}

export const EXPECTED_GOVERNED_SCHEDULERS = [
  privateLegacy("recops-staging-all-hires", "5 8 * * *", "all_hires"),
  privateLegacy("recops-staging-delivery-rps", "30 23 * * 1-5", "delivery_roles_rps"),
  privateLegacy("recops-staging-elt-doc", "0 13 * * 4", "elt_doc"),
  privateLegacy("recops-staging-final-offer", "0 6 1 * *", "final_offer"),
  {
    name: "recops-staging-orchestration-weekday",
    schedule: "30 6,23 * * 1-5",
    timeZone: "America/Los_Angeles",
    httpMethod: "POST",
    attemptDeadline: "180s",
    retryConfigSha256: sha256(stableJson(DEFAULT_SCHEDULER_RETRY)),
    target: {
      origin: PRIVATE_ORIGIN,
      path: HYDRATION_PATH,
      query: {},
      oidcServiceAccountEmail: HYDRATION_SCHEDULER_ACCOUNT,
      oidcAudience: PRIVATE_ORIGIN,
      oauthServiceAccountEmail: null,
      oauthScope: null,
      headerNames: ["User-Agent"],
      bodyLength: 0,
    },
  },
  privateLegacy(
    "recops-staging-pipeline-1026-1027",
    "40 13 * * 4",
    "pipeline_1026_1027",
  ),
  privateLegacy(
    "recops-staging-pipeline-1118-1119",
    "50 13 * * 4",
    "pipeline_1118_1119",
  ),
  privateLegacy("recops-staging-pipeline-890", "20 13 * * 4", "pipeline_890"),
  privateLegacy("recops-staging-pipeline-907", "30 13 * * 4", "pipeline_907"),
  privateLegacy("recops-staging-rps-tracking", "10 14 * * 4", "rps_tracking"),
  privateLegacy("recops-staging-weekly-progress", "10 13 * * 4", "weekly_progress"),
  privateLegacy(
    "recops-staging-weekly-recruitment",
    "0 14 * * 4",
    "weekly_recruitment",
    { reporting_week_friday: "2026-07-10" },
  ),
  {
    name: "recruiting-ops-exec",
    schedule: "45 * * * *",
    timeZone: "Etc/UTC",
    httpMethod: "GET",
    attemptDeadline: "320s",
    retryConfigSha256: sha256(stableJson(DEFAULT_SCHEDULER_RETRY)),
    target: {
      origin: PUBLIC_EXEC_ORIGIN,
      path: "/api/cron/recruiting-ops-exec",
      query: {},
      oidcServiceAccountEmail: null,
      oidcAudience: null,
      oauthServiceAccountEmail: null,
      oauthScope: null,
      headerNames: ["Authorization", "User-Agent"],
      bodyLength: 0,
    },
  },
].sort((left, right) => left.name.localeCompare(right.name))

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    )
  }
  return value
}

function stableJson(value) {
  return JSON.stringify(stable(value))
}

function basename(resourceName) {
  return typeof resourceName === "string" ? resourceName.split("/").at(-1) : null
}

function safeIsoTimestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value)
    ? value
    : null
}

function safeCommitSha(value) {
  return typeof value === "string" && COMMIT_SHA_PATTERN.test(value)
    ? value
    : null
}

function safeNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

function safeExecutionName(value) {
  const name = basename(value)
  return typeof name === "string" && HYDRATION_EXECUTION_PATTERN.test(name)
    ? name
    : null
}

function safeLabels(labels) {
  const known = Object.entries(labels ?? {})
    .filter(([key]) => SAFE_LABEL_KEYS.has(key))
    .map(([key, value]) => {
      if (key === "source-commit") {
        return [key, COMMIT_SHA_PATTERN.test(String(value ?? "")) ? value : null]
      }
      if (key === "cloud.googleapis.com/location") {
        return [
          key,
          typeof value === "string" &&
          SAFE_SCHEDULER_LOCATIONS.has(value)
            ? value
            : null,
        ]
      }
      return [key, { valuePresent: value != null }]
    })
    .sort(([left], [right]) => left.localeCompare(right))
  const unexpectedCount =
    Object.keys(labels ?? {}).length -
    Object.keys(labels ?? {}).filter((key) => SAFE_LABEL_KEYS.has(key)).length
  return {
    ...Object.fromEntries(known),
    ...(unexpectedCount > 0 ? { $unexpectedLabelCount: unexpectedCount } : {}),
  }
}

export function normalizeEnvironment(entries = []) {
  return [...entries]
    .filter((entry) => entry && typeof entry.name === "string")
    .map((entry) => {
      if (!SAFE_CONTROL_ENV_NAMES.has(entry.name)) return { redacted: true }
      if (POSTURE_ENV_NAMES.has(entry.name)) {
        const value = typeof entry.value === "string" ? entry.value : null
        const valid =
          entry.name === "RECOPS_JOB_MODE"
            ? ["dry_run", "write"].includes(value)
            : entry.name === "RECOPS_JOB_ARTIFACTS"
              ? value
                  ?.split(",")
                  .every(
                    (artifact, index, artifacts) =>
                      KNOWN_ARTIFACTS.has(artifact) &&
                      artifacts.indexOf(artifact) === index,
                  ) === true
              : ["true", "false"].includes(value)
        return {
          name: entry.name,
          ...(valid
            ? { value }
            : {
                redacted: true,
              }),
        }
      }
      const secretRef = entry.valueFrom?.secretKeyRef
      if (secretRef?.name) {
        return {
          name: entry.name,
          secretRefConfigured: true,
        }
      }
      if (typeof entry.value === "string") {
        return {
          name: entry.name,
          redacted: true,
        }
      }
      return { name: entry.name, redacted: true }
    })
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
}

function parseTarget(httpTarget = {}) {
  let parsed = null
  try {
    parsed = new URL(httpTarget.uri)
  } catch {
    // Invalid targets are classified fail-closed without serializing their values.
  }
  const queryEntries = parsed ? [...parsed.searchParams.entries()].sort() : []
  const headers =
    httpTarget.headers && typeof httpTarget.headers === "object"
      ? httpTarget.headers
      : {}
  return {
    valid: parsed !== null,
    credentialsAbsent:
      parsed !== null && parsed.username === "" && parsed.password === "",
    hashEmpty: parsed !== null && parsed.hash === "",
    origin: parsed?.origin ?? null,
    path: parsed?.pathname ?? null,
    queryEntries,
    oidcServiceAccountEmail: httpTarget.oidcToken?.serviceAccountEmail ?? null,
    oidcAudience: httpTarget.oidcToken?.audience ?? null,
    oauthServiceAccountEmail: httpTarget.oauthToken?.serviceAccountEmail ?? null,
    oauthScope: httpTarget.oauthToken?.scope ?? null,
    headers,
    bodyLength:
      typeof httpTarget.body === "number"
        ? httpTarget.body
        : String(httpTarget.body ?? "").length,
  }
}

function schedulerLocation(resourceName) {
  const match = String(resourceName ?? "").match(/\/locations\/([^/]+)\/jobs\//)
  return match?.[1] ?? null
}

function safeSchedulerState(state) {
  return ["PAUSED", "ENABLED", "DISABLED", "UPDATE_FAILED"].includes(state)
    ? state
    : "UNKNOWN"
}

function governedTargetProjection(
  httpTarget,
  expected,
  publicAuthHeaderSha256,
) {
  const target = parseTarget(httpTarget)
  const expectedQuery = Object.entries(expected.query).sort()
  const headerNames = Object.keys(target.headers).sort()
  const expectedHeaderNames = [...expected.headerNames].sort()
  const headerNamesMatch =
    stableJson(headerNames) === stableJson(expectedHeaderNames)
  const headerValuesMatch =
    headerNamesMatch &&
    headerNames.every((name) => {
      if (name === "User-Agent") {
        return target.headers[name] === SCHEDULER_USER_AGENT
      }
      if (name === "Authorization") {
        return (
          sha256(String(target.headers[name] ?? "")) ===
          publicAuthHeaderSha256
        )
      }
      return false
    })
  return {
    validUri: target.valid,
    credentialsAbsent: target.credentialsAbsent,
    hashEmpty: target.hashEmpty,
    originMatches: target.origin === expected.origin,
    pathMatches: target.path === expected.path,
    queryMatches: stableJson(target.queryEntries) === stableJson(expectedQuery),
    oidcIdentityMatches:
      target.oidcServiceAccountEmail === expected.oidcServiceAccountEmail,
    oidcAudienceMatches: target.oidcAudience === expected.oidcAudience,
    oauthIdentityMatches:
      target.oauthServiceAccountEmail === expected.oauthServiceAccountEmail,
    oauthScopeMatches: target.oauthScope === expected.oauthScope,
    headerNamesMatch,
    headerValuesMatch,
    bodyLengthMatches: target.bodyLength === expected.bodyLength,
  }
}

function governedSchedulerProjection(
  scheduler,
  expected,
  publicAuthHeaderSha256,
) {
  const target = governedTargetProjection(
    scheduler.httpTarget,
    expected.target,
    publicAuthHeaderSha256,
  )
  const matches = {
    location: schedulerLocation(scheduler.name) === DEFAULT_REGION,
    schedule: scheduler.schedule === expected.schedule,
    timeZone: scheduler.timeZone === expected.timeZone,
    httpMethod: scheduler.httpTarget?.httpMethod === expected.httpMethod,
    attemptDeadline: scheduler.attemptDeadline === expected.attemptDeadline,
    retryConfig:
      stableJson(scheduler.retryConfig ?? {}) === stableJson(DEFAULT_SCHEDULER_RETRY),
    ...target,
  }
  return {
    name: expected.name,
    state: safeSchedulerState(scheduler.state),
    matches,
  }
}

function classifyUnrelatedSchedulerBoundary(target) {
  const reasons = []
  if (!target.valid || !target.origin || !target.path) reasons.push("invalid_target")
  if (target.origin === PRIVATE_ORIGIN) reasons.push("private_origin")
  if (target.path === HYDRATION_PATH) reasons.push("hydration_route")
  if (String(target.path ?? "").startsWith("/api/cron/recruiting-ops")) {
    reasons.push("recruiting_ops_route")
  }
  if (
    target.oidcServiceAccountEmail === HYDRATION_SCHEDULER_ACCOUNT ||
    target.oauthServiceAccountEmail === HYDRATION_SCHEDULER_ACCOUNT
  ) {
    reasons.push("hydration_identity")
  }
  if (target.oidcAudience === PRIVATE_ORIGIN) reasons.push("private_audience")
  return [...new Set(reasons)].sort()
}

export function normalizeSchedulers(rawSchedulers, options = {}) {
  const raw = Array.isArray(rawSchedulers) ? rawSchedulers : []
  const expectedByName = new Map(
    EXPECTED_GOVERNED_SCHEDULERS.map((scheduler) => [scheduler.name, scheduler]),
  )
  const normalized = raw
    .map((scheduler) => {
      const rawName = basename(scheduler.name)
      const expected = expectedByName.get(rawName)
      if (expected) {
        return governedSchedulerProjection(
          scheduler,
          expected,
          options.publicAuthHeaderSha256 ??
            ACCEPTED_PUBLIC_AUTH_HEADER_SHA256,
        )
      }
      const target = parseTarget(scheduler.httpTarget)
      const safeName = SAFE_UNRELATED_SCHEDULER_NAMES.has(rawName) ? rawName : null
      return {
        name: safeName,
        nameRedacted: safeName === null,
        state: safeSchedulerState(scheduler.state),
        locationMatchesDefault:
          schedulerLocation(scheduler.name) === DEFAULT_REGION,
        target: {
          validUri: target.valid,
          headerCount: Object.keys(target.headers).length,
          bodyLength: target.bodyLength,
          hasOidcIdentity: target.oidcServiceAccountEmail !== null,
          hasOauthIdentity: target.oauthServiceAccountEmail !== null,
        },
        boundaryReasons: classifyUnrelatedSchedulerBoundary(target),
        _rawName: rawName,
      }
    })
    .sort((left, right) =>
      String(left.name ?? left._rawName).localeCompare(
        String(right.name ?? right._rawName),
      ),
    )

  const byName = new Map()
  for (const scheduler of normalized) {
    const rawName = scheduler._rawName ?? scheduler.name
    const bucket = byName.get(rawName) ?? []
    bucket.push(scheduler)
    byName.set(rawName, bucket)
  }

  const expectedNames = new Set(EXPECTED_GOVERNED_SCHEDULERS.map(({ name }) => name))
  const missing = [...expectedNames].filter((name) => !byName.has(name)).sort()
  const duplicates = [...byName.entries()]
    .filter(([name, schedulers]) => expectedNames.has(name) && schedulers.length !== 1)
    .map(([name]) => name)
    .sort()
  const governed = normalized.filter(({ name }) => expectedNames.has(name))
  const unrelated = normalized.filter(
    (scheduler) => !expectedNames.has(scheduler._rawName ?? scheduler.name),
  )
  const unrelatedBoundaryCrossers = unrelated
    .map((scheduler) => ({
      name: scheduler.name,
      nameRedacted: scheduler.nameRedacted,
      reasons: scheduler.boundaryReasons,
    }))
    .filter(({ reasons }) => reasons.length > 0)
  const definitionDrift = governed
    .map((scheduler) => ({
      name: scheduler.name,
      failedFields: Object.entries(scheduler.matches)
        .filter(([, matches]) => !matches)
        .map(([field]) => field)
        .sort(),
    }))
    .filter(({ failedFields }) => failedFields.length > 0)
  const safeUnrelated = unrelated.map((scheduler) => {
    const safe = { ...scheduler }
    delete safe._rawName
    return safe
  })

  return {
    count: normalized.length,
    enabledCount: normalized.filter(({ state }) => state === "ENABLED").length,
    pausedCount: normalized.filter(({ state }) => state === "PAUSED").length,
    catalogSha256: sha256(stableJson([...governed, ...safeUnrelated])),
    governed: {
      expectedCount: EXPECTED_GOVERNED_SCHEDULERS.length,
      observedCount: governed.length,
      catalogSha256: sha256(stableJson(governed)),
      jobs: governed,
      missing,
      duplicates,
      definitionDrift,
    },
    unrelated: {
      count: unrelated.length,
      catalogSha256: sha256(stableJson(safeUnrelated)),
      jobs: safeUnrelated,
      boundaryCrossers: unrelatedBoundaryCrossers,
    },
    checks: {
      exactGovernedSet:
        missing.length === 0 &&
        duplicates.length === 0 &&
        governed.length === EXPECTED_GOVERNED_SCHEDULERS.length,
      governedDefinitionsMatch: definitionDrift.length === 0,
      // Per the operator's 2026-08-06 canonical-cutover directive, the 11 legacy
      // per-artifact schedulers stay PAUSED (superseded), while the single
      // unified scheduler now drives every weekday hydration run.
      legacyPerArtifactSchedulersPaused: governed
        .filter(
          ({ name }) =>
            String(name).startsWith("recops-staging-") &&
            name !== UNIFIED_STAGING_SCHEDULER_NAME,
        )
        .every(({ state }) => state === "PAUSED"),
      unifiedStagingSchedulerEnabled:
        governed.find(({ name }) => name === UNIFIED_STAGING_SCHEDULER_NAME)
          ?.state === "ENABLED",
      governedAllPaused: governed.every(({ state }) => state === "PAUSED"),
      allSchedulersPaused: normalized.every(({ state }) => state === "PAUSED"),
      unrelatedBoundaryClear: unrelatedBoundaryCrossers.length === 0,
    },
  }
}

function normalizeSchedulerAssets(rawAssets) {
  const jobs = (Array.isArray(rawAssets) ? rawAssets : [])
    .map((asset) => {
      const match = String(asset.name ?? "").match(
        /\/locations\/([^/]+)\/jobs\/([^/]+)$/,
      )
      const rawName = match?.[2] ?? null
      const rawLocation = match?.[1] ?? null
      const location =
        typeof rawLocation === "string" &&
        SAFE_SCHEDULER_LOCATIONS.has(rawLocation)
          ? rawLocation
          : null
      return {
        location,
        locationRedacted: rawLocation !== null && location === null,
        name:
          EXPECTED_GOVERNED_SCHEDULERS.some(({ name }) => name === rawName) ||
          SAFE_UNRELATED_SCHEDULER_NAMES.has(rawName)
            ? rawName
            : null,
        nameRedacted:
          rawName !== null &&
          !EXPECTED_GOVERNED_SCHEDULERS.some(({ name }) => name === rawName) &&
          !SAFE_UNRELATED_SCHEDULER_NAMES.has(rawName),
      }
    })
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
  return {
    count: jobs.length,
    locations: [...new Set(jobs.map(({ location }) => location))].sort(),
    catalogSha256: sha256(stableJson(jobs)),
    jobs,
  }
}

function schedulerResourceKey(resourceName) {
  const match = String(resourceName ?? "").match(
    /\/locations\/([^/]+)\/jobs\/([^/]+)$/,
  )
  return match ? `${match[1]}/${match[2]}` : null
}

function schedulerInventoryMatches(rawSchedulers, rawAssets) {
  const schedulerKeys = (Array.isArray(rawSchedulers) ? rawSchedulers : [])
    .map(({ name }) => schedulerResourceKey(name))
    .filter(Boolean)
    .sort()
  const assetKeys = (Array.isArray(rawAssets) ? rawAssets : [])
    .map(({ name }) => schedulerResourceKey(name))
    .filter(Boolean)
    .sort()
  return stableJson(schedulerKeys) === stableJson(assetKeys)
}

function normalizeSchedulerLocations(rawLocations) {
  return (Array.isArray(rawLocations) ? rawLocations : [])
    .map(({ locationId }) =>
      typeof locationId === "string" &&
      SAFE_SCHEDULER_LOCATIONS.has(locationId)
        ? locationId
        : null,
    )
    .filter(Boolean)
    .sort()
}

function normalizeContainer(container = {}, acceptedImage = null) {
  const {
    name,
    image,
    command,
    args,
    env,
    resources,
    ...other
  } = container
  return {
    namePresent: name != null,
    image: image === acceptedImage ? image : null,
    imagePresent: image != null,
    imageMatchesAccepted: image === acceptedImage,
    immutableImage:
      typeof image === "string" && IMMUTABLE_IMAGE_PATTERN.test(image),
    commandCount: Array.isArray(command) ? command.length : 0,
    argsCount: Array.isArray(args) ? args.length : 0,
    env: normalizeEnvironment(env),
    resources: {
      limitsCount: Object.keys(resources?.limits ?? {}).length,
      requestsCount: Object.keys(resources?.requests ?? {}).length,
      otherFieldCount:
        Object.keys(resources ?? {}).length -
        Number(resources?.limits != null) -
        Number(resources?.requests != null),
    },
    otherFieldCount: Object.keys(other).length,
  }
}

function safeAnnotationKeys(annotations = {}) {
  const keys = Object.keys(annotations)
  const known = keys
    .filter((key) => SAFE_CONTROL_ANNOTATION_KEYS.has(key))
    .sort()
  return {
    known,
    unexpectedCount: keys.length - known.length,
  }
}

function safeRevisionName(value, serviceName) {
  if (
    typeof value !== "string" ||
    ![PRIVATE_SERVICE, PUBLIC_SERVICE].includes(serviceName)
  ) {
    return null
  }
  const prefix = `${serviceName}-`
  return (
    value.startsWith(prefix) &&
      /^[a-z0-9-]+$/.test(value)
      ? value
      : null
  )
}

function normalizeService(raw = {}, acceptedImage = null) {
  const template = raw.spec?.template ?? {}
  const spec = template.spec ?? {}
  const { containers = [], ...otherTemplateSpec } = spec
  const rawServiceSpec = { ...(raw.spec ?? {}) }
  const specTraffic = rawServiceSpec.traffic ?? []
  delete rawServiceSpec.template
  delete rawServiceSpec.traffic
  const rawName = basename(raw.metadata?.name)
  const name = [PRIVATE_SERVICE, PUBLIC_SERVICE].includes(rawName)
    ? rawName
    : null
  const latestCreatedRevisionName = safeRevisionName(
    raw.status?.latestCreatedRevisionName,
    name,
  )
  const latestReadyRevisionName = safeRevisionName(
    raw.status?.latestReadyRevisionName,
    name,
  )
  return {
    name,
    generation: safeNonNegativeInteger(raw.metadata?.generation),
    labels: safeLabels(raw.metadata?.labels),
    metadataAnnotations: safeAnnotationKeys(raw.metadata?.annotations),
    latestCreatedReady:
      latestCreatedRevisionName !== null &&
      latestCreatedRevisionName === latestReadyRevisionName,
    traffic: (raw.status?.traffic ?? []).map((entry) => ({
      latestRevision: entry.latestRevision === true,
      percent: Number.isFinite(entry.percent) ? entry.percent : null,
      revisionMatchesLatestReady:
        latestReadyRevisionName !== null &&
        entry.revisionName === raw.status?.latestReadyRevisionName,
      tagPresent: entry.tag != null,
      urlPresent: entry.url != null,
    })),
    specTraffic: specTraffic.map((entry) => ({
      latestRevision: entry.latestRevision === true,
      percent: Number.isFinite(entry.percent) ? entry.percent : null,
      revisionPresent: entry.revisionName != null,
      tagPresent: entry.tag != null,
    })),
    otherServiceSpecFieldCount: Object.keys(rawServiceSpec).length,
    template: {
      labels: safeLabels(template.metadata?.labels),
      annotations: safeAnnotationKeys(template.metadata?.annotations),
      serviceAccountName: SAFE_SERVICE_ACCOUNTS.has(spec.serviceAccountName)
        ? spec.serviceAccountName
        : null,
      timeoutSeconds: spec.timeoutSeconds ?? null,
      otherSpecFieldCount: Object.keys(otherTemplateSpec).length,
      containers: containers.map((container) =>
        normalizeContainer(container, acceptedImage),
      ),
    },
  }
}

function normalizeJob(raw = {}, acceptedImage = null) {
  const template = raw.spec?.template ?? {}
  const taskTemplate = template.spec?.template ?? {}
  const taskSpec = taskTemplate.spec ?? {}
  const { containers: rawContainers = [], ...otherTaskSpec } = taskSpec
  const otherExecutionSpec = { ...(template.spec ?? {}) }
  const taskCount = otherExecutionSpec.taskCount
  const parallelism = otherExecutionSpec.parallelism
  delete otherExecutionSpec.template
  delete otherExecutionSpec.taskCount
  delete otherExecutionSpec.parallelism
  const containers = rawContainers.map((container) =>
    normalizeContainer(container, acceptedImage),
  )
  const environment = containers.flatMap(({ env }) => env)
  const posture = Object.fromEntries(
    environment
      .filter(({ name }) => POSTURE_ENV_NAMES.has(name))
      .map(({ name, value }) => [name, value]),
  )
  const artifacts = String(posture.RECOPS_JOB_ARTIFACTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  const artifactSet = new Set(artifacts)

  return {
    name:
      basename(raw.metadata?.name) === HYDRATION_JOB
        ? HYDRATION_JOB
        : null,
    generation: safeNonNegativeInteger(raw.metadata?.generation),
    labels: safeLabels(raw.metadata?.labels),
    metadataAnnotations: safeAnnotationKeys(raw.metadata?.annotations),
    executionCount: safeNonNegativeInteger(raw.status?.executionCount),
    latestCreatedExecution: raw.status?.latestCreatedExecution
      ? {
          name: safeExecutionName(raw.status.latestCreatedExecution.name),
          creationTimestamp: safeIsoTimestamp(
            raw.status.latestCreatedExecution.creationTimestamp,
          ),
          completionTimestamp: safeIsoTimestamp(
            raw.status.latestCreatedExecution.completionTimestamp,
          ),
          completionStatus: [
            "EXECUTION_SUCCEEDED",
            "EXECUTION_FAILED",
            "EXECUTION_CANCELLED",
          ].includes(raw.status.latestCreatedExecution.completionStatus)
            ? raw.status.latestCreatedExecution.completionStatus
            : null,
        }
      : null,
    template: {
      labels: safeLabels(template.metadata?.labels),
      annotations: safeAnnotationKeys(template.metadata?.annotations),
      taskCount: taskCount ?? null,
      parallelism: parallelism ?? null,
      otherExecutionSpecFieldCount: Object.keys(otherExecutionSpec).length,
      maxRetries: taskSpec.maxRetries ?? null,
      timeoutSeconds: taskSpec.timeoutSeconds ?? null,
      serviceAccountName: SAFE_SERVICE_ACCOUNTS.has(taskSpec.serviceAccountName)
        ? taskSpec.serviceAccountName
        : null,
      otherTaskSpecFieldCount: Object.keys(otherTaskSpec).length,
      containers,
    },
    posture,
    checks: {
      writeLive: posture.RECOPS_JOB_MODE === "write",
      allWriteFlagsTrue: WRITE_CONTROL_FLAG_NAMES.every((name) => posture[name] === "true"),
      artifactAllowlistComplete:
        artifacts.length === KNOWN_ARTIFACTS.size &&
        artifactSet.size === KNOWN_ARTIFACTS.size &&
        [...KNOWN_ARTIFACTS].every((artifact) => artifactSet.has(artifact)),
    },
  }
}

function normalizeIam(raw = {}) {
  const version = safeNonNegativeInteger(raw.version)
  const bindings = (raw.bindings ?? [])
    .map((binding) => ({
      role: SAFE_IAM_ROLES.has(binding.role)
        ? binding.role
        : { redacted: true },
      members: [...(binding.members ?? [])]
        .map((member) =>
          SAFE_IAM_MEMBERS.has(member)
            ? member
            : { redacted: true },
        )
        .sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
      conditionPresent: binding.condition != null,
    }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
  return {
    etagPresent: raw.etag != null,
    version,
    bindings,
    sha256: sha256(stableJson({ bindings, version })),
  }
}

function canonicalizeReleaseLabels(labels = {}) {
  const normalized = {}
  let unexpectedCount = 0
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (!SAFE_LABEL_KEYS.has(key)) {
      unexpectedCount += 1
      continue
    }
    normalized[key] =
      key === "client.knative.dev/nonce"
        ? "$DEPLOY_NONCE"
        : key === "source-commit"
          ? "$RUNTIME_RELEASE_SHA"
          : key === "run.googleapis.com/lastUpdatedTime"
            ? "$LAST_UPDATED_TIME"
            : value
  }
  if (unexpectedCount > 0) normalized.$unexpectedLabelCount = unexpectedCount
  return normalized
}

function canonicalizeAnnotations(annotations = {}) {
  const normalized = {}
  let unexpectedCount = 0
  for (const [key, value] of Object.entries(annotations ?? {})) {
    if (!SAFE_CONTROL_ANNOTATION_KEYS.has(key)) {
      unexpectedCount += 1
      continue
    }
    normalized[key] =
      key === "run.googleapis.com/operation-id"
        ? "$OPERATION_ID"
        : [
              "run.googleapis.com/creator",
              "run.googleapis.com/lastModifier",
              "serving.knative.dev/creator",
              "serving.knative.dev/lastModifier",
            ].includes(key)
          ? value === DEFAULT_ACCOUNT
            ? "$APPROVED_OPERATOR"
            : "$UNAPPROVED_OPERATOR"
          : value
  }
  if (unexpectedCount > 0) {
    normalized.$unexpectedAnnotationCount = unexpectedCount
  }
  return normalized
}

function canonicalizeEnvironmentBoundary(env) {
  return (Array.isArray(env) ? env : [])
    .map((entry) => {
      if (HASHED_CONTROL_ENV_NAMES.has(entry?.name)) {
        return {
          name: entry.name,
          valueSha256: sha256(
            typeof entry.value === "string"
              ? entry.value
              : stableJson(entry.valueFrom ?? null),
          ),
        }
      }
      if (!SAFE_CONTROL_ENV_NAMES.has(entry?.name)) return { unexpected: true }
      return structuredClone(entry)
    })
    .sort((left, right) =>
      String(left.name ?? "").localeCompare(String(right.name ?? "")),
    )
}

function canonicalizeContainerImages(node, privateRuntime) {
  if (Array.isArray(node)) {
    return node.map((value) =>
      canonicalizeContainerImages(value, privateRuntime),
    )
  }
  if (!node || typeof node !== "object") return node
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => {
      if (key === "image" && privateRuntime) {
        return [key, "$APPROVED_PRIVATE_IMAGE"]
      }
      if (key === "labels") {
        return [key, canonicalizeReleaseLabels(value)]
      }
      if (key === "annotations") {
        return [key, canonicalizeAnnotations(value)]
      }
      if (key === "env") {
        return [key, canonicalizeEnvironmentBoundary(value)]
      }
      return [key, canonicalizeContainerImages(value, privateRuntime)]
    }),
  )
}

function serviceTrafficBoundary(status = {}) {
  const latestCreated = status.latestCreatedRevisionName ?? null
  const latestReady = status.latestReadyRevisionName ?? null
  return {
    latestCreatedReady:
      latestCreated !== null && latestCreated === latestReady,
    traffic: (Array.isArray(status.traffic) ? status.traffic : []).map(
      (entry) => ({
        latestRevision: entry.latestRevision ?? null,
        percent: entry.percent ?? null,
        revision:
          entry.revisionName === latestReady
            ? "$LATEST_READY_REVISION"
            : entry.revisionName == null
              ? null
              : "$OTHER_REVISION",
        tag: entry.tag ?? null,
        url: entry.url ?? null,
      }),
    ),
  }
}

function controlBoundary(raw, { privateRuntime = false } = {}) {
  const boundary = {
    apiVersion: raw?.apiVersion ?? null,
    kind: raw?.kind ?? null,
    metadata: {
      name: raw?.metadata?.name ?? null,
      namespace: raw?.metadata?.namespace ?? null,
      labels: raw?.metadata?.labels ?? {},
      annotations: raw?.metadata?.annotations ?? {},
    },
    spec: raw?.spec ?? {},
    ...(raw?.kind === "Service"
      ? { statusTraffic: serviceTrafficBoundary(raw?.status) }
      : {}),
  }
  return canonicalizeContainerImages(boundary, privateRuntime)
}

function iamBoundary(raw) {
  const normalized = normalizeIam(raw)
  return {
    version: normalized.version,
    bindings: normalized.bindings,
  }
}

export function buildBoundaryFixture(results) {
  return {
    privateServiceControl: controlBoundary(results.privateService, {
      privateRuntime: true,
    }),
    jobControl: controlBoundary(results.job, { privateRuntime: true }),
    privateServiceIam: iamBoundary(results.privateServiceIam),
    jobIam: iamBoundary(results.jobIam),
    publicServiceControl: controlBoundary(results.publicService),
    publicServiceIam: iamBoundary(results.publicServiceIam),
  }
}

export function fingerprintBoundaryFixture(fixture) {
  return {
    privateServiceControlSha256: sha256(
      stableJson(fixture.privateServiceControl),
    ),
    jobControlSha256: sha256(stableJson(fixture.jobControl)),
    privateServiceIamSha256: sha256(stableJson(fixture.privateServiceIam)),
    jobIamSha256: sha256(stableJson(fixture.jobIam)),
    publicServiceControlSha256: sha256(
      stableJson(fixture.publicServiceControl),
    ),
    publicServiceIamSha256: sha256(stableJson(fixture.publicServiceIam)),
  }
}

export function deriveBoundaryFingerprints(results) {
  return fingerprintBoundaryFixture(buildBoundaryFixture(results))
}

function normalizeExecutions(rawExecutions) {
  const executions = (Array.isArray(rawExecutions) ? rawExecutions : [])
    .map((execution) => ({
      name: safeExecutionName(execution.metadata?.name),
      nameRedacted:
        execution.metadata?.name != null &&
        safeExecutionName(execution.metadata?.name) === null,
      created: safeIsoTimestamp(execution.metadata?.creationTimestamp),
      completed: safeIsoTimestamp(execution.status?.completionTime),
      failedCount: safeNonNegativeInteger(execution.status?.failedCount),
      succeededCount: safeNonNegativeInteger(execution.status?.succeededCount),
      cancelledCount: safeNonNegativeInteger(
        execution.status?.cancelledCount,
      ),
      runningCount: safeNonNegativeInteger(execution.status?.runningCount),
      conditionCount: Array.isArray(execution.status?.conditions)
        ? execution.status.conditions.length
        : 0,
    }))
    .sort((left, right) => String(right.created).localeCompare(String(left.created)))
  return {
    count: executions.length,
    catalogSha256: sha256(stableJson(executions)),
    latest: executions[0] ?? null,
    active: executions.filter(({ completed }) => completed === null),
    entries: executions,
  }
}

function safeLogScalar(value) {
  if (value === null || value === undefined) return null
  return {
    redacted: true,
    valueType: Array.isArray(value) ? "array" : typeof value,
  }
}

function normalizeLogs(rawLogs) {
  const logs = (Array.isArray(rawLogs) ? rawLogs : [])
    .map((entry) => ({
      timestamp: safeIsoTimestamp(entry.timestamp),
      severity: [
        "DEFAULT",
        "DEBUG",
        "INFO",
        "NOTICE",
        "WARNING",
        "ERROR",
        "CRITICAL",
        "ALERT",
        "EMERGENCY",
      ].includes(entry.severity)
        ? entry.severity
        : null,
      resourceLabels: safeLabels(entry.resource?.labels),
      labels: safeLabels(entry.labels),
      httpStatus: safeNonNegativeInteger(entry.httpRequest?.status),
      event: safeLogScalar(entry.jsonPayload?.event),
      status: safeLogScalar(entry.jsonPayload?.status),
      result: safeLogScalar(entry.jsonPayload?.result),
      errorCode: safeLogScalar(
        entry.jsonPayload?.errorCode ?? entry.jsonPayload?.error_code,
      ),
      runId: safeLogScalar(entry.jsonPayload?.runId ?? entry.jsonPayload?.run_id),
      attemptId: safeLogScalar(
        entry.jsonPayload?.attemptId ?? entry.jsonPayload?.attempt_id,
      ),
      sourceExecutionId: safeLogScalar(
        entry.jsonPayload?.sourceExecutionId ?? entry.jsonPayload?.source_execution_id,
      ),
    }))
    .sort((left, right) => {
      const byTimestamp = String(right.timestamp).localeCompare(String(left.timestamp))
      return byTimestamp || stableJson(left).localeCompare(stableJson(right))
    })
  return {
    count: logs.length,
    catalogSha256: sha256(stableJson(logs)),
    latestTimestamp: logs[0]?.timestamp ?? null,
    entries: logs,
  }
}

const EXECUTION_FORMAT = [
  "metadata.name",
  "metadata.creationTimestamp",
  "status.completionTime",
  "status.failedCount",
  "status.succeededCount",
  "status.cancelledCount",
  "status.runningCount",
  "status.conditions",
].join(",")

const LOG_FORMAT = [
  "timestamp",
  "severity",
  "resource.labels",
  "labels",
  "httpRequest.status",
  "jsonPayload.event",
  "jsonPayload.status",
  "jsonPayload.result",
  "jsonPayload.errorCode",
  "jsonPayload.error_code",
  "jsonPayload.runId",
  "jsonPayload.run_id",
  "jsonPayload.attemptId",
  "jsonPayload.attempt_id",
  "jsonPayload.sourceExecutionId",
  "jsonPayload.source_execution_id",
].join(",")

export function buildCommandSpecs(options = {}) {
  const gcloud = options.gcloud ?? DEFAULT_GCLOUD
  const project = options.project ?? DEFAULT_PROJECT
  const region = options.region ?? DEFAULT_REGION
  const json = (fields) => `json(${fields})`
  const common = ["--project", project, "--region", region]
  const logQuery = (resourceType, resourceNameLabel, resourceName) =>
    `resource.type="${resourceType}" AND resource.labels.${resourceNameLabel}="${resourceName}"`

  return [
    {
      id: "activeAccount",
      command: gcloud,
      args: ["config", "get-value", "account"],
      parse: "text",
    },
    {
      id: "authProbe",
      command: gcloud,
      args: ["auth", "print-access-token"],
      parse: "discard",
    },
    {
      id: "remoteMain",
      command: "git",
      args: ["ls-remote", "origin", "refs/heads/main"],
      parse: "text",
    },
    {
      id: "localHead",
      command: "git",
      args: ["rev-parse", "HEAD"],
      parse: "text",
    },
    {
      id: "localStatus",
      command: "git",
      args: ["status", "--porcelain"],
      parse: "text",
    },
    {
      id: "runtimeDiff",
      command: "git",
      args: [
        "diff",
        "--name-only",
        `${ACCEPTED_RUNTIME_RELEASE_SHA}..HEAD`,
      ],
      parse: "text",
    },
    {
      id: "privateService",
      command: gcloud,
      args: [
        "run",
        "services",
        "describe",
        PRIVATE_SERVICE,
        ...common,
        "--format=json",
      ],
      parse: "json",
    },
    {
      id: "privateServiceIam",
      command: gcloud,
      args: [
        "run",
        "services",
        "get-iam-policy",
        PRIVATE_SERVICE,
        ...common,
        "--format=json(bindings,etag,version)",
      ],
      parse: "json",
    },
    {
      id: "publicService",
      command: gcloud,
      args: [
        "run",
        "services",
        "describe",
        PUBLIC_SERVICE,
        ...common,
        "--format=json",
      ],
      parse: "json",
    },
    {
      id: "publicServiceIam",
      command: gcloud,
      args: [
        "run",
        "services",
        "get-iam-policy",
        PUBLIC_SERVICE,
        ...common,
        "--format=json(bindings,etag,version)",
      ],
      parse: "json",
    },
    {
      id: "job",
      command: gcloud,
      args: [
        "run",
        "jobs",
        "describe",
        HYDRATION_JOB,
        ...common,
        "--format=json",
      ],
      parse: "json",
    },
    {
      id: "jobIam",
      command: gcloud,
      args: [
        "run",
        "jobs",
        "get-iam-policy",
        HYDRATION_JOB,
        ...common,
        "--format=json(bindings,etag,version)",
      ],
      parse: "json",
    },
    {
      id: "schedulerAssets",
      command: gcloud,
      args: [
        "asset",
        "list",
        `--project=${project}`,
        "--asset-types=cloudscheduler.googleapis.com/Job",
        "--format=json(name,assetType)",
      ],
      parse: "json",
    },
    {
      id: "schedulerLocations",
      command: gcloud,
      args: [
        "scheduler",
        "locations",
        "list",
        "--project",
        project,
        "--format=json(locationId)",
      ],
      parse: "json",
    },
    {
      id: "executions",
      command: gcloud,
      args: [
        "run",
        "jobs",
        "executions",
        "list",
        "--job",
        HYDRATION_JOB,
        ...common,
        "--sort-by=~metadata.creationTimestamp",
        "--limit=unlimited",
        `--format=${json(EXECUTION_FORMAT)}`,
      ],
      parse: "json",
    },
    {
      id: "jobLogs",
      command: gcloud,
      args: [
        "logging",
        "read",
        logQuery("cloud_run_job", "job_name", HYDRATION_JOB),
        "--project",
        project,
        "--freshness=72h",
        "--limit=200",
        `--format=${json(LOG_FORMAT)}`,
      ],
      parse: "json",
    },
    {
      id: "privateServiceLogs",
      command: gcloud,
      args: [
        "logging",
        "read",
        logQuery("cloud_run_revision", "service_name", PRIVATE_SERVICE),
        "--project",
        project,
        "--freshness=72h",
        "--limit=200",
        `--format=${json(LOG_FORMAT)}`,
      ],
      parse: "json",
    },
    {
      id: "unifiedSchedulerLogs",
      command: gcloud,
      args: [
        "logging",
        "read",
        logQuery(
          "cloud_scheduler_job",
          "job_id",
          "recops-staging-orchestration-weekday",
        ),
        "--project",
        project,
        "--freshness=72h",
        "--limit=200",
        `--format=${json(LOG_FORMAT)}`,
      ],
      parse: "json",
    },
  ]
}

export function schedulerListSpec(options = {}, location) {
  return {
    id: `schedulers:${location}`,
    command: options.gcloud ?? DEFAULT_GCLOUD,
    args: [
      "scheduler",
      "jobs",
      "list",
      "--project",
      options.project ?? DEFAULT_PROJECT,
      "--location",
      location,
      "--format=json",
    ],
    parse: "json",
  }
}

function defaultRunner(spec, cwd) {
  const result = spawnSync(spec.command, spec.args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", spec.parse === "discard" ? "ignore" : "pipe", "pipe"],
  })
  return {
    status: result.status ?? 1,
    stdout: spec.parse === "discard" ? "" : (result.stdout ?? ""),
  }
}

export function collectInputs(options = {}, runner = defaultRunner) {
  const results = {}
  const failures = []
  const specs = buildCommandSpecs(options)
  for (const spec of specs) {
    const result = runner(spec, options.cwd ?? process.cwd())
    if (result.status !== 0) {
      failures.push({ id: spec.id, exitCode: result.status })
      continue
    }
    if (spec.parse === "discard") {
      results[spec.id] = true
      continue
    }
    if (spec.parse === "text") {
      results[spec.id] = String(result.stdout ?? "").trim()
      continue
    }
    try {
      results[spec.id] = JSON.parse(String(result.stdout ?? ""))
    } catch {
      failures.push({ id: spec.id, parseError: true })
    }
  }
  const rawSchedulerLocations = Array.isArray(results.schedulerLocations)
    ? results.schedulerLocations
    : []
  const schedulerLocations = normalizeSchedulerLocations(rawSchedulerLocations)
  if (schedulerLocations.length !== rawSchedulerLocations.length) {
    failures.push({
      id: "schedulerLocations",
      invalidLocationCount:
        rawSchedulerLocations.length - schedulerLocations.length,
    })
  }
  results.schedulerLocations = schedulerLocations.map((locationId) => ({
    locationId,
  }))
  const schedulerSpecs = schedulerLocations.map((location) =>
    schedulerListSpec(options, location),
  )
  const schedulers = []
  for (const spec of schedulerSpecs) {
    const result = runner(spec, options.cwd ?? process.cwd())
    if (result.status !== 0) {
      failures.push({ id: spec.id, exitCode: result.status })
      continue
    }
    try {
      const regional = JSON.parse(String(result.stdout ?? ""))
      if (!Array.isArray(regional)) throw new Error("not an array")
      schedulers.push(...regional)
    } catch {
      failures.push({ id: spec.id, parseError: true })
    }
  }
  results.schedulers = schedulers
  return {
    results,
    failures,
    attempted: [
      ...specs.map(({ id }) => id),
      ...schedulerSpecs.map(({ id }) => id),
    ],
  }
}

function sourceCommit(component) {
  return component?.labels?.["source-commit"] ?? null
}

function templateSourceCommit(component) {
  return component?.template?.labels?.["source-commit"] ?? null
}

function image(component) {
  return component?.template?.containers?.[0]?.image ?? null
}

function nonRuntimeDiffIsSafe(paths) {
  return paths.every(
    (path) =>
      path.startsWith("docs/") || SAFE_NON_RUNTIME_MAIN_DIFFS.has(path),
  )
}

function check(id, ok, evidence) {
  return { id, ok: Boolean(ok), evidence }
}

function privateTrafficIsReady(service) {
  const [traffic] = service.traffic
  return (
    service.latestCreatedReady === true &&
    service.traffic.length === 1 &&
    traffic?.percent === 100 &&
    traffic?.revisionMatchesLatestReady === true
  )
}

function newLogEntries(logs, acceptedThrough) {
  const acceptedThroughMs = Date.parse(acceptedThrough)
  if (!Number.isFinite(acceptedThroughMs)) return logs.entries
  return logs.entries.filter((entry) => {
    const timestampMs = Date.parse(entry.timestamp ?? "")
    return !Number.isFinite(timestampMs) || timestampMs > acceptedThroughMs
  })
}

function newLogFailures(logs, cutoff) {
  const cutoffMs = Date.parse(cutoff)
  if (!Number.isFinite(cutoffMs)) return logs.entries
  return logs.entries.filter((entry) => {
    const timestampMs = Date.parse(entry.timestamp ?? "")
    const failureLike =
      ["WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"].includes(
        entry.severity,
      ) || (entry.httpStatus ?? 0) >= 400
    return (
      failureLike &&
      (!Number.isFinite(timestampMs) || timestampMs > cutoffMs)
    )
  })
}

export function buildSnapshot(inputs, options = {}) {
  const expectedAccount = options.expectedAccount ?? DEFAULT_ACCOUNT
  const acceptedRuntimeReleaseSha =
    options.acceptedRuntimeReleaseSha ?? ACCEPTED_RUNTIME_RELEASE_SHA
  const acceptedPrivateImage =
    options.acceptedPrivateImage ?? ACCEPTED_PRIVATE_IMAGE
  const acceptedExecutionFence =
    options.acceptedExecutionFence ?? ACCEPTED_EXECUTION_FENCE
  const acceptedLogFences = options.acceptedLogFences ?? ACCEPTED_LOG_FENCES
  const remoteMainSha = safeCommitSha(
    String(inputs.results.remoteMain ?? "").split(/\s+/)[0],
  )
  const rawActiveAccount = inputs.results.activeAccount ?? null
  const activeAccount =
    rawActiveAccount === expectedAccount ? expectedAccount : "MISMATCH"
  const localHead = safeCommitSha(inputs.results.localHead)
  const privateService = normalizeService(
    inputs.results.privateService,
    acceptedPrivateImage,
  )
  const publicService = normalizeService(inputs.results.publicService)
  const job = normalizeJob(inputs.results.job, acceptedPrivateImage)
  const schedulers = normalizeSchedulers(inputs.results.schedulers, options)
  const schedulerAssets = normalizeSchedulerAssets(inputs.results.schedulerAssets)
  const schedulerLocations = normalizeSchedulerLocations(
    inputs.results.schedulerLocations,
  )
  const privateServiceIam = normalizeIam(inputs.results.privateServiceIam)
  const publicServiceIam = normalizeIam(inputs.results.publicServiceIam)
  const jobIam = normalizeIam(inputs.results.jobIam)
  const executions = normalizeExecutions(inputs.results.executions)
  const acceptedBoundaries = options.acceptedBoundaries ?? ACCEPTED_BOUNDARIES
  const rawObservedBoundaries = deriveBoundaryFingerprints(inputs.results)
  const observedBoundaries = Object.fromEntries(
    Object.entries(rawObservedBoundaries).map(([name, value]) => [
      name,
      value === acceptedBoundaries[name] ? value : "MISMATCH",
    ]),
  )
  const logs = {
    job: normalizeLogs(inputs.results.jobLogs),
    privateService: normalizeLogs(inputs.results.privateServiceLogs),
    unifiedScheduler: normalizeLogs(inputs.results.unifiedSchedulerLogs),
  }
  const localDirtyCount = String(inputs.results.localStatus ?? "")
    .split("\n")
    .filter(Boolean).length
  const runtimeDiff = String(inputs.results.runtimeDiff ?? "")
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean)

  const checks = [
    check("collection_complete", inputs.failures.length === 0, {
      failedCommands: inputs.failures.map(({ id }) => id),
    }),
    check("authorized_account", rawActiveAccount === expectedAccount && inputs.results.authProbe, {
      expectedAccount,
      activeAccount,
    }),
    check("clean_protected_main_checkout", localHead === remoteMainSha && localDirtyCount === 0, {
      remoteMainSha,
      localHead,
      localDirtyCount,
    }),
    check(
      "approved_runtime_release_provenance",
      IMMUTABLE_IMAGE_PATTERN.test(acceptedPrivateImage) &&
        image(privateService) === acceptedPrivateImage &&
        image(job) === acceptedPrivateImage &&
        sourceCommit(privateService) === acceptedRuntimeReleaseSha &&
        templateSourceCommit(privateService) === acceptedRuntimeReleaseSha &&
        sourceCommit(job) === acceptedRuntimeReleaseSha &&
        templateSourceCommit(job) === acceptedRuntimeReleaseSha &&
        nonRuntimeDiffIsSafe(runtimeDiff),
      {
        acceptedReleaseSha: acceptedRuntimeReleaseSha,
        runtimeDiffCount: runtimeDiff.length,
        nonRuntimeDiffSafe: nonRuntimeDiffIsSafe(runtimeDiff),
        privateServiceImage: image(privateService),
        jobImage: image(job),
        privateServiceSource: sourceCommit(privateService),
        privateServiceTemplateSource: templateSourceCommit(privateService),
        jobSource: sourceCommit(job),
        jobTemplateSource: templateSourceCommit(job),
      },
    ),
    check("private_service_traffic_ready", privateTrafficIsReady(privateService), {
      latestCreatedReady: privateService.latestCreatedReady,
      traffic: privateService.traffic,
    }),
    check(
      "private_service_control_unchanged",
      rawObservedBoundaries.privateServiceControlSha256 ===
        acceptedBoundaries.privateServiceControlSha256,
      {
        expectedSha256: acceptedBoundaries.privateServiceControlSha256,
        matches:
          rawObservedBoundaries.privateServiceControlSha256 ===
          acceptedBoundaries.privateServiceControlSha256,
      },
    ),
    check(
      "job_control_unchanged",
      rawObservedBoundaries.jobControlSha256 ===
        acceptedBoundaries.jobControlSha256,
      {
        expectedSha256: acceptedBoundaries.jobControlSha256,
        matches:
          rawObservedBoundaries.jobControlSha256 ===
          acceptedBoundaries.jobControlSha256,
      },
    ),
    check(
      "private_service_iam_unchanged",
      observedBoundaries.privateServiceIamSha256 ===
        acceptedBoundaries.privateServiceIamSha256,
      {
        expectedSha256: acceptedBoundaries.privateServiceIamSha256,
        matches:
          rawObservedBoundaries.privateServiceIamSha256 ===
          acceptedBoundaries.privateServiceIamSha256,
      },
    ),
    check(
      "job_iam_unchanged",
      observedBoundaries.jobIamSha256 === acceptedBoundaries.jobIamSha256,
      {
        expectedSha256: acceptedBoundaries.jobIamSha256,
        matches:
          rawObservedBoundaries.jobIamSha256 === acceptedBoundaries.jobIamSha256,
      },
    ),
    check(
      "public_service_unchanged",
      rawObservedBoundaries.publicServiceControlSha256 ===
        acceptedBoundaries.publicServiceControlSha256,
      {
        expectedSha256: acceptedBoundaries.publicServiceControlSha256,
        matches:
          rawObservedBoundaries.publicServiceControlSha256 ===
          acceptedBoundaries.publicServiceControlSha256,
      },
    ),
    check(
      "public_service_iam_unchanged",
      observedBoundaries.publicServiceIamSha256 ===
        acceptedBoundaries.publicServiceIamSha256,
      {
        expectedSha256: acceptedBoundaries.publicServiceIamSha256,
        matches:
          rawObservedBoundaries.publicServiceIamSha256 ===
          acceptedBoundaries.publicServiceIamSha256,
      },
    ),
    check("job_live", job.checks.writeLive && job.checks.allWriteFlagsTrue, job.checks),
    check(
      "artifact_allowlist_complete",
      job.checks.artifactAllowlistComplete,
      job.checks,
    ),
    check(
      "hydration_execution_fence_unchanged",
      job.executionCount === acceptedExecutionFence.count &&
        (job.latestCreatedExecution?.name ?? null) ===
          acceptedExecutionFence.latestName &&
        (job.latestCreatedExecution?.creationTimestamp ?? null) ===
          acceptedExecutionFence.latestCreated &&
        executions.count === acceptedExecutionFence.count &&
        (executions.latest?.name ?? null) ===
          acceptedExecutionFence.latestName &&
        (executions.latest?.created ?? null) ===
          acceptedExecutionFence.latestCreated,
      {
        accepted: acceptedExecutionFence,
        observed: {
          jobExecutionCount: job.executionCount,
          jobLatestName: job.latestCreatedExecution?.name ?? null,
          jobLatestCreated:
            job.latestCreatedExecution?.creationTimestamp ?? null,
          listedExecutionCount: executions.count,
          listedLatestName: executions.latest?.name ?? null,
          listedLatestCreated: executions.latest?.created ?? null,
        },
      },
    ),
    check("no_active_hydration_execution", executions.active.length === 0, {
      active: executions.active.map(({ name, created, runningCount }) => ({
        name,
        created,
        runningCount,
      })),
    }),
    check(
      "no_new_unified_scheduler_logs",
      newLogEntries(
        logs.unifiedScheduler,
        acceptedLogFences.unifiedScheduler.acceptedThrough,
      ).length === 0,
      {
        expected: acceptedLogFences.unifiedScheduler,
        observed: {
          count: logs.unifiedScheduler.count,
          catalogSha256: logs.unifiedScheduler.catalogSha256,
          latestTimestamp: logs.unifiedScheduler.latestTimestamp,
          newEntryCount: newLogEntries(
            logs.unifiedScheduler,
            acceptedLogFences.unifiedScheduler.acceptedThrough,
          ).length,
        },
      },
    ),
    check(
      "no_new_private_or_job_log_failures",
      newLogFailures(logs.privateService, acceptedLogFences.failureCutoff)
        .length === 0 &&
        newLogFailures(logs.job, acceptedLogFences.failureCutoff).length === 0,
      {
        cutoff: acceptedLogFences.failureCutoff,
        privateServiceFailureCount: newLogFailures(
          logs.privateService,
          acceptedLogFences.failureCutoff,
        ).length,
        jobFailureCount: newLogFailures(
          logs.job,
          acceptedLogFences.failureCutoff,
        ).length,
      },
    ),
    check(
      "scheduler_inventory_is_project_complete",
      schedulerLocations.length > 0 &&
        schedulerLocations.includes(options.region ?? DEFAULT_REGION) &&
        inputs.attempted.filter((id) => id.startsWith("schedulers:")).length ===
          schedulerLocations.length &&
        schedulerAssets.count === schedulers.count &&
        schedulerInventoryMatches(
          inputs.results.schedulers,
          inputs.results.schedulerAssets,
        ),
      {
        assetCount: schedulerAssets.count,
        detailedCount: schedulers.count,
        assetLocations: schedulerAssets.locations,
        supportedLocationCount: schedulerLocations.length,
        detailedLocationReadCount: inputs.attempted.filter((id) =>
          id.startsWith("schedulers:"),
        ).length,
        inventoryMatches: schedulerInventoryMatches(
          inputs.results.schedulers,
          inputs.results.schedulerAssets,
        ),
      },
    ),
    check("governed_scheduler_set_exact", schedulers.checks.exactGovernedSet, {
      missing: schedulers.governed.missing,
      duplicates: schedulers.governed.duplicates,
    }),
    check(
      "governed_scheduler_definitions_match",
      schedulers.checks.governedDefinitionsMatch,
      { drift: schedulers.governed.definitionDrift },
    ),
    check(
      "legacy_staging_schedulers_paused",
      schedulers.checks.legacyPerArtifactSchedulersPaused,
      {
        nonPaused: schedulers.governed.jobs
          .filter(
            ({ name, state }) =>
              String(name).startsWith("recops-staging-") &&
              name !== UNIFIED_STAGING_SCHEDULER_NAME &&
              state !== "PAUSED",
          )
          .map(({ name, state }) => ({ name, state })),
      },
    ),
    check(
      "unified_staging_scheduler_enabled",
      schedulers.checks.unifiedStagingSchedulerEnabled,
      {
        observedState:
          schedulers.governed.jobs.find(
            ({ name }) => name === UNIFIED_STAGING_SCHEDULER_NAME,
          )?.state ?? "MISSING",
      },
    ),
    check(
      "unrelated_scheduler_boundary_clear",
      schedulers.checks.unrelatedBoundaryClear,
      { boundaryCrossers: schedulers.unrelated.boundaryCrossers },
    ),
  ]

  const components = {
    privateService,
    privateServiceIam,
    publicService,
    publicServiceIam,
    job,
    jobIam,
    schedulers,
    schedulerLocations,
    schedulerAssets,
    executions,
    logs,
  }
  const componentSha256 = Object.fromEntries(
    Object.entries(components).map(([name, value]) => [name, sha256(stableJson(value))]),
  )
  const snapshot = {
    schema: "recruiting-ops-control-plane-preflight/v1",
    observedAt: new Date().toISOString(),
    project: options.project ?? DEFAULT_PROJECT,
    region: options.region ?? DEFAULT_REGION,
    account: { expected: expectedAccount, active: activeAccount },
    protectedMain: {
      remoteSha: remoteMainSha,
      localHead,
      localDirtyCount,
    },
    collection: {
      attempted: inputs.attempted,
      failures: inputs.failures,
    },
    boundaries: {
      accepted: acceptedBoundaries,
      observed: observedBoundaries,
    },
    ...components,
    checks,
    ready: checks.every(({ ok }) => ok),
    componentSha256,
  }
  const fingerprintable = { ...snapshot }
  delete fingerprintable.observedAt
  return {
    ...snapshot,
    snapshotSha256: sha256(stableJson(fingerprintable)),
  }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--gcloud") options.gcloud = argv[++index]
    else if (arg === "--project") options.project = argv[++index]
    else if (arg === "--region") options.region = argv[++index]
    else if (arg === "--expected-account") options.expectedAccount = argv[++index]
    else if (arg === "--help") options.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function usage() {
  return [
    "Usage: node scripts/recruiting-ops-control-plane-preflight.mjs [options]",
    "",
    "Read-only options:",
    `  --gcloud PATH             gcloud binary (default: ${DEFAULT_GCLOUD})`,
    `  --project ID              project (default: ${DEFAULT_PROJECT})`,
    `  --region REGION           region/location (default: ${DEFAULT_REGION})`,
    `  --expected-account EMAIL  active account (default: ${DEFAULT_ACCOUNT})`,
    "",
    "Writes one secret-safe JSON snapshot to stdout. Exit 0 means every",
    "control-plane check passed; exit 1 means posture failed; exit 2 means",
    "collection or invocation failed. It has no mutation commands.",
  ].join("\n")
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  options.cwd = process.cwd()
  const inputs = collectInputs(options)
  const snapshot = buildSnapshot(inputs, options)
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
  process.exitCode = inputs.failures.length > 0 ? 2 : snapshot.ready ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
