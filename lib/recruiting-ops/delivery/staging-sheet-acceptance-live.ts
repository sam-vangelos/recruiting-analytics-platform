import { PII_FINGERPRINT_SALT_ENV } from "../checksums"
import { readKillSwitchStates } from "../durable-safety-store"
import type {
  createLivePinnedStagingSheetAcceptanceCutLoader,
} from "../delivery-source/staging-sheet-acceptance-source-loader"
import { createSupabaseSafetyStoreClient } from "../supabase-safety-store-client"
import {
  createLiveCanonicalGoogleSheetsReadPort,
} from "./canonical-google-sheets-read-adapter"
import {
  createGoogleWorkspaceStagingClients,
} from "./google-workspace-staging-client"
import { getStagingArtifact } from "./staging-artifact-registry"
import type { StagingSheetArtifactKey } from "./staging-artifact-value-planner"
import {
  runStagingSheetAcceptance,
  type StagingSheetAcceptanceOutcome,
} from "./staging-sheet-acceptance-runner"

export interface RunLiveStagingSheetAcceptanceInput {
  artifactKey: StagingSheetArtifactKey
  env?: Readonly<Record<string, string | undefined>>
  nowMs?: number
}

export interface LiveStagingSheetAcceptanceDependencies {
  createStagingClients: typeof createGoogleWorkspaceStagingClients
  createCanonicalReadPort: typeof createLiveCanonicalGoogleSheetsReadPort
  createPinnedCutLoader: typeof createLivePinnedStagingSheetAcceptanceCutLoader
  createSafetyStoreClient: typeof createSupabaseSafetyStoreClient
  readSafetyStates: typeof readKillSwitchStates
  runAcceptance: typeof runStagingSheetAcceptance
}

const defaultDependencies: LiveStagingSheetAcceptanceDependencies = {
  createStagingClients: createGoogleWorkspaceStagingClients,
  createCanonicalReadPort: createLiveCanonicalGoogleSheetsReadPort,
  createPinnedCutLoader: () => {
    throw new Error("Direct live acceptance source loading is retired; use a persisted orchestration cut.")
  },
  createSafetyStoreClient: createSupabaseSafetyStoreClient,
  readSafetyStates: readKillSwitchStates,
  runAcceptance: runStagingSheetAcceptance,
}

/**
 * GCP entry point for a complete acceptance transaction on one copied Sheet.
 * The fingerprint salt comes only from the process environment, canonical
 * access is represented by a read-only port, and durable kill-switch state is
 * re-read immediately before each guarded copied-sheet write.
 */
export async function runLiveStagingSheetAcceptance(
  input: RunLiveStagingSheetAcceptanceInput,
  dependencies: Partial<LiveStagingSheetAcceptanceDependencies> = {}
): Promise<StagingSheetAcceptanceOutcome> {
  const deps = { ...defaultDependencies, ...dependencies }
  const env = input.env ?? process.env
  const fingerprintKey = env[PII_FINGERPRINT_SALT_ENV]?.trim()
  if (!fingerprintKey) {
    throw new Error(`Live copy acceptance requires ${PII_FINGERPRINT_SALT_ENV}.`)
  }

  const target = getStagingArtifact(input.artifactKey)
  if (target.kind !== "google_sheet") {
    throw new Error("Live copy acceptance requires one explicitly registered Sheet copy.")
  }

  const [clients, canonical] = await Promise.all([
    deps.createStagingClients({ env }),
    deps.createCanonicalReadPort(env),
  ])
  const safetyStore = deps.createSafetyStoreClient()
  const loadPinnedCut = deps.createPinnedCutLoader({ nowMs: input.nowMs })

  return deps.runAcceptance({
    artifactKey: input.artifactKey,
    fingerprintKey,
    ports: {
      clients,
      canonical,
      loadPinnedCut,
      loadKillSwitchStates: () => deps.readSafetyStates(safetyStore),
    },
    env,
    nowMs: input.nowMs,
  })
}
