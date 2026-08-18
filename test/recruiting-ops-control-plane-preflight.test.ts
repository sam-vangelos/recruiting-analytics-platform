import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

import {
  ACCEPTED_PUBLIC_AUTH_HEADER_SHA256,
  ACCEPTED_BOUNDARIES,
  EXPECTED_GOVERNED_SCHEDULERS,
  buildBoundaryFixture,
  buildCommandSpecs,
  buildSnapshot,
  collectInputs,
  deriveBoundaryFingerprints,
  fingerprintBoundaryFixture,
  normalizeEnvironment,
  normalizeSchedulers,
} from "../scripts/recruiting-ops-control-plane-preflight.mjs"

type ExpectedScheduler = {
  name: string
  schedule: string
  timeZone: string
  httpMethod: string
  attemptDeadline: string
  retryConfigSha256: string
  target: {
    origin: string
    path: string
    query: Record<string, string>
    oidcServiceAccountEmail: string | null
    oidcAudience: string | null
    oauthServiceAccountEmail: string | null
    oauthScope: string | null
    headerNames: string[]
    bodyLength: number
  }
}

const TEST_PUBLIC_AUTH_HEADER = "test-only-public-scheduler-token"
const TEST_PUBLIC_AUTH_HEADER_SHA256 = createHash("sha256")
  .update(TEST_PUBLIC_AUTH_HEADER)
  .digest("hex")
const PUBLIC_EXEC_ORIGIN =
  "https://ref-oidc-e49v5---ta-ops-analytics-abcdefghij-uc.a.run.app"
const EMPLOYEE_REFERRAL_ENV_NAMES = [
  "EMPLOYEE_REFERRAL_REPORT_FIRST_SCHEDULED_PERIOD",
  "EMPLOYEE_REFERRAL_REPORT_OIDC_AUDIENCE",
  "EMPLOYEE_REFERRAL_REPORT_OPERATOR_MODE",
  "EMPLOYEE_REFERRAL_REPORT_SCHEDULER_SERVICE_ACCOUNT",
  "EMPLOYEE_REFERRAL_REPORT_SEND_ENABLED",
  "EMPLOYEE_REFERRAL_WATCHDOG_SCHEDULER_SERVICE_ACCOUNT",
]
const FULL_ARTIFACT_ALLOWLIST = [
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
]

function rawScheduler(
  expected: ExpectedScheduler,
  state = "PAUSED",
) {
  const query = new URLSearchParams(expected.target.query).toString()
  return {
    name: `projects/example-project/locations/us-central1/jobs/${expected.name}`,
    state,
    schedule: expected.schedule,
    timeZone: expected.timeZone,
    attemptDeadline: expected.attemptDeadline,
    retryConfig: {
      maxBackoffDuration: "3600s",
      maxDoublings: 5,
      maxRetryDuration: "0s",
      minBackoffDuration: "5s",
    },
    httpTarget: {
      uri: `${expected.target.origin}${expected.target.path}${query ? `?${query}` : ""}`,
      httpMethod: expected.httpMethod,
      oidcToken: expected.target.oidcServiceAccountEmail
        ? {
            serviceAccountEmail: expected.target.oidcServiceAccountEmail,
            audience: expected.target.oidcAudience,
          }
        : undefined,
      headers: Object.fromEntries(
        expected.target.headerNames.map((name) => [
          name,
          name === "User-Agent"
            ? "Google-Cloud-Scheduler"
            : TEST_PUBLIC_AUTH_HEADER,
        ]),
      ),
      body: "",
    },
  }
}

const UNIFIED_STAGING_SCHEDULER_NAME = "recops-staging-orchestration-weekday"

// Per the operator's 2026-08-06 canonical-cutover directive, the steady-state posture
// has the unified scheduler ENABLED and every legacy per-artifact scheduler
// PAUSED. `overrides` lets a test enable/pause an additional named scheduler
// (e.g. "recruiting-ops-exec") without losing that default.
function liveGovernedSchedulers(overrides: Record<string, string> = {}) {
  return EXPECTED_GOVERNED_SCHEDULERS.map((entry) =>
    rawScheduler(
      entry,
      overrides[entry.name] ??
        (entry.name === UNIFIED_STAGING_SCHEDULER_NAME ? "ENABLED" : "PAUSED"),
    ),
  )
}

function schedulerAssets(names: readonly string[]) {
  return names.map((name) => ({
    assetType: "cloudscheduler.googleapis.com/Job",
    name: `//cloudscheduler.googleapis.com/projects/example-project/locations/us-central1/jobs/${name}`,
  }))
}

function service(name: string, image: string, sourceCommit: string) {
  const revision = `${name}-00001-abc`
  return {
    metadata: {
      name: `projects/example-project/locations/us-central1/services/${name}`,
      generation: 1,
      labels: { "source-commit": sourceCommit },
    },
    status: {
      latestCreatedRevisionName: revision,
      latestReadyRevisionName: revision,
      traffic: [{ revisionName: revision, percent: 100 }],
    },
    spec: {
      template: {
        metadata: {
          labels: { "source-commit": sourceCommit },
        },
        spec: {
          containers: [{ name: "app", image, env: [] }],
        },
      },
    },
  }
}

function job(
  image: string,
  sourceCommit: string,
  artifacts = FULL_ARTIFACT_ALLOWLIST,
) {
  const flags = [
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
  return {
    metadata: {
      name: "projects/example-project/locations/us-central1/jobs/ta-ops-staging-hydration",
      generation: 1,
      labels: { "source-commit": sourceCommit },
    },
    status: { executionCount: 0 },
    spec: {
      template: {
        metadata: {
          labels: { "source-commit": sourceCommit },
        },
        spec: {
          taskCount: 1,
          template: {
            spec: {
              containers: [
                {
                  image,
                  env: [
                    { name: "RECOPS_JOB_MODE", value: "write" },
                    { name: "RECOPS_JOB_ARTIFACTS", value: artifacts.join(",") },
                    ...flags.map((name) => ({ name, value: "true" })),
                  ],
                },
              ],
            },
          },
        },
      },
    },
  }
}

function attemptedIds() {
  return [
    ...buildCommandSpecs().map(({ id }) => id),
    "schedulers:us-central1",
  ]
}

function testOptions(
  acceptedBoundaries: ReturnType<typeof deriveBoundaryFingerprints>,
  releaseSha: string,
  privateImage: string,
) {
  return {
    acceptedBoundaries,
    acceptedRuntimeReleaseSha: releaseSha,
    acceptedPrivateImage: privateImage,
    acceptedExecutionFence: {
      count: 0,
      latestName: null,
      latestCreated: null,
    },
    publicAuthHeaderSha256: TEST_PUBLIC_AUTH_HEADER_SHA256,
    acceptedLogFences: {
      failureCutoff: "1970-01-01T00:00:00Z",
      unifiedScheduler: {
        acceptedThrough: "1970-01-01T00:00:00Z",
      },
    },
  }
}

function withSchedulerCoverage<T extends Record<string, unknown>>(results: T) {
  return {
    ...results,
    schedulerLocations: [{ locationId: "us-central1" }],
    runtimeDiff: "",
  }
}

function liveResults(sha: string, image: string) {
  return withSchedulerCoverage({
    activeAccount: "jordan.rivera@example.com",
    authProbe: true,
    remoteMain: `${sha}\trefs/heads/main`,
    localHead: sha,
    localStatus: "",
    privateService: service("ta-ops-staging-hydrator", image, sha),
    publicService: service(
      "ta-ops-analytics",
      "public@sha256:def",
      "public-release",
    ),
    job: job(image, sha),
    privateServiceIam: { bindings: [] },
    publicServiceIam: { bindings: [] },
    jobIam: { bindings: [] },
    schedulers: liveGovernedSchedulers(),
    schedulerAssets: schedulerAssets(
      EXPECTED_GOVERNED_SCHEDULERS.map(({ name }) => name),
    ),
    executions: [],
    jobLogs: [],
    privateServiceLogs: [],
    unifiedSchedulerLogs: [],
  })
}

describe("secret-safe control-plane preflight", () => {
  test("requires the exact complete eleven-artifact Job allowlist", () => {
    const sha = "1".repeat(40)
    const image = `private@sha256:${"2".repeat(64)}`
    const accepted = liveResults(sha, image)
    const options = testOptions(deriveBoundaryFingerprints(accepted), sha, image)

    const complete = buildSnapshot(
      {
        results: accepted,
        failures: [],
        attempted: attemptedIds(),
      },
      options,
    )
    expect(
      complete.checks.find(
        ({ id }) => id === "artifact_allowlist_complete",
      )?.ok,
    ).toBe(true)

    for (const artifacts of [
      FULL_ARTIFACT_ALLOWLIST.slice(1),
      [...FULL_ARTIFACT_ALLOWLIST, "all_hires"],
      [...FULL_ARTIFACT_ALLOWLIST.slice(1), "unknown_artifact"],
    ]) {
      const results = {
        ...accepted,
        job: job(image, sha, artifacts),
      }
      const snapshot = buildSnapshot(
        {
          results,
          failures: [],
          attempted: attemptedIds(),
        },
        testOptions(deriveBoundaryFingerprints(results), sha, image),
      )
      expect(
        snapshot.checks.find(
          ({ id }) => id === "artifact_allowlist_complete",
        )?.ok,
      ).toBe(false)
      expect(snapshot.ready).toBe(false)
    }
  })

  test("default boundary constants reproduce the independent accepted fixture", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/recruiting-ops-control-plane-accepted-boundaries.json",
          import.meta.url,
        ),
        "utf8",
      ),
    )

    expect(fingerprintBoundaryFixture(fixture)).toEqual(ACCEPTED_BOUNDARIES)
  })

  test("accepted public fence pins the tagged origin, auth hash, and exact IAM", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/recruiting-ops-control-plane-accepted-boundaries.json",
          import.meta.url,
        ),
        "utf8",
      ),
    )
    const publicScheduler = EXPECTED_GOVERNED_SCHEDULERS.find(
      ({ name }) => name === "recruiting-ops-exec",
    )

    expect(publicScheduler?.target.origin).toBe(PUBLIC_EXEC_ORIGIN)
    expect(ACCEPTED_PUBLIC_AUTH_HEADER_SHA256).toBe(
      "2222222222222222222222222222222222222222222222222222222222222222",
    )
    expect(fixture.publicServiceIam).toEqual({
      version: 1,
      bindings: [
        {
          role: "roles/run.invoker",
          members: [
            "allUsers",
            "serviceAccount:ta-ops-ref-report-scheduler@example-project.iam.gserviceaccount.com",
            "serviceAccount:ta-ops-ref-watchdog-scheduler@example-project.iam.gserviceaccount.com",
          ],
          conditionPresent: false,
        },
      ],
    })
  })

  test("same-count employee-referral environment substitution fails the public fence", () => {
    const sha = "1".repeat(40)
    const image = `private@sha256:${"2".repeat(64)}`
    const results = liveResults(sha, image)
    const publicContainer =
      results.publicService.spec.template.spec.containers[0] as {
        env: Array<{ name: string; value: string }>
      }
    publicContainer.env = EMPLOYEE_REFERRAL_ENV_NAMES.map((name, index) => ({
      name,
      value: `test-value-${index}`,
    }))
    const acceptedBoundaries = deriveBoundaryFingerprints(results)
    const driftedResults = structuredClone(results)
    const driftedPublicContainer =
      driftedResults.publicService.spec.template.spec.containers[0] as {
        env: Array<{ name: string; value: string }>
      }
    driftedPublicContainer.env[0] = {
      name: "SAME_COUNT_REPLACEMENT",
      value: "test-value-0",
    }

    const snapshot = buildSnapshot(
      {
        results: driftedResults,
        failures: [],
        attempted: attemptedIds(),
      },
      testOptions(acceptedBoundaries, sha, image),
    )

    expect(
      snapshot.checks.find(({ id }) => id === "public_service_unchanged")?.ok,
    ).toBe(false)
    expect(snapshot.boundaries.observed.publicServiceControlSha256).toBe(
      "MISMATCH",
    )
    expect(JSON.stringify(snapshot)).not.toContain("SAME_COUNT_REPLACEMENT")
  })

  test("recipient boundary values are hash-pinned without being serialized", () => {
    const sha = "1".repeat(40)
    const image = `private@sha256:${"2".repeat(64)}`
    const results = liveResults(sha, image)
    const publicContainer =
      results.publicService.spec.template.spec.containers[0] as {
        env: Array<{ name: string; value: string }>
      }
    publicContainer.env = [
      {
        name: "EMPLOYEE_REFERRAL_REPORT_RECIPIENTS",
        value: "private-recipient@example.com",
      },
      {
        name: "NOTIFY_EMAIL_FROM",
        value: "private-sender@example.com",
      },
    ]

    const fixture = buildBoundaryFixture(results)
    const first = fingerprintBoundaryFixture(fixture)
    const serialized = JSON.stringify(fixture)
    expect(serialized).not.toContain("private-recipient@example.com")
    expect(serialized).not.toContain("private-sender@example.com")
    expect(serialized).toContain("valueSha256")

    publicContainer.env[0].value = "different-recipient@example.com"
    expect(deriveBoundaryFingerprints(results).publicServiceControlSha256).not.toBe(
      first.publicServiceControlSha256,
    )
  })

  test("an enabled adopted public Scheduler does not block a private staging deployment", () => {
    const schedulers = liveGovernedSchedulers({ "recruiting-ops-exec": "ENABLED" })
    const result = normalizeSchedulers(schedulers, {
      publicAuthHeaderSha256: TEST_PUBLIC_AUTH_HEADER_SHA256,
    })

    expect(result.checks.exactGovernedSet).toBe(true)
    expect(result.checks.governedDefinitionsMatch).toBe(true)
    expect(result.checks.legacyPerArtifactSchedulersPaused).toBe(true)
    expect(result.checks.unifiedStagingSchedulerEnabled).toBe(true)
    expect(result.checks.governedAllPaused).toBe(false)
    expect(result.checks.allSchedulersPaused).toBe(false)
    expect(result.governed.jobs).toContainEqual(
      expect.objectContaining({
        name: "recruiting-ops-exec",
        state: "ENABLED",
      }),
    )

    const sha = "1".repeat(40)
    const image = `private@sha256:${"2".repeat(64)}`
    const results = { ...liveResults(sha, image), schedulers }
    const snapshot = buildSnapshot(
      {
        results,
        failures: [],
        attempted: attemptedIds(),
      },
      {
        ...testOptions(deriveBoundaryFingerprints(results), sha, image),
        publicAuthHeaderSha256: TEST_PUBLIC_AUTH_HEADER_SHA256,
      },
    )
    expect(
      snapshot.checks.find(
        ({ id }) => id === "legacy_staging_schedulers_paused",
      )?.ok,
    ).toBe(true)
    expect(
      snapshot.checks.find(
        ({ id }) => id === "unified_staging_scheduler_enabled",
      )?.ok,
    ).toBe(true)
    expect(snapshot.ready).toBe(true)
  })

  test("inventory is dynamic, separates the 13 governed jobs, and never serializes headers/body", () => {
    const governed = liveGovernedSchedulers({ "recruiting-ops-exec": "ENABLED" })
    const unrelated = Array.from({ length: 7 }, (_, index) => ({
      ...rawScheduler({
        ...EXPECTED_GOVERNED_SCHEDULERS[0],
        name: `unrelated-${index}`,
        target: {
          ...EXPECTED_GOVERNED_SCHEDULERS[0].target,
          origin: "https://unrelated.example.com",
          path: `/api/cron/unrelated-${index}`,
          query: {},
          oidcServiceAccountEmail: null,
          oidcAudience: null,
        },
      }),
      state: "ENABLED",
    }))
    const result = normalizeSchedulers([...governed, ...unrelated], {
      publicAuthHeaderSha256: TEST_PUBLIC_AUTH_HEADER_SHA256,
    })
    const serialized = JSON.stringify(result)

    expect(result.count).toBe(20)
    expect(result.governed.observedCount).toBe(13)
    expect(result.unrelated.count).toBe(7)
    expect(result.checks.exactGovernedSet).toBe(true)
    expect(result.checks.governedDefinitionsMatch).toBe(true)
    expect(result.checks.legacyPerArtifactSchedulersPaused).toBe(true)
    expect(result.checks.unifiedStagingSchedulerEnabled).toBe(true)
    expect(result.checks.governedAllPaused).toBe(false)
    expect(result.checks.allSchedulersPaused).toBe(false)
    expect(result.checks.unrelatedBoundaryClear).toBe(true)
    expect(result.unrelated.boundaryCrossers).toEqual([])
    expect(serialized).not.toContain("Authorization")
    expect(serialized).not.toContain(TEST_PUBLIC_AUTH_HEADER)
    expect(serialized).not.toContain('"body"')
  })

  test("missing, duplicate, and route-drifted governed definitions fail closed", () => {
    const raw = EXPECTED_GOVERNED_SCHEDULERS.map((entry) => rawScheduler(entry))
    raw.shift()
    raw.push(rawScheduler(EXPECTED_GOVERNED_SCHEDULERS[1]))
    raw[1].httpTarget.uri = "https://example.invalid/api/cron/other?token=top-secret"

    const result = normalizeSchedulers(raw, {
      publicAuthHeaderSha256: TEST_PUBLIC_AUTH_HEADER_SHA256,
    })
    expect(result.checks.exactGovernedSet).toBe(false)
    expect(result.checks.governedDefinitionsMatch).toBe(false)
    expect(result.governed.missing).toHaveLength(1)
    expect(result.governed.duplicates).toEqual([EXPECTED_GOVERNED_SCHEDULERS[1].name])
    expect(JSON.stringify(result)).not.toContain("top-secret")
  })

  test("governed Scheduler targets reject URI credentials and fragments", () => {
    const raw = EXPECTED_GOVERNED_SCHEDULERS.map((entry) =>
      rawScheduler(entry),
    )
    for (const scheduler of raw) {
      const uri = new URL(scheduler.httpTarget.uri)
      uri.username = "candidate"
      uri.password = "secret"
      uri.hash = "candidate-jordan-rivera"
      scheduler.httpTarget.uri = uri.toString()
    }

    const result = normalizeSchedulers(raw, {
      publicAuthHeaderSha256: TEST_PUBLIC_AUTH_HEADER_SHA256,
    })
    const serialized = JSON.stringify(result)

    expect(result.checks.governedDefinitionsMatch).toBe(false)
    expect(
      result.governed.definitionDrift.every(({ failedFields }) =>
        ["credentialsAbsent", "hashEmpty"].every((field) =>
          failedFields.includes(field),
        ),
      ),
    ).toBe(true)
    expect(serialized).not.toContain("candidate-jordan-rivera")
    expect(serialized).not.toContain("secret")
  })

  test("same-count Scheduler header replacement fails closed without serializing values", () => {
    const raw = EXPECTED_GOVERNED_SCHEDULERS.map((entry) =>
      rawScheduler(entry),
    )
    for (const scheduler of raw) {
      const count = Object.keys(scheduler.httpTarget.headers).length
      scheduler.httpTarget.headers = Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `Candidate-${index}`,
          `candidate-name-${index}@example.com`,
        ]),
      )
    }

    const result = normalizeSchedulers(raw, {
      publicAuthHeaderSha256: TEST_PUBLIC_AUTH_HEADER_SHA256,
    })
    const serialized = JSON.stringify(result)

    expect(result.checks.governedDefinitionsMatch).toBe(false)
    expect(
      result.governed.definitionDrift.every(({ failedFields }) =>
        failedFields.includes("headerNamesMatch"),
      ),
    ).toBe(true)
    expect(serialized).not.toContain("Candidate-")
    expect(serialized).not.toContain("@example.com")
  })

  test("unrelated dynamic targets cannot serialize paths, queries, identities, or headers", () => {
    const unrelated = rawScheduler({
      ...EXPECTED_GOVERNED_SCHEDULERS[0],
      name: "unrelated-private-data",
      target: {
        ...EXPECTED_GOVERNED_SCHEDULERS[0].target,
        origin: "https://unrelated.example.com",
        path: "/candidate-name@example.com",
        query: { artifact: "person.name@example.com" },
        oidcServiceAccountEmail: "human.person@example.com",
        oidcAudience: "https://audience.example.com/candidate",
        headerNames: ["Candidate-Name"],
      },
    })
    unrelated.httpTarget.headers = {
      "Candidate-Name": "person.name@example.com",
    }

    const serialized = JSON.stringify(
      normalizeSchedulers([unrelated], {
        publicAuthHeaderSha256: TEST_PUBLIC_AUTH_HEADER_SHA256,
      }),
    )

    expect(serialized).not.toContain("candidate-name@example.com")
    expect(serialized).not.toContain("person.name@example.com")
    expect(serialized).not.toContain("human.person@example.com")
    expect(serialized).not.toContain("audience.example.com")
    expect(serialized).not.toContain("Candidate-Name")
  })

  test("only posture values are emitted; other plaintext values are omitted", () => {
    const result = normalizeEnvironment([
      { name: "RECOPS_JOB_MODE", value: "dry_run" },
      { name: "RECOPS_JOB_ARTIFACTS", value: "candidate-name@example.com" },
      { name: "DIRECT_SECRET", value: "do-not-print" },
      {
        name: "SECRET_REF",
        valueFrom: { secretKeyRef: { name: "stored-secret", key: "latest" } },
      },
    ])
    expect(result).toContainEqual({ name: "RECOPS_JOB_MODE", value: "dry_run" })
    expect(result.filter((entry) => entry.redacted === true)).toHaveLength(3)
    expect(JSON.stringify(result)).not.toContain("DIRECT_SECRET")
    expect(JSON.stringify(result)).not.toContain("SECRET_REF")
    expect(JSON.stringify(result)).not.toContain("stored-secret")
    expect(JSON.stringify(result)).not.toContain("latest")
    expect(JSON.stringify(result)).not.toContain("do-not-print")
    expect(JSON.stringify(result)).not.toContain("candidate-name@example.com")
  })

  test("allowlisted control-plane fields cannot smuggle drift values into the snapshot", () => {
    const sha = "1".repeat(40)
    const image = `private@sha256:${"2".repeat(64)}`
    const marker = "candidate-jordan-rivera@example.com"
    const compactMarker = "candidatejordanrivera"
    const base = liveResults(sha, image)
    const privateContainer = base.privateService.spec.template.spec.containers[0]
    const jobContainer =
      base.job.spec.template.spec.template.spec.containers[0]
    const results = {
      ...base,
      activeAccount: marker,
      runtimeDiff: `docs/${marker}.md`,
      privateService: {
        ...base.privateService,
        metadata: {
          ...base.privateService.metadata,
          labels: {
            ...base.privateService.metadata.labels,
            "source-commit": marker,
            "recops-scope": marker,
            "cloud.googleapis.com/location": "candidate-jordan-rivera",
          },
        },
        spec: {
          ...base.privateService.spec,
          template: {
            ...base.privateService.spec.template,
            metadata: {
              ...base.privateService.spec.template.metadata,
              labels: {
                ...base.privateService.spec.template.metadata.labels,
                "source-commit": marker,
              },
            },
            spec: {
              ...base.privateService.spec.template.spec,
              serviceAccountName: marker,
              containers: [
                {
                  ...privateContainer,
                  image: `registry.example/${marker}@sha256:${"3".repeat(64)}`,
                },
              ],
            },
          },
        },
      },
      job: {
        ...base.job,
        status: {
          executionCount: 1,
          latestCreatedExecution: {
            name: `ta-ops-staging-hydration-${compactMarker}`,
            creationTimestamp: marker,
            completionStatus: marker,
          },
        },
        spec: {
          ...base.job.spec,
          template: {
            ...base.job.spec.template,
            spec: {
              ...base.job.spec.template.spec,
              template: {
                ...base.job.spec.template.spec.template,
                spec: {
                  ...base.job.spec.template.spec.template.spec,
                  containers: [
                    {
                      ...jobContainer,
                      env: [
                        ...jobContainer.env,
                        {
                          name: "GREENHOUSE_CLIENT_SECRET",
                          valueFrom: {
                            secretKeyRef: { name: marker, key: marker },
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
      executions: [
        {
          metadata: {
            name: `ta-ops-staging-hydration-${compactMarker}`,
            creationTimestamp: marker,
          },
          status: { completionTime: marker },
        },
      ],
      jobIam: {
        bindings: [{ role: marker, members: [marker] }],
        etag: marker,
        version: marker,
      },
      schedulerAssets: [
        {
          assetType: "cloudscheduler.googleapis.com/Job",
          name: `//cloudscheduler.googleapis.com/projects/example-project/locations/candidate-jordan-rivera/jobs/${EXPECTED_GOVERNED_SCHEDULERS[0].name}`,
        },
      ],
    }

    const snapshot = buildSnapshot(
      {
        results,
        failures: [],
        attempted: attemptedIds(),
      },
      testOptions(
        deriveBoundaryFingerprints(liveResults(sha, image)),
        sha,
        image,
      ),
    )

    expect(JSON.stringify(snapshot)).not.toContain(marker)
    expect(JSON.stringify(snapshot)).not.toContain("candidate-jordan-rivera")
    expect(JSON.stringify(snapshot)).not.toContain(compactMarker)
    expect(snapshot.ready).toBe(false)
  })

  test("command catalog is read-only and excludes Scheduler headers, bodies, and message payloads", () => {
    const specs = buildCommandSpecs({ gcloud: "gcloud" })
    const commandText = specs.map(({ args }) => args.join(" ")).join("\n")
    const forbiddenMutations = /\b(execute|update|delete|pause|resume|create)\b/

    expect(commandText).not.toMatch(forbiddenMutations)
    expect(commandText).not.toMatch(/httpTarget\.headers(?!\.len\(\))/)
    expect(commandText).not.toMatch(/httpTarget\.body(?!\.len\(\))/)
    expect(commandText).not.toContain("textPayload")
    expect(commandText).not.toContain("jsonPayload.message")
  })

  test("structured log result fields cannot leak through the field-limited normalizer", () => {
    const sha = "a".repeat(40)
    const image = `private@sha256:${"d".repeat(64)}`
    const results = withSchedulerCoverage({
      activeAccount: "jordan.rivera@example.com",
      authProbe: true,
      remoteMain: `${sha}\trefs/heads/main`,
      localHead: sha,
      localStatus: "",
      privateService: service("ta-ops-staging-hydrator", image, sha),
      publicService: service("ta-ops-analytics", "public@sha256:def", "public-release"),
      job: job(image, sha),
      privateServiceIam: { bindings: [] },
      publicServiceIam: { bindings: [] },
      jobIam: { bindings: [] },
      schedulers: EXPECTED_GOVERNED_SCHEDULERS.map((entry) => rawScheduler(entry)),
      schedulerAssets: schedulerAssets(
        EXPECTED_GOVERNED_SCHEDULERS.map(({ name }) => name),
      ),
      executions: [],
      jobLogs: [
        {
          jsonPayload: {
            event: "Candidate Name",
            result: { candidateName: "do-not-leak" },
          },
        },
      ],
      privateServiceLogs: [],
      unifiedSchedulerLogs: [],
    })
    const snapshot = buildSnapshot({
      results,
      failures: [],
      attempted: attemptedIds(),
    }, testOptions(deriveBoundaryFingerprints(results), sha, image))
    expect(JSON.stringify(snapshot)).not.toContain("do-not-leak")
    expect(JSON.stringify(snapshot)).not.toContain("Candidate Name")
    expect(snapshot.logs.job.entries[0].result).toMatchObject({ redacted: true })
  })

  test("fresh Scheduler or private-runtime failures block an otherwise-ready preflight", () => {
    const sha = "2".repeat(40)
    const image = `private@sha256:${"4".repeat(64)}`
    const base = liveResults(sha, image)
    const results = {
      ...base,
      unifiedSchedulerLogs: [
        {
          timestamp: "2026-07-23T10:00:00Z",
          severity: "ERROR",
          httpRequest: { status: 500 },
        },
      ],
      privateServiceLogs: [
        {
          timestamp: "2026-07-23T10:00:01Z",
          severity: "WARNING",
          httpRequest: { status: 400 },
        },
      ],
      jobLogs: [
        {
          timestamp: "candidate-jordan-rivera",
          severity: "ERROR",
        },
      ],
    }

    const snapshot = buildSnapshot(
      {
        results,
        failures: [],
        attempted: attemptedIds(),
      },
      testOptions(deriveBoundaryFingerprints(results), sha, image),
    )

    expect(
      snapshot.checks.find(
        ({ id }) => id === "no_new_unified_scheduler_logs",
      )?.ok,
    ).toBe(false)
    expect(
      snapshot.checks.find(
        ({ id }) => id === "no_new_private_or_job_log_failures",
      )?.ok,
    ).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain("candidate-jordan-rivera")
    expect(snapshot.ready).toBe(false)
  })

  test("collection attempts every diagnostic after a failed posture read", () => {
    const specs = buildCommandSpecs({ gcloud: "gcloud" })
    const attempted: string[] = []
    const collected = collectInputs(
      { gcloud: "gcloud", cwd: process.cwd() },
      (spec) => {
        attempted.push(spec.id)
        if (spec.id === "schedulerLocations") {
          return {
            status: 0,
            stdout: JSON.stringify([{ locationId: "us-central1" }]),
          }
        }
        if (spec.id === "schedulers:us-central1") {
          return { status: 1, stdout: "" }
        }
        if (spec.parse === "discard") return { status: 0, stdout: "" }
        if (spec.parse === "json") return { status: 0, stdout: "[]" }
        return { status: 0, stdout: "" }
      },
    )

    expect(attempted).toEqual([
      ...specs.map(({ id }) => id),
      "schedulers:us-central1",
    ])
    expect(collected.failures).toEqual([
      { id: "schedulers:us-central1", exitCode: 1 },
    ])
    expect(attempted).toContain("unifiedSchedulerLogs")
  })

  test("collection reads Scheduler definitions and states in every API location", () => {
    const attempted: string[] = []
    const collected = collectInputs(
      { gcloud: "gcloud", cwd: process.cwd() },
      (spec) => {
        attempted.push(spec.id)
        if (spec.id === "schedulerLocations") {
          return {
            status: 0,
            stdout: JSON.stringify([
              { locationId: "europe-west1" },
              { locationId: "us-central1" },
            ]),
          }
        }
        if (spec.parse === "discard") return { status: 0, stdout: "" }
        if (spec.parse === "json") return { status: 0, stdout: "[]" }
        return { status: 0, stdout: "" }
      },
    )

    expect(collected.failures).toEqual([])
    expect(attempted.slice(-2)).toEqual([
      "schedulers:europe-west1",
      "schedulers:us-central1",
    ])
    expect(collected.results.schedulers).toEqual([])
  })

  test("invalid Scheduler location identifiers fail closed without entering diagnostics", () => {
    const marker = "candidate-jordan-rivera@example.com"
    const attempted: string[] = []
    const collected = collectInputs(
      { gcloud: "gcloud", cwd: process.cwd() },
      (spec) => {
        attempted.push(spec.id)
        if (spec.id === "schedulerLocations") {
          return {
            status: 0,
            stdout: JSON.stringify([
              { locationId: marker },
              { locationId: "us-central1" },
            ]),
          }
        }
        if (spec.parse === "discard") return { status: 0, stdout: "" }
        if (spec.parse === "json") return { status: 0, stdout: "[]" }
        return { status: 0, stdout: "" }
      },
    )

    expect(collected.failures).toContainEqual({
      id: "schedulerLocations",
      invalidLocationCount: 1,
    })
    expect(JSON.stringify(collected)).not.toContain(marker)
    expect(attempted.at(-1)).toBe("schedulers:us-central1")
  })

  test("enabled public jobs block a fire and unrelated boundary crossings block independently", () => {
    const sha = "a".repeat(40)
    const image = `us-central1-docker.pkg.dev/project/repo/image@sha256:${"c".repeat(64)}`
    const baseResults = withSchedulerCoverage({
      activeAccount: "jordan.rivera@example.com",
      authProbe: true,
      remoteMain: `${sha}\trefs/heads/main`,
      localHead: sha,
      localStatus: "",
      privateService: service("ta-ops-staging-hydrator", image, sha),
      publicService: service("ta-ops-analytics", "public@sha256:def", "public-release"),
      job: job(image, sha),
      privateServiceIam: { bindings: [] },
      publicServiceIam: { bindings: [] },
      jobIam: { bindings: [] },
      schedulers: liveGovernedSchedulers(),
      schedulerAssets: schedulerAssets(
        EXPECTED_GOVERNED_SCHEDULERS.map(({ name }) => name),
      ),
      executions: [],
      jobLogs: [],
      privateServiceLogs: [],
      unifiedSchedulerLogs: [],
    })
    const acceptedBoundaries = deriveBoundaryFingerprints(baseResults)
    const ready = buildSnapshot(
      {
        results: baseResults,
        failures: [],
        attempted: attemptedIds(),
      },
      testOptions(acceptedBoundaries, sha, image),
    )
    expect(ready.ready).toBe(true)

    const benign = {
      ...EXPECTED_GOVERNED_SCHEDULERS[0],
      name: "unrelated-enabled",
      target: {
        ...EXPECTED_GOVERNED_SCHEDULERS[0].target,
        origin: "https://unrelated.example.com",
        path: "/api/cron/unrelated",
        query: {},
        oidcServiceAccountEmail: null,
        oidcAudience: null,
      },
    }
    const unrelatedReady = buildSnapshot(
      {
        results: {
          ...baseResults,
          schedulers: [
            ...baseResults.schedulers,
            rawScheduler(benign, "ENABLED"),
          ],
          schedulerAssets: schedulerAssets([
            ...EXPECTED_GOVERNED_SCHEDULERS.map(({ name }) => name),
            benign.name,
          ]),
        },
        failures: [],
        attempted: attemptedIds(),
      },
      testOptions(acceptedBoundaries, sha, image),
    )
    expect(unrelatedReady.ready).toBe(true)
    expect(
      unrelatedReady.checks.find(
        ({ id }) => id === "unrelated_scheduler_boundary_clear",
      )?.ok,
    ).toBe(true)

    const crossing = {
      ...benign,
      name: "unrelated-crossing",
      target: {
        ...benign.target,
        path: "/api/cron/recruiting-ops-shadow",
      },
    }
    const blocked = buildSnapshot(
      {
        results: {
          ...baseResults,
          schedulers: [...baseResults.schedulers, rawScheduler(crossing, "PAUSED")],
          schedulerAssets: schedulerAssets([
            ...EXPECTED_GOVERNED_SCHEDULERS.map(({ name }) => name),
            crossing.name,
          ]),
        },
        failures: [],
        attempted: attemptedIds(),
      },
      testOptions(acceptedBoundaries, sha, image),
    )
    expect(blocked.ready).toBe(false)
    expect(
      blocked.checks.find(
        ({ id }) => id === "unrelated_scheduler_boundary_clear",
      )?.ok,
    ).toBe(false)
    expect(blocked.schedulers.unrelated.boundaryCrossers).toEqual([
      {
        name: null,
        nameRedacted: true,
        reasons: ["recruiting_ops_route"],
      },
    ])
  })

  test("pinned full control and IAM boundaries fail closed on otherwise-dark drift", () => {
    const sha = "b".repeat(40)
    const image = `private@sha256:${"e".repeat(64)}`
    const results = withSchedulerCoverage({
      activeAccount: "jordan.rivera@example.com",
      authProbe: true,
      remoteMain: `${sha}\trefs/heads/main`,
      localHead: sha,
      localStatus: "",
      privateService: service("ta-ops-staging-hydrator", image, sha),
      publicService: service("ta-ops-analytics", "public@sha256:def", "public-release"),
      job: job(image, sha),
      privateServiceIam: { bindings: [] },
      publicServiceIam: { bindings: [] },
      jobIam: { bindings: [] },
      schedulers: EXPECTED_GOVERNED_SCHEDULERS.map((entry) => rawScheduler(entry)),
      schedulerAssets: schedulerAssets(
        EXPECTED_GOVERNED_SCHEDULERS.map(({ name }) => name),
      ),
      executions: [],
      jobLogs: [],
      privateServiceLogs: [],
      unifiedSchedulerLogs: [],
    })
    const acceptedBoundaries = deriveBoundaryFingerprints(results)
    const driftedResults = {
      ...results,
      jobIam: {
        bindings: [{ role: "roles/run.admin", members: ["allUsers"] }],
      },
    }
    const snapshot = buildSnapshot(
      {
        results: driftedResults,
        failures: [],
        attempted: attemptedIds(),
      },
      testOptions(acceptedBoundaries, sha, image),
    )

    expect(snapshot.ready).toBe(false)
    expect(snapshot.checks.find(({ id }) => id === "job_iam_unchanged")?.ok).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain("human.person@example.com")
  })

  test("root ingress and service traffic drift are covered by the full control boundary", () => {
    const sha = "c".repeat(40)
    const image = `private@sha256:${"7".repeat(64)}`
    const results = liveResults(sha, image)
    const acceptedBoundaries = deriveBoundaryFingerprints(results)
    const driftedService = {
      ...structuredClone(results.privateService),
      metadata: {
        ...structuredClone(results.privateService.metadata),
        annotations: {
          "run.googleapis.com/ingress": "all",
        },
      },
      spec: {
        ...structuredClone(results.privateService.spec),
        traffic: [{ latestRevision: true, percent: 90, tag: "stale" }],
      },
    }
    const snapshot = buildSnapshot(
      {
        results: { ...results, privateService: driftedService },
        failures: [],
        attempted: attemptedIds(),
      },
      testOptions(acceptedBoundaries, sha, image),
    )

    expect(snapshot.ready).toBe(false)
    expect(
      snapshot.checks.find(
        ({ id }) => id === "private_service_control_unchanged",
      )?.ok,
    ).toBe(false)
    expect(snapshot.boundaries.observed.privateServiceControlSha256).toBe(
      "MISMATCH",
    )
  })

  test("an arbitrary shared immutable digest cannot replace the approved release", () => {
    const sha = "d".repeat(40)
    const approvedImage = `private@sha256:${"8".repeat(64)}`
    const replacementImage = `private@sha256:${"9".repeat(64)}`
    const results = liveResults(sha, approvedImage)
    const replaced = {
      ...results,
      privateService: service(
        "ta-ops-staging-hydrator",
        replacementImage,
        sha,
      ),
      job: job(replacementImage, sha),
    }
    const snapshot = buildSnapshot(
      {
        results: replaced,
        failures: [],
        attempted: attemptedIds(),
      },
      testOptions(deriveBoundaryFingerprints(replaced), sha, approvedImage),
    )

    expect(
      snapshot.checks.find(
        ({ id }) => id === "approved_runtime_release_provenance",
      )?.ok,
    ).toBe(false)
  })

  test("a completed unauthorized execution and runtime-affecting main drift each fail closed", () => {
    const sha = "e".repeat(40)
    const image = `private@sha256:${"a".repeat(64)}`
    const results = liveResults(sha, image)
    const unauthorizedJob = {
      ...results.job,
      status: {
        executionCount: 1,
        latestCreatedExecution: {
          name: "ta-ops-staging-hydration-manual",
          creationTimestamp: "2026-07-23T10:00:00Z",
        },
      },
    }
    const unauthorizedExecution = {
      metadata: {
        name: "ta-ops-staging-hydration-manual",
        creationTimestamp: "2026-07-23T10:00:00Z",
      },
      status: {
        completionTime: "2026-07-23T10:01:00Z",
        succeededCount: 1,
      },
    }
    const snapshot = buildSnapshot(
      {
        results: {
          ...results,
          runtimeDiff: "lib/recruiting-ops-staging-hydration.ts",
          job: unauthorizedJob,
          executions: [unauthorizedExecution],
        },
        failures: [],
        attempted: attemptedIds(),
      },
      testOptions(deriveBoundaryFingerprints(results), sha, image),
    )

    expect(
      snapshot.checks.find(
        ({ id }) => id === "hydration_execution_fence_unchanged",
      )?.ok,
    ).toBe(false)
    expect(
      snapshot.checks.find(
        ({ id }) => id === "approved_runtime_release_provenance",
      )?.ok,
    ).toBe(false)
    expect(
      snapshot.checks.find(
        ({ id }) => id === "no_active_hydration_execution",
      )?.ok,
    ).toBe(true)
  })

  test("documentation and the preflight-only release diff do not force a runtime rebuild", () => {
    const sha = "f".repeat(40)
    const image = `private@sha256:${"b".repeat(64)}`
    const results = liveResults(sha, image)
    const snapshot = buildSnapshot(
      {
        results: {
          ...results,
          runtimeDiff: [
            "docs/recruiting-ops/evidence.md",
            "scripts/recruiting-ops-control-plane-preflight.mjs",
            "test/fixtures/recruiting-ops-control-plane-accepted-boundaries.json",
            "test/recruiting-ops-control-plane-preflight.test.ts",
          ].join("\n"),
        },
        failures: [],
        attempted: attemptedIds(),
      },
      testOptions(deriveBoundaryFingerprints(results), sha, image),
    )

    expect(snapshot.ready).toBe(true)
  })

  test("mutable images, stale traffic, and active executions each block readiness", () => {
    const sha = "f".repeat(40)
    const mutableImage = "repo/image:latest"
    const privateService = service("ta-ops-staging-hydrator", mutableImage, sha)
    ;(privateService.metadata.labels as Record<string, string>)["custom-note"] =
      "candidate-name@example.com"
    privateService.status.latestCreatedRevisionName = "new-unreviewed"
    privateService.status.traffic = [{ revisionName: "old-ready", percent: 100 }]
    const baseResults = withSchedulerCoverage({
      activeAccount: "jordan.rivera@example.com",
      authProbe: true,
      remoteMain: `${sha}\trefs/heads/main`,
      localHead: sha,
      localStatus: "",
      privateService,
      publicService: service("ta-ops-analytics", "public@sha256:def", "public-release"),
      job: job(mutableImage, sha),
      privateServiceIam: { bindings: [] },
      publicServiceIam: { bindings: [] },
      jobIam: {
        bindings: [
          {
            role: "roles/viewer",
            members: ["user:human.person@example.com"],
          },
        ],
      },
      schedulers: EXPECTED_GOVERNED_SCHEDULERS.map((entry) => rawScheduler(entry)),
      schedulerAssets: schedulerAssets(
        EXPECTED_GOVERNED_SCHEDULERS.map(({ name }) => name),
      ),
      executions: [
        {
          metadata: {
            name: "ta-ops-staging-hydration-running",
            creationTimestamp: "2026-07-23T10:00:00Z",
          },
          status: { runningCount: 1 },
        },
      ],
      jobLogs: [],
      privateServiceLogs: [],
      unifiedSchedulerLogs: [],
    })
    const snapshot = buildSnapshot(
      {
        results: baseResults,
        failures: [],
        attempted: attemptedIds(),
      },
      testOptions(
        deriveBoundaryFingerprints(baseResults),
        sha,
        mutableImage,
      ),
    )
    const failed = new Set(
      snapshot.checks.filter(({ ok }) => !ok).map(({ id }) => id),
    )

    expect(failed).toContain("approved_runtime_release_provenance")
    expect(failed).toContain("private_service_traffic_ready")
    expect(failed).toContain("no_active_hydration_execution")
    expect(JSON.stringify(snapshot)).not.toContain("candidate-name@example.com")
    expect(JSON.stringify(snapshot)).not.toContain("human.person@example.com")
  })
})
