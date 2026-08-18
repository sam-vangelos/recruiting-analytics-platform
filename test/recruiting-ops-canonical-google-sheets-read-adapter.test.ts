import { describe, expect, test, vi } from "vitest"

import {
  CANONICAL_GOOGLE_SHEETS_READONLY_SCOPE,
  createCanonicalGoogleSheetsReadPort,
  type CanonicalGoogleSheetsBatchGetClient,
} from "../lib/recruiting-ops/delivery/canonical-google-sheets-read-adapter"
import { getCanonicalParityArtifact } from "../lib/recruiting-ops/delivery/canonical-parity-registry"
import type { CanonicalSheetParityReadRequest } from "../lib/recruiting-ops/delivery/staging-sheet-acceptance-runner"

const canonicalId = getCanonicalParityArtifact("all_hires").artifactId
const request: CanonicalSheetParityReadRequest = {
  artifactKey: "all_hires",
  canonicalArtifactId: canonicalId,
  readOnly: true,
  ranges: [{
    surfaceId: "all_hires_data",
    copiedA1Range: "'Data sheet'!A2:I2",
    canonicalA1Range: "'Data sheet'!A2:I2",
    rowCount: 1,
    columnCount: 9,
  }],
}

describe("read-only canonical Google Sheets adapter", () => {
  test("has only a read-only scope and batchGets the exact registry id and requested ranges", async () => {
    const batchGet = vi.fn(async () => ({
      data: {
        valueRanges: [{
          range: "'Data sheet'!$A$2:$I$2",
          values: [["Private candidate", "Role", null, 1, true]],
        }],
      },
    }))
    const port = createCanonicalGoogleSheetsReadPort({ batchGet })

    const result = await port.readCanonicalRanges(request)

    expect(CANONICAL_GOOGLE_SHEETS_READONLY_SCOPE).toBe(
      "https://www.googleapis.com/auth/spreadsheets.readonly"
    )
    expect(Object.keys(port)).toEqual(["readCanonicalRanges"])
    expect(batchGet).toHaveBeenCalledWith({
      spreadsheetId: canonicalId,
      ranges: ["'Data sheet'!A2:I2"],
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    })
    expect(result).toMatchObject({
      canonicalArtifactId: canonicalId,
      readOnly: true,
      surfaces: [{
        surfaceId: "all_hires_data",
        canonicalA1Range: "'Data sheet'!$A$2:$I$2",
      }],
    })
  })

  test("rejects a caller-supplied id instead of reading outside the exact canonical registry", async () => {
    const batchGet = vi.fn()
    const port = createCanonicalGoogleSheetsReadPort({ batchGet } as CanonicalGoogleSheetsBatchGetClient)

    await expect(port.readCanonicalRanges({
      ...request,
      canonicalArtifactId: "caller-supplied-sheet-id",
    })).rejects.toThrow("exact read-only registry")
    expect(batchGet).not.toHaveBeenCalled()
  })

  test("rejects cross-artifact surfaces and mismatched copied/canonical ranges before Google access", async () => {
    const batchGet = vi.fn()
    const port = createCanonicalGoogleSheetsReadPort({ batchGet } as CanonicalGoogleSheetsBatchGetClient)

    await expect(port.readCanonicalRanges({
      ...request,
      ranges: [{
        ...request.ranges[0],
        surfaceId: "rps_data_dump",
      }],
    })).rejects.toThrow("incomplete or inconsistent")
    await expect(port.readCanonicalRanges({
      ...request,
      ranges: [{
        ...request.ranges[0],
        canonicalA1Range: "'Data sheet'!A3:I3",
      }],
    })).rejects.toThrow("incomplete or inconsistent")
    expect(batchGet).not.toHaveBeenCalled()
  })

  test("fails closed on incomplete or wrong-range Google responses without logging private cells or errors", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const batchGet = vi.fn(async () => ({
      data: {
        valueRanges: [{
          range: "'Data sheet'!A3:I3",
          values: [["Private candidate"]],
        }],
      },
    }))
    const port = createCanonicalGoogleSheetsReadPort({ batchGet })

    await expect(port.readCanonicalRanges(request)).rejects.toThrow("exact requested range coverage")
    expect(log).not.toHaveBeenCalled()
    expect(errorLog).not.toHaveBeenCalled()
    log.mockRestore()
    errorLog.mockRestore()
  })
})
