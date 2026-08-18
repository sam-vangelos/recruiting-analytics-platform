import {
  createFixtureGreenhouseReadBoundary,
  type GreenhouseFixtureFacts,
  type GreenhouseReadBoundary,
} from "./greenhouse-read-boundary"
import { assertPublicSafe } from "../safe-public-output"

export type GreenhouseLiveReadScaffoldMode = "disabled" | "mock"
export type GreenhouseLiveReadReadinessStatus = "disabled" | "mock_ready" | "blocked"
export type GreenhouseLiveReadReadinessCheckId =
  | "live_read_flag"
  | "real_credentials"
  | "network_calls"
  | "mock_fixtures"

export interface GreenhouseLiveReadScaffoldInput {
  mode?: GreenhouseLiveReadScaffoldMode
  mockFacts?: GreenhouseFixtureFacts
  disabledReason?: string
}

export interface GreenhouseLiveReadReadinessInput {
  generatedAt: string
  mode?: GreenhouseLiveReadScaffoldMode
  liveReadFlagEnabled?: boolean
  realCredentialsConfigured?: boolean
  networkCallsEnabled?: boolean
  mockFacts?: GreenhouseFixtureFacts
}

export interface GreenhouseLiveReadReadinessCheck {
  checkId: GreenhouseLiveReadReadinessCheckId
  status: "pass" | "fail"
  detail: string
}

export interface GreenhouseLiveReadReadinessReport {
  adapterId: "greenhouse_harvest"
  sourceAdapter: "greenhouse_v3_read"
  generatedAt: string
  mode: GreenhouseLiveReadScaffoldMode
  status: GreenhouseLiveReadReadinessStatus
  liveReadsEnabled: false
  networkCallsAllowed: false
  liveAuthAllowed: false
  counts?: Record<keyof GreenhouseFixtureFacts, number>
  checks: readonly GreenhouseLiveReadReadinessCheck[]
  publicSummary: Record<string, unknown>
}

export class GreenhouseLiveReadDisabledError extends Error {
  constructor(methodName: string, reason: string) {
    super(`Greenhouse live-read boundary is disabled for ${methodName}: ${reason}`)
    this.name = "GreenhouseLiveReadDisabledError"
  }
}

export function createPhase4GreenhouseLiveReadBoundary(
  input: GreenhouseLiveReadScaffoldInput = {}
): GreenhouseReadBoundary {
  const mode = input.mode ?? "disabled"
  if (mode === "mock") {
    if (!input.mockFacts) throw new Error("Mock Greenhouse live-read boundary requires fixture facts")
    return createFixtureGreenhouseReadBoundary(input.mockFacts)
  }
  return createDisabledGreenhouseLiveReadBoundary(
    input.disabledReason ?? "Phase 4 permits disabled/mock scaffolds only; live reads require the operator approval."
  )
}

export function createDisabledGreenhouseLiveReadBoundary(reason: string): GreenhouseReadBoundary {
  return {
    sourceAdapter: "greenhouse_v3_read",
    fetchFinalOfferFacts: disabledRead("fetchFinalOfferFacts", reason),
    fetchRpsFacts: disabledRead("fetchRpsFacts", reason),
    fetchPipelineStageFacts: disabledRead("fetchPipelineStageFacts", reason),
    fetchOwnershipFacts: disabledRead("fetchOwnershipFacts", reason),
  }
}

export function evaluateGreenhouseLiveReadReadiness(
  input: GreenhouseLiveReadReadinessInput
): GreenhouseLiveReadReadinessReport {
  const mode = input.mode ?? "disabled"
  const checks: GreenhouseLiveReadReadinessCheck[] = [
    check(
      "live_read_flag",
      input.liveReadFlagEnabled === true ? "fail" : "pass",
      input.liveReadFlagEnabled === true
        ? "Live-read feature flag is enabled; Phase 4 must remain disabled/mock-only."
        : "Live-read feature flag is disabled."
    ),
    check(
      "real_credentials",
      input.realCredentialsConfigured === true ? "fail" : "pass",
      input.realCredentialsConfigured === true
        ? "Real credentials are configured; Phase 4 readiness blocks live reads."
        : "No real Greenhouse credentials are configured for this scaffold."
    ),
    check(
      "network_calls",
      input.networkCallsEnabled === true ? "fail" : "pass",
      input.networkCallsEnabled === true
        ? "Network calls are enabled; Phase 4 readiness blocks live reads."
        : "Network calls are disabled for this scaffold."
    ),
  ]
  const counts = input.mockFacts ? countFacts(input.mockFacts) : undefined
  if (mode === "mock") {
    checks.push(
      check(
        "mock_fixtures",
        input.mockFacts ? "pass" : "fail",
        input.mockFacts
          ? "Mock fixture facts are present for local readiness checks."
          : "Mock mode requires fixture facts."
      )
    )
  } else {
    checks.push(check("mock_fixtures", "pass", "Disabled mode does not require mock fixtures."))
  }

  const hasFailure = checks.some((item) => item.status === "fail")
  const status: GreenhouseLiveReadReadinessStatus = hasFailure
    ? "blocked"
    : mode === "mock"
      ? "mock_ready"
      : "disabled"
  const publicSummary = {
    adapterId: "greenhouse_harvest",
    sourceAdapter: "greenhouse_v3_read",
    mode,
    status,
    liveReadsEnabled: false,
    networkCallsAllowed: false,
    liveAuthAllowed: false,
    checkFailures: checks.filter((item) => item.status === "fail").length,
    counts,
  }
  assertPublicSafe(publicSummary, "greenhouseLiveReadReadiness.publicSummary")
  return {
    adapterId: "greenhouse_harvest",
    sourceAdapter: "greenhouse_v3_read",
    generatedAt: input.generatedAt,
    mode,
    status,
    liveReadsEnabled: false,
    networkCallsAllowed: false,
    liveAuthAllowed: false,
    counts,
    checks,
    publicSummary,
  }
}

function disabledRead(methodName: string, reason: string): () => Promise<never> {
  return async () => {
    throw new GreenhouseLiveReadDisabledError(methodName, reason)
  }
}

function check(
  checkId: GreenhouseLiveReadReadinessCheckId,
  status: GreenhouseLiveReadReadinessCheck["status"],
  detail: string
): GreenhouseLiveReadReadinessCheck {
  return { checkId, status, detail }
}

function countFacts(facts: GreenhouseFixtureFacts): Record<keyof GreenhouseFixtureFacts, number> {
  return {
    finalOffers: facts.finalOffers.length,
    rps: facts.rps.length,
    pipeline: facts.pipeline.length,
    ownership: facts.ownership.length,
  }
}
