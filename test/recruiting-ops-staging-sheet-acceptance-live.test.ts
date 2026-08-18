import { describe, expect, test, vi } from "vitest"

import { PII_FINGERPRINT_SALT_ENV } from "../lib/recruiting-ops/checksums"
import type { SafetyStoreDatabaseClient } from "../lib/recruiting-ops/durable-safety-store"
import type { GoogleWorkspaceStagingClients } from "../lib/recruiting-ops/delivery/google-workspace-staging-client"
import {
  runLiveStagingSheetAcceptance,
  type LiveStagingSheetAcceptanceDependencies,
} from "../lib/recruiting-ops/delivery/staging-sheet-acceptance-live"
import type {
  CanonicalSheetParityReadPort,
  PinnedStagingSheetAcceptanceCut,
  RunStagingSheetAcceptanceInput,
  StagingSheetAcceptanceOutcome,
} from "../lib/recruiting-ops/delivery/staging-sheet-acceptance-runner"

const NOW = Date.parse("2026-07-11T12:00:00.000Z")
const SECRET = "live-acceptance-fingerprint-secret"

describe("live one-Sheet staging acceptance integration", () => {
  test("injects the environment fingerprint secret internally and exposes only read ports for canonicals", async () => {
    const clients = {} as GoogleWorkspaceStagingClients
    const canonical = Object.freeze({
      readCanonicalRanges: vi.fn(),
    }) as unknown as CanonicalSheetParityReadPort
    const safetyStore = {} as SafetyStoreDatabaseClient
    const pinnedLoader = vi.fn(async () => ({} as PinnedStagingSheetAcceptanceCut))
    const createStagingClients = vi.fn(async () => clients)
    const createCanonicalReadPort = vi.fn(async () => canonical)
    const createPinnedCutLoader = vi.fn(() => pinnedLoader)
    const createSafetyStoreClient = vi.fn(() => safetyStore)
    const readSafetyStates = vi.fn(async () => [])
    const runAcceptance = vi.fn(async (input: RunStagingSheetAcceptanceInput) => {
      expect(input.fingerprintKey).toBe(SECRET)
      expect(input.ports.clients).toBe(clients)
      expect(Object.keys(input.ports.canonical)).toEqual(["readCanonicalRanges"])
      expect(input.ports.loadPinnedCut).toBe(pinnedLoader)
      await input.ports.loadKillSwitchStates()
      await input.ports.loadKillSwitchStates()
      return acceptedOutcome()
    })
    const dependencies = {
      createStagingClients,
      createCanonicalReadPort,
      createPinnedCutLoader,
      createSafetyStoreClient,
      readSafetyStates,
      runAcceptance,
    } as unknown as Partial<LiveStagingSheetAcceptanceDependencies>

    const outcome = await runLiveStagingSheetAcceptance({
      artifactKey: "all_hires",
      env: { [PII_FINGERPRINT_SALT_ENV]: `  ${SECRET}  ` },
      nowMs: NOW,
    }, dependencies)

    expect(outcome.status).toBe("accepted")
    expect(createStagingClients).toHaveBeenCalledWith({
      env: { [PII_FINGERPRINT_SALT_ENV]: `  ${SECRET}  ` },
    })
    expect(createCanonicalReadPort).toHaveBeenCalledWith({
      [PII_FINGERPRINT_SALT_ENV]: `  ${SECRET}  `,
    })
    expect(createPinnedCutLoader).toHaveBeenCalledWith({ nowMs: NOW })
    expect(readSafetyStates).toHaveBeenCalledTimes(2)
    expect(readSafetyStates).toHaveBeenNthCalledWith(1, safetyStore)
    expect(JSON.stringify(outcome)).not.toContain(SECRET)
  })

  test("fails before any source, Google, or safety-store access without the required environment secret", async () => {
    const createStagingClients = vi.fn()
    const createCanonicalReadPort = vi.fn()
    const createPinnedCutLoader = vi.fn()
    const createSafetyStoreClient = vi.fn()

    await expect(runLiveStagingSheetAcceptance({
      artifactKey: "all_hires",
      env: {},
    }, {
      createStagingClients,
      createCanonicalReadPort,
      createPinnedCutLoader,
      createSafetyStoreClient,
    } as unknown as Partial<LiveStagingSheetAcceptanceDependencies>)).rejects.toThrow(
      PII_FINGERPRINT_SALT_ENV
    )
    expect(createStagingClients).not.toHaveBeenCalled()
    expect(createCanonicalReadPort).not.toHaveBeenCalled()
    expect(createPinnedCutLoader).not.toHaveBeenCalled()
    expect(createSafetyStoreClient).not.toHaveBeenCalled()
  })

  test("rejects the ELT Doc at the live integration boundary before creating clients", async () => {
    const createStagingClients = vi.fn()
    const createCanonicalReadPort = vi.fn()

    await expect(runLiveStagingSheetAcceptance({
      artifactKey: "elt_doc" as never,
      env: { [PII_FINGERPRINT_SALT_ENV]: SECRET },
    }, {
      createStagingClients,
      createCanonicalReadPort,
    } as unknown as Partial<LiveStagingSheetAcceptanceDependencies>)).rejects.toThrow(
      "registered Sheet copy"
    )
    expect(createStagingClients).not.toHaveBeenCalled()
    expect(createCanonicalReadPort).not.toHaveBeenCalled()
  })
})

function acceptedOutcome(): StagingSheetAcceptanceOutcome {
  return {
    artifactKey: "all_hires",
    status: "accepted",
    copyOnly: false,
    canonicalWriteAuthorized: true,
    sourceGeneratedAt: "2026-07-11T12:00:00.000Z",
    reportingWeekFriday: "2026-07-03",
    quarterStart: "2026-07-01",
  }
}
