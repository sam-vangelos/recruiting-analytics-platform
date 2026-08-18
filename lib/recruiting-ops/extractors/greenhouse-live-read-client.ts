import { greenhouseGet, greenhouseGetWithCursor } from "../../greenhouse-client"
import {
  createGreenhouseHarvestReadBoundary,
  type GreenhouseHarvestEndpoint,
  type GreenhouseHarvestListParams,
  type GreenhouseHarvestReadAdapterOptions,
  type GreenhouseHarvestReadClient,
} from "./greenhouse-harvest-read-adapter"
import type { GreenhouseReadBoundary } from "./greenhouse-read-boundary"

/**
 * LIVE Harvest v3 read client — the C1 bridge from the command center to the app's
 * OAuth2 client (token cache + refresh, cursor pagination, 429 retry, revoked-token
 * recovery, sanitized errors all live in lib/greenhouse-client.ts).
 *
 * Govern-by-reversibility: READS carry no activation ceremony — no env gate, no
 * approval flow. Every irreversible surface (send/write) keeps its gates; this
 * client can only GET. A record cap bounds each pull so an unfiltered endpoint
 * cannot run away with the org's whole history.
 */

export interface LiveGreenhouseHarvestReadClientOptions {
  /** Hard cap per endpoint pull; cursor-following stops once reached. */
  maxRecordsPerEndpoint?: number
  /** Public-safe progress logging (endpoint + counts only — never record content). */
  log?: (message: string) => void
}

const DEFAULT_MAX_RECORDS_PER_ENDPOINT = 5000

export function createLiveGreenhouseHarvestReadClient(
  options: LiveGreenhouseHarvestReadClientOptions = {}
): GreenhouseHarvestReadClient {
  const maxRecords = options.maxRecordsPerEndpoint ?? DEFAULT_MAX_RECORDS_PER_ENDPOINT
  if (!Number.isFinite(maxRecords) || maxRecords <= 0) {
    throw new Error("maxRecordsPerEndpoint must be a positive finite number")
  }
  const log = options.log ?? (() => {})

  return {
    async list<T>(
      endpoint: GreenhouseHarvestEndpoint,
      params?: GreenhouseHarvestListParams
    ): Promise<readonly T[]> {
      const records: T[] = []
      let page = await greenhouseGet<T[]>(endpoint, params)
      records.push(...page.data)
      let pageCount = 1
      while (page.nextCursor && records.length < maxRecords) {
        page = await greenhouseGetWithCursor<T[]>(endpoint, page.nextCursor)
        records.push(...page.data)
        pageCount += 1
      }
      const truncated = records.length > maxRecords
      const result = truncated ? records.slice(0, maxRecords) : records
      log(
        `[recruiting-ops live-read] ${endpoint}: ${result.length} record(s) across ${pageCount} page(s)` +
          (truncated || (page.nextCursor && records.length >= maxRecords)
            ? ` (capped at ${maxRecords}; more pages exist)`
            : "")
      )
      return result
    },
  }
}

/**
 * Live read boundary: the harvest adapter's endpoint plans + field mappings over the
 * live client. Drop-in for any `GreenhouseReadBoundary` consumer (workflow runner,
 * shadow modules) — the fixture boundary remains the default for tests.
 */
export function createLiveGreenhouseReadBoundary(
  options: GreenhouseHarvestReadAdapterOptions & LiveGreenhouseHarvestReadClientOptions = {}
): GreenhouseReadBoundary {
  const { maxRecordsPerEndpoint, log, ...adapterOptions } = options
  return createGreenhouseHarvestReadBoundary(
    createLiveGreenhouseHarvestReadClient({ maxRecordsPerEndpoint, log }),
    adapterOptions
  )
}
