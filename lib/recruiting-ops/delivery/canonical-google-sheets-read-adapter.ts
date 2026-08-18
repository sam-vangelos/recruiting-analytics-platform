import {
  CANONICAL_GOOGLE_SHEETS_READONLY_SCOPE,
  createGoogleWorkspaceCanonicalReadonlyBatchGetClient,
} from "./google-workspace-staging-client"
import { getCanonicalParityArtifact } from "./canonical-parity-registry"
import type { ParityCellValue } from "./canonical-parity-comparison"
import type {
  CanonicalSheetParityReadPort,
  CanonicalSheetParityReadRequest,
  CanonicalSheetParityReadResult,
} from "./staging-sheet-acceptance-runner"
import { getStagingSheetContract } from "./staging-sheet-contracts"

export { CANONICAL_GOOGLE_SHEETS_READONLY_SCOPE }

export interface CanonicalGoogleSheetsBatchGetClient {
  batchGet(input: {
    spreadsheetId: string
    ranges: readonly string[]
    valueRenderOption: "UNFORMATTED_VALUE"
    dateTimeRenderOption: "SERIAL_NUMBER"
  }): Promise<{
    data: {
      valueRanges?: readonly {
        range?: string | null
        values?: readonly (readonly unknown[])[] | null
      }[] | null
    }
  }>
}

/**
 * Builds the only canonical Google Sheet capability used by copy acceptance.
 * It has one read method, resolves the id back through the frozen canonical
 * registry, and forwards only the exact bounded ranges supplied by the private
 * acceptance plan. There is intentionally no writer-shaped sibling API.
 */
export function createCanonicalGoogleSheetsReadPort(
  client: CanonicalGoogleSheetsBatchGetClient
): CanonicalSheetParityReadPort {
  return Object.freeze({
    async readCanonicalRanges(
      input: CanonicalSheetParityReadRequest
    ): Promise<CanonicalSheetParityReadResult> {
      const baseline = getCanonicalParityArtifact(input.artifactKey)
      if (
        input.readOnly !== true ||
        baseline.kind !== "google_sheet" ||
        baseline.readOnly !== true ||
        baseline.writeEligible !== false ||
        input.canonicalArtifactId !== baseline.artifactId ||
        input.ranges.length === 0
      ) {
        throw new Error("Canonical Sheet read is not bound to the exact read-only registry baseline.")
      }

      const seenSurfaceIds = new Set<string>()
      const requestedRanges = input.ranges.map((range) => {
        const contract = getStagingSheetContract(range.surfaceId)
        const shape = parseBoundedA1(range.canonicalA1Range)
        if (
          contract.artifactKey !== input.artifactKey ||
          contract.sheetTitle !== shape.sheetTitle ||
          seenSurfaceIds.has(range.surfaceId) ||
          !sameA1Range(range.copiedA1Range, range.canonicalA1Range) ||
          range.rowCount !== shape.rows ||
          range.columnCount !== shape.columns
        ) {
          throw new Error("Canonical Sheet read request has incomplete or inconsistent range coverage.")
        }
        seenSurfaceIds.add(range.surfaceId)
        return range.canonicalA1Range
      })

      const response = await client.batchGet({
        spreadsheetId: baseline.artifactId,
        ranges: requestedRanges,
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      })
      const returned = response.data.valueRanges ?? []
      if (returned.length !== input.ranges.length) {
        throw new Error("Canonical Sheet read did not return every exact requested range.")
      }

      return {
        canonicalArtifactId: baseline.artifactId,
        readOnly: true,
        surfaces: input.ranges.map((request, index) => {
          const responseRange = returned[index]?.range?.trim()
          const values = returned[index]?.values ?? []
          if (
            !responseRange ||
            !sameA1Range(responseRange, request.canonicalA1Range) ||
            values.length > request.rowCount ||
            values.some((row) => row.length > request.columnCount)
          ) {
            throw new Error("Canonical Sheet read did not prove exact requested range coverage.")
          }
          return {
            surfaceId: request.surfaceId,
            canonicalA1Range: responseRange,
            values: values.map((row) => row.map(parityCell)),
          }
        }),
      }
    },
  })
}

/**
 * Live GCP binding. ADC may impersonate only the already-approved copy writer
 * principal, but the delegated token has the Sheets read-only scope. The
 * returned object still exposes only the narrow canonical read port above.
 */
export async function createLiveCanonicalGoogleSheetsReadPort(
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<CanonicalSheetParityReadPort> {
  return createCanonicalGoogleSheetsReadPort(
    await createGoogleWorkspaceCanonicalReadonlyBatchGetClient({ env })
  )
}

function parityCell(value: unknown): ParityCellValue {
  if (value === undefined || value === null || value === "") return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  throw new Error("Canonical Sheet read returned an unsupported cell type.")
}

function sameA1Range(left: string, right: string): boolean {
  const a = parseBoundedA1(left)
  const b = parseBoundedA1(right)
  return (
    a.sheetTitle === b.sheetTitle &&
    a.startColumn === b.startColumn &&
    a.startRow === b.startRow &&
    a.endColumn === b.endColumn &&
    a.endRow === b.endRow
  )
}

function parseBoundedA1(range: string): {
  sheetTitle: string
  startColumn: number
  startRow: number
  endColumn: number
  endRow: number
  rows: number
  columns: number
} {
  const separator = range.lastIndexOf("!")
  if (separator <= 0) throw new Error("Canonical parity requires a sheet-qualified range.")
  const rawTitle = range.slice(0, separator).trim()
  const sheetTitle = rawTitle.startsWith("'") ? unquoteSheetTitle(rawTitle) : rawTitle
  const coordinates = range.slice(separator + 1).replaceAll("$", "").toUpperCase()
  const match = coordinates.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/)
  if (!sheetTitle || !match) throw new Error("Canonical parity requires an exact bounded range.")
  const startColumn = columnIndex(match[1])
  const startRow = Number(match[2])
  const endColumn = columnIndex(match[3] ?? match[1])
  const endRow = Number(match[4] ?? match[2])
  if (
    !Number.isSafeInteger(startRow) ||
    !Number.isSafeInteger(endRow) ||
    startRow <= 0 ||
    endRow < startRow ||
    endColumn < startColumn
  ) {
    throw new Error("Canonical parity range bounds are invalid.")
  }
  return {
    sheetTitle,
    startColumn,
    startRow,
    endColumn,
    endRow,
    rows: endRow - startRow + 1,
    columns: endColumn - startColumn + 1,
  }
}

function unquoteSheetTitle(value: string): string {
  if (value.length < 2 || !value.endsWith("'")) {
    throw new Error("Canonical parity has a malformed quoted sheet title.")
  }
  return value.slice(1, -1).replaceAll("''", "'")
}

function columnIndex(label: string): number {
  let index = 0
  for (const character of label) index = index * 26 + character.charCodeAt(0) - 64
  return index - 1
}
