import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const CRON_GATED_ROUTE_PATTERNS = [
  /^app\/api\/admin\//,
  /^app\/api\/cron\//,
  /^app\/api\/sweeps\//,
  /^app\/api\/ytd\/(?:backfill|incremental)\/route\.ts$/,
]

const PRIVATE_OIDC_GATED_ROUTES = new Set([
  "app/api/cron/recruiting-ops-staging-hydration/route.ts",
  // Read-only, and reachable both by its own Cloud Scheduler job and by an
  // operator asking "did Thursday run?" — the same two callers, and so the
  // same gate, as the hydration route above.
  "app/api/cron/recruiting-ops-staging-hydration-watchdog/route.ts",
])

const EMPLOYEE_REFERRAL_OIDC_GATED_ROUTES = new Map([
  [
    "app/api/cron/employee-referral-report/route.ts",
    "requireEmployeeReferralReportSchedulerAuthorization",
  ],
  [
    "app/api/cron/employee-referral-report-watchdog/route.ts",
    "requireEmployeeReferralWatchdogSchedulerAuthorization",
  ],
])

const LOOPBACK_BEARER_GATED_ROUTES = new Set([
  "app/api/cron/recruiting-ops-staging-orchestration/route.ts",
])

const BROAD_CANDIDATE_API_ROUTES = new Set([
  "app/api/ytd/applications/route.ts",
  "app/api/ytd/agency/applications/route.ts",
  "app/api/ytd/referral/applications/route.ts",
  "app/api/ytd/data-quality/route.ts",
])

function trackedApiRouteFiles() {
  return execFileSync("git", ["ls-files", "app/api/**/route.ts"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
}

describe("API route auth boundary", () => {
  test("tracked operational API routes require an approved authentication gate", () => {
    const offenders = trackedApiRouteFiles().filter((file) => {
      if (!CRON_GATED_ROUTE_PATTERNS.some((pattern) => pattern.test(file))) return false
      const source = readFileSync(file, "utf8")
      if (PRIVATE_OIDC_GATED_ROUTES.has(file)) {
        return !/requirePrivateHydratorAuthorization\s*\(\s*request\s*\)/.test(source)
      }
      const employeeReferralGate = EMPLOYEE_REFERRAL_OIDC_GATED_ROUTES.get(file)
      if (employeeReferralGate) {
        return !new RegExp(`${employeeReferralGate}\\s*\\(\\s*request\\s*\\)`).test(
          source
        )
      }
      if (LOOPBACK_BEARER_GATED_ROUTES.has(file)) {
        return !/isAuthorizedJobRequest\s*\(\s*request\s*\)/.test(source)
      }
      return !/requireCronSecret\s*\(\s*request\s*\)/.test(source)
    })

    expect(offenders).toEqual([])
  })

  test("tracked broad candidate APIs require broad-surface access", () => {
    const offenders = trackedApiRouteFiles().filter((file) => {
      if (!BROAD_CANDIDATE_API_ROUTES.has(file)) return false
      const source = readFileSync(file, "utf8")
      return !/requireBroadCandidateSurfaceAccess\s*\(\s*request\s*\)/.test(source)
    })

    expect(offenders).toEqual([])
  })
})
