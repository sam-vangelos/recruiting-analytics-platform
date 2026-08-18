import { Impersonated } from "google-auth-library"
import { google, type docs_v1, type drive_v3, type sheets_v4 } from "googleapis"

import { createPayloadFingerprint, createPiiFingerprint, stableSerialize } from "../checksums"
import { redactPublicText } from "../safe-public-output"
import {
  certifyEltDocFactTablePostimage,
  eltDocArchiveBoundaryStartIndexes,
  eltDocTabTopologyIsExact,
  findEltDocTab,
  fingerprintEltDocContentRange,
  fingerprintEltDocDocumentContent,
  fingerprintEltDocOutsideContent,
  type EltDocDryRunPrivatePlan,
  type GoogleDocsDocumentSnapshot,
} from "./elt-doc-dry-run"
import {
  buildEltDocBatchUpdateRequests,
  buildEltDocRollbackRequests,
  eltDocPreMutationRange,
} from "./elt-doc-staging-requests"
import { P1_ELT_DOC_TARGET, eltDocTargetConflicts } from "./p1-artifacts"
import {
  getStagingArtifact,
  requireStagingMutationTarget,
  stagingHydrationEnabled,
  type StagingArtifactKey,
} from "./staging-artifact-registry"
import { assertStagingWritePermit, type StagingWritePermit } from "./staging-write-permit"
import {
  sheetStructureRowsPerRead,
  SHEET_STRUCTURE_CELL_FIELDS,
  SHEET_STRUCTURE_COLUMN_METADATA_FIELDS,
  SHEET_STRUCTURE_MAX_CELLS_PER_READ,
  SHEET_STRUCTURE_METADATA_FIELDS,
  SheetStructureSnapshotAccumulator,
  sheetStructureCellCoordinateKey,
  type SheetStructureCellRange,
  type SheetStructureSnapshot,
} from "./sheet-structure-snapshot"
import {
  projectStagingStructuralNormalizationState,
  stagingStructuralNormalizationLiteralRanges,
  verifyStagingStructuralNormalizationAfter,
  type StagingStructuralLiteralObservationRange,
  type SheetsApiSpreadsheetSnapshot,
} from "./staging-structural-normalization-observer"
import {
  DELIVERY_RPS_DATED_GRID_ROW_COUNT,
  deliveryRpsTargetSheetId,
  planStagingStructuralNormalization,
  type GoogleSheetsRequestData,
  type StagingStructuralNormalizationSpec,
} from "./staging-structural-normalization"
import {
  RPS_AUTOMATED_CLEAN_TITLE,
  RPS_AUTOMATED_SURFACE_SPREADSHEET_ID,
  RPS_AUTOMATED_SUMMARY_TITLE,
  rpsAutomatedSurfaceCreationRequests,
  rpsAutomatedSurfaceDeletionRequests,
  type RpsAutomatedSurfaceAdapter,
} from "./rps-automated-surfaces"
import {
  assertStagingStructuralWritePermit,
  type StagingStructuralWritePermit,
} from "./staging-structural-write-permit"
import {
  normalizeStagingSheetScalar,
  type PlannedSheetRangeWrite,
  type SheetCellValue,
  type StagingSheetValuePlan,
} from "./staging-value-plan"
import { paceStagingSheetsRead } from "./staging-sheets-read-pacer"

export const RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT =
  "recops-sheets-writer@example-project.iam.gserviceaccount.com"
export const RECRUITING_OPS_ELT_DOC_OWNER = "doc-owner@example.com"

export const RECRUITING_OPS_GOOGLE_TARGET_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
] as const

const GOOGLE_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

/** Canonical comparison tokens are cryptographically incapable of Sheet writes. */
export const CANONICAL_GOOGLE_SHEETS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets.readonly"

/** Literal members are requested only through spec-derived numeric ranges. */
export const STAGING_STRUCTURAL_LITERAL_CELL_FIELDS =
  "sheets(properties(sheetId),data(startRow,startColumn,rowData(values(note,userEnteredValue(stringValue,numberValue,boolValue)))))"

const STAGING_STRUCTURAL_CONSISTENCY_MAXIMUM_ATTEMPTS = 6
const STAGING_STRUCTURAL_CONSISTENCY_BASE_DELAY_MS = 100
const STAGING_STRUCTURAL_CONSISTENCY_MAX_DELAY_MS = 1_000
// 29 attempts wait 10m21.1s before the final read, covering the observed
// delayed Drive revision publication without widening preflight/recovery waits.
const STAGING_RESOLVED_SETTLEMENT_MAXIMUM_ATTEMPTS = 29
const STAGING_RESOLVED_SETTLEMENT_MAX_DELAY_MS = 30_000
const STAGING_VALUE_MAXIMUM_TYPED_CELLS = 200_000
const STAGING_VALUE_MAXIMUM_MUTATION_REQUESTS = 5_000
const STAGING_VALUE_MAXIMUM_MUTATION_BYTES = 1_800_000
const DELIVERY_RPS_REPORT_FORMAT_END_COLUMN_INDEX = 14
// The two legacy ledger tabs and their date columns. Appended rows land below
// whatever the sheet was last formatted to, so the date serials this writer
// publishes would display as raw numbers unless the same mutation that writes
// them also carries their number format. Declaring the columns value-owned is
// what lets that format change without reading as non-approved structure drift.
const DELIVERY_RPS_RAW_LEDGER_SHEET_ID = 1_072_762_955
const DELIVERY_RPS_CLEAN_LEDGER_SHEET_ID = 1_598_905_318
const DELIVERY_RPS_RAW_LEDGER_TITLE = "Raw_Daily_RPS"
const DELIVERY_RPS_CLEAN_LEDGER_TITLE = "Cleaned_RPS"
const DELIVERY_RPS_RAW_DATE_COLUMN_INDEX = 10
const DELIVERY_RPS_CLEAN_DATE_START_COLUMN_INDEX = 8
const DELIVERY_RPS_CLEAN_DATE_END_COLUMN_INDEX = 10
const DELIVERY_RPS_LEDGER_FORMAT_END_ROW_INDEX = 5_000
const DELIVERY_RPS_RAW_DATE_NUMBER_FORMAT: sheets_v4.Schema$NumberFormat = {
  type: "DATE",
  pattern: "d mmmm yyyy",
}
// Cleaned_RPS carries a bare DATE on its most recent rows and a patterned one on
// older history; the runway check requires only the type, so appended rows adopt
// the bare form and no existing row's display is rewritten.
const DELIVERY_RPS_CLEAN_DATE_NUMBER_FORMAT: sheets_v4.Schema$NumberFormat = {
  type: "DATE",
}
const ALL_HIRES_DATA_SHEET_ID = 1_324_142_221
const ALL_HIRES_DATA_SHEET_TITLE = "Data sheet"
// Accepted Date (D) and Start Date (G). All Hires' first automation-written row
// landed as raw serials (46241/46273) beside human rows reading "Jul 14, 2026",
// because nothing had ever appended below the last hand-formatted row.
const ALL_HIRES_DATE_NUMBER_FORMAT: sheets_v4.Schema$NumberFormat = {
  type: "DATE",
  pattern: "mmm d, yyyy",
}

interface AppendDateFormatColumnSpec {
  rangeId: string
  sheetId: number
  sheetTitle: string
  startColumnIndex: number
  endColumnIndex: number
  numberFormat: sheets_v4.Schema$NumberFormat
  /** Grid row index of the range's first value row (all are header-row-1 sheets). */
  firstRowIndex: number
}

/**
 * Date columns whose display each artifact's write owns. A date serial written
 * into a cell with no number format renders as a five-digit number, and
 * appended rows always land below whatever the sheet was last formatted to --
 * so the format has to travel in the same mutation as the value. Declaring the
 * columns here feeds three places that must agree: the planning-time and
 * write-time structure reads (value-owned exclusion) and the write's own
 * gap-gated format requests.
 */
const APPEND_DATE_FORMAT_COLUMNS: Readonly<Record<string, readonly AppendDateFormatColumnSpec[]>> = {
  delivery_roles_rps: [
    {
      rangeId: "delivery_rps_raw",
      sheetId: DELIVERY_RPS_RAW_LEDGER_SHEET_ID,
      sheetTitle: DELIVERY_RPS_RAW_LEDGER_TITLE,
      startColumnIndex: DELIVERY_RPS_RAW_DATE_COLUMN_INDEX,
      endColumnIndex: DELIVERY_RPS_RAW_DATE_COLUMN_INDEX + 1,
      numberFormat: DELIVERY_RPS_RAW_DATE_NUMBER_FORMAT,
      firstRowIndex: 1,
    },
    {
      rangeId: "delivery_rps_clean",
      sheetId: DELIVERY_RPS_CLEAN_LEDGER_SHEET_ID,
      sheetTitle: DELIVERY_RPS_CLEAN_LEDGER_TITLE,
      startColumnIndex: DELIVERY_RPS_CLEAN_DATE_START_COLUMN_INDEX,
      endColumnIndex: DELIVERY_RPS_CLEAN_DATE_END_COLUMN_INDEX,
      numberFormat: DELIVERY_RPS_CLEAN_DATE_NUMBER_FORMAT,
      firstRowIndex: 1,
    },
  ],
  all_hires: [
    {
      rangeId: "all_hires_data",
      sheetId: ALL_HIRES_DATA_SHEET_ID,
      sheetTitle: ALL_HIRES_DATA_SHEET_TITLE,
      startColumnIndex: 3,
      endColumnIndex: 4,
      numberFormat: ALL_HIRES_DATE_NUMBER_FORMAT,
      firstRowIndex: 1,
    },
    {
      rangeId: "all_hires_data",
      sheetId: ALL_HIRES_DATA_SHEET_ID,
      sheetTitle: ALL_HIRES_DATA_SHEET_TITLE,
      startColumnIndex: 6,
      endColumnIndex: 7,
      numberFormat: ALL_HIRES_DATE_NUMBER_FORMAT,
      firstRowIndex: 1,
    },
  ],
}
const DELIVERY_RPS_REPORT_SECTION_LABELS = [
  "Summary by Team",
  "Summary by Submitter",
  "Match / Mismatch Check",
  "Role-Level Detail",
  "Raw Detail",
] as const
const DELIVERY_RPS_REPORT_HEADERS = [
  ["Team", "Total RPS", "Match", "Mismatch", "Strong Yes", "Yes", "No", "Other"],
  ["Submitter", "Total RPS", "Match", "Mismatch", "Strong Yes", "Yes", "No", "Other"],
  ["Match Status", "Count"],
  ["Requisition ID", "Job Name", "Total RPS", "Submitters", "Recruiters", "Sourcers"],
  [
    "Candidate", "Job", "Req ID", "Status", "Submitter", "Submitter Team", "Interview",
    "Interviewer", "Recommendation", "Match/Mismatch", "Recruiters", "Sourcers", "Week",
    "Key Takeaways",
  ],
] as const
const DELIVERY_RPS_BASE_CELL_FORMAT: sheets_v4.Schema$CellFormat = {
  borders: {
    top: solidBlackBorder(),
    bottom: solidBlackBorder(),
    left: solidBlackBorder(),
    right: solidBlackBorder(),
  },
  verticalAlignment: "TOP",
  wrapStrategy: "WRAP",
}
const DELIVERY_RPS_HEADER_CELL_FORMAT: sheets_v4.Schema$CellFormat = {
  backgroundColor: {
    red: 0.8509804,
    green: 0.91764706,
    blue: 0.827451,
  },
  ...DELIVERY_RPS_BASE_CELL_FORMAT,
  textFormat: { bold: true },
  backgroundColorStyle: {
    rgbColor: {
      red: 0.8509804,
      green: 0.91764706,
      blue: 0.827451,
    },
  },
}

/**
 * Observed on the copied Weekly Recruitment workbook: when Sheets detects a
 * URL in a previously blank cell, it persists the workbook default font next
 * to the generated link. This copy-specific allowlist prevents that exact
 * Google side effect from masquerading as concurrent format drift without
 * weakening structural checks for any other workbook or font property.
 */
const VALUE_COUPLED_AUTO_LINK_DEFAULT_TEXT_FORMAT_BY_ARTIFACT: Partial<
  Record<Exclude<StagingArtifactKey, "elt_doc">, Readonly<{ fontFamily: string; fontSize: number }>>
> = {
  weekly_recruitment: { fontFamily: "Arial", fontSize: 10 },
}

const STAGING_VALUE_CELL_FIELDS = [
  "spreadsheetId",
  "sheets(properties(sheetId,title))",
  "sheets(data(startRow,startColumn,rowData(values(userEnteredValue(stringValue,numberValue,boolValue,formulaValue),effectiveValue(stringValue,numberValue,boolValue,errorValue),userEnteredFormat(textFormat(link(uri))),textFormatRuns,chipRuns))))",
].join(",")

const STAGING_NUMBER_FORMAT_FIELDS = [
  "spreadsheetId",
  "sheets(properties(sheetId,title))",
  "sheets(data(startRow,startColumn,rowData(values(userEnteredFormat.numberFormat))))",
].join(",")

export interface GoogleWorkspaceStagingClients {
  sheets: sheets_v4.Sheets
  docs: docs_v1.Docs
  drive: drive_v3.Drive
}

export type GoogleSpreadsheet = sheets_v4.Schema$Spreadsheet
export type GoogleSheet = sheets_v4.Schema$Sheet
export type GoogleDocument = docs_v1.Schema$Document

export interface CreateGoogleWorkspaceStagingClientsOptions {
  env?: Readonly<Record<string, string | undefined>>
}

export interface GoogleWorkspaceCanonicalReadonlyBatchGetClient {
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
 * Uses Application Default Credentials only as the source credential, then
 * impersonates the dedicated writer service account for at most one hour. No
 * service-account key file is accepted or read by this boundary.
 */
export async function createGoogleWorkspaceStagingClients(
  options: CreateGoogleWorkspaceStagingClientsOptions = {}
): Promise<GoogleWorkspaceStagingClients> {
  const targetPrincipal = resolveGoogleWriterServiceAccount(options.env)
  const sourceAuth = new google.auth.GoogleAuth({ scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE] })
  const sourceClient = await sourceAuth.getClient()
  const auth = new Impersonated({
    sourceClient,
    targetPrincipal,
    targetScopes: [...RECRUITING_OPS_GOOGLE_TARGET_SCOPES],
    lifetime: 3600,
  })
  return {
    sheets: google.sheets({ version: "v4", auth }),
    docs: google.docs({ version: "v1", auth }),
    drive: google.drive({ version: "v3", auth }),
  }
}

/**
 * Mints a separate read-only token for canonical parity. The returned
 * capability exposes only values.batchGet; no canonical writer can be
 * represented by this boundary even though it reuses the approved principal
 * that is an editor of copies and a viewer of canonical artifacts.
 */
export async function createGoogleWorkspaceCanonicalReadonlyBatchGetClient(
  options: CreateGoogleWorkspaceStagingClientsOptions = {}
): Promise<GoogleWorkspaceCanonicalReadonlyBatchGetClient> {
  const sourceAuth = new google.auth.GoogleAuth({ scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE] })
  const sourceClient = await sourceAuth.getClient()
  const auth = new Impersonated({
    sourceClient,
    targetPrincipal: resolveGoogleWriterServiceAccount(options.env),
    targetScopes: [CANONICAL_GOOGLE_SHEETS_READONLY_SCOPE],
    lifetime: 3600,
  })
  const sheets = google.sheets({ version: "v4", auth })
  return Object.freeze({
    async batchGet(
      input: Parameters<GoogleWorkspaceCanonicalReadonlyBatchGetClient["batchGet"]>[0]
    ) {
      await paceStagingSheetsRead()
      return sheets.spreadsheets.values.batchGet({
        spreadsheetId: input.spreadsheetId,
        ranges: [...input.ranges],
        valueRenderOption: input.valueRenderOption,
        dateTimeRenderOption: input.dateTimeRenderOption,
      })
    },
  })
}

/**
 * Adapts an already-issued short-lived OAuth access token for local read-only
 * audits. This does not select a target or bypass the repository's guarded
 * write entry points; those still enforce their exact staging registry gates.
 */
export function createGoogleWorkspaceStagingClientsFromAccessToken(
  accessToken: string
): GoogleWorkspaceStagingClients {
  const token = accessToken.trim()
  if (!token) throw new Error("Google OAuth access token is required.")
  const auth = new google.auth.OAuth2()
  auth.setCredentials({ access_token: token })
  return {
    sheets: google.sheets({ version: "v4", auth }),
    docs: google.docs({ version: "v1", auth }),
    drive: google.drive({ version: "v3", auth }),
  }
}

export function resolveGoogleWriterServiceAccount(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const configured = env.RECOPS_GOOGLE_WRITER_SERVICE_ACCOUNT?.trim()
  if (configured && configured !== RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT) {
    throw new Error("Configured Google writer identity is not the approved recruiting-ops writer service account.")
  }
  return RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT
}

export async function readStagingDriveMetadata(
  key: StagingArtifactKey,
  clients: GoogleWorkspaceStagingClients
): Promise<drive_v3.Schema$File> {
  const target = getStagingArtifact(key)
  const response = await clients.drive.files.get({
    fileId: target.artifactId,
    supportsAllDrives: true,
    fields: "id,name,mimeType,modifiedTime,version,trashed,capabilities(canEdit,canModifyContent,canCopy)",
  })
  return response.data
}

/**
 * A structural batch can briefly publish more than one Drive version while
 * Sheets finishes exposing inserted columns and adjacent formulas. After an
 * exact zero-mutation preimage rejection, wait for that later publication
 * before allowing the orchestrator to build one fresh plan and permit.
 */
export async function waitForStagingDriveVersionAdvance(input: {
  artifactKey: Exclude<StagingArtifactKey, "elt_doc">
  clients: GoogleWorkspaceStagingClients
  minimumDriveVersionExclusive: string
}): Promise<string | null> {
  const registered = getStagingArtifact(input.artifactKey)
  for (let attempt = 0; attempt < STAGING_RESOLVED_SETTLEMENT_MAXIMUM_ATTEMPTS; attempt += 1) {
    const metadata = await readStagingDriveMetadata(input.artifactKey, input.clients)
    assertEditableStagingSheetMetadata(metadata, registered.artifactId)
    const version = requiredDriveVersion(metadata)
    if (driveVersionAdvancedBeyond(version, input.minimumDriveVersionExclusive)) {
      return version
    }
    await waitForResolvedStagingSettlementRetry(attempt)
  }
  return null
}

export async function readStagingSpreadsheet(
  key: StagingArtifactKey,
  clients: GoogleWorkspaceStagingClients,
  options: {
    includeGridData?: boolean
    fields?: string
    ranges?: readonly string[]
  } = {}
): Promise<sheets_v4.Schema$Spreadsheet> {
  const target = getStagingArtifact(key)
  if (target.kind !== "google_sheet") throw new Error(`${key} is not a registered staging spreadsheet.`)
  await paceStagingSheetsRead()
  const response = await clients.sheets.spreadsheets.get({
    spreadsheetId: target.artifactId,
    includeGridData: options.includeGridData ?? false,
    ...(options.fields ? { fields: options.fields } : {}),
    ...(options.ranges ? { ranges: [...options.ranges] } : {}),
  })
  return response.data
}

/**
 * Narrow one-time adapter for the two deterministic RPS output tabs. The only
 * target is the fixed registered copy; callers cannot supply a spreadsheet id
 * or arbitrary Sheets request.
 */
export function createGoogleWorkspaceRpsAutomatedSurfaceAdapter(
  clients: GoogleWorkspaceStagingClients
): RpsAutomatedSurfaceAdapter {
  return Object.freeze({
    async readDriveMetadata() {
      return readStagingDriveMetadata("rps_tracking", clients)
    },

    async readSpreadsheet() {
      const spreadsheet = await readStagingSpreadsheet("rps_tracking", clients, {
        fields:
          "spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount)))",
      })
      return {
        spreadsheetId: spreadsheet.spreadsheetId,
        sheets: (spreadsheet.sheets ?? []).map((sheet) => ({
          sheetId: sheet.properties?.sheetId,
          title: sheet.properties?.title,
          rowCount: sheet.properties?.gridProperties?.rowCount,
          columnCount: sheet.properties?.gridProperties?.columnCount,
          frozenRowCount: sheet.properties?.gridProperties?.frozenRowCount,
        })),
      }
    },

    async readDataDumpHeader() {
      await paceStagingSheetsRead()
      const response = await clients.sheets.spreadsheets.values.get({
        spreadsheetId: RPS_AUTOMATED_SURFACE_SPREADSHEET_ID,
        range: "'Data Dump'!A1:R1",
        valueRenderOption: "UNFORMATTED_VALUE",
      })
      return response.data.values?.[0] ?? []
    },

    async readFormulaAnchors() {
      await paceStagingSheetsRead()
      const response = await clients.sheets.spreadsheets.get({
        spreadsheetId: RPS_AUTOMATED_SURFACE_SPREADSHEET_ID,
        includeGridData: true,
        ranges: [
          `'${RPS_AUTOMATED_CLEAN_TITLE}'!A1`,
          `'${RPS_AUTOMATED_SUMMARY_TITLE}'!A1`,
        ],
        fields:
          "sheets(properties(title),data(rowData(values(userEnteredValue(formulaValue)))))",
      })
      const formulas = new Map(
        (response.data.sheets ?? []).map((sheet) => [
          sheet.properties?.title ?? "",
          sheet.data?.[0]?.rowData?.[0]?.values?.[0]?.userEnteredValue
            ?.formulaValue ?? null,
        ])
      )
      return {
        clean: formulas.get(RPS_AUTOMATED_CLEAN_TITLE) ?? null,
        summary: formulas.get(RPS_AUTOMATED_SUMMARY_TITLE) ?? null,
      }
    },

    async readValueRanges() {
      await paceStagingSheetsRead()
      const response = await clients.sheets.spreadsheets.values.batchGet({
        spreadsheetId: RPS_AUTOMATED_SURFACE_SPREADSHEET_ID,
        ranges: [
          "'Data Dump'!A:R",
          `'${RPS_AUTOMATED_CLEAN_TITLE}'!A:R`,
          `'${RPS_AUTOMATED_SUMMARY_TITLE}'!A:E`,
        ],
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      })
      const values = response.data.valueRanges ?? []
      return {
        dataDump: values[0]?.values ?? [],
        clean: values[1]?.values ?? [],
        summary: values[2]?.values ?? [],
      }
    },

    async createSurfaces(rowCount: number) {
      await clients.sheets.spreadsheets.batchUpdate({
        spreadsheetId: RPS_AUTOMATED_SURFACE_SPREADSHEET_ID,
        requestBody: {
          includeSpreadsheetInResponse: false,
          requests: [
            ...rpsAutomatedSurfaceCreationRequests(rowCount),
          ] as sheets_v4.Schema$Request[],
        },
      })
    },

    async deleteSurfaces(sheetIds: readonly number[]) {
      await clients.sheets.spreadsheets.batchUpdate({
        spreadsheetId: RPS_AUTOMATED_SURFACE_SPREADSHEET_ID,
        requestBody: {
          includeSpreadsheetInResponse: false,
          requests: [
            ...rpsAutomatedSurfaceDeletionRequests(sheetIds),
          ] as sheets_v4.Schema$Request[],
        },
      })
    },
  })
}

/**
 * Reads only cell number formats for explicit staging ranges. This narrow
 * boundary lets a value planner prove that date serials will retain the
 * audited display contract without reading or returning any literal values.
 */
export async function readStagingSheetNumberFormatRanges(
  key: Exclude<StagingArtifactKey, "elt_doc">,
  ranges: readonly string[],
  clients: GoogleWorkspaceStagingClients
): Promise<GoogleSpreadsheet> {
  const target = getStagingArtifact(key)
  if (target.kind !== "google_sheet") throw new Error(`${key} is not a registered staging spreadsheet.`)
  if (ranges.length === 0 || ranges.some((range) => !range.trim())) {
    throw new Error("Staging number-format read requires explicit non-empty ranges.")
  }
  await paceStagingSheetsRead()
  const response = await clients.sheets.spreadsheets.get({
    spreadsheetId: target.artifactId,
    ranges: [...ranges],
    includeGridData: true,
    fields: STAGING_NUMBER_FORMAT_FIELDS,
  })
  if (response.data.spreadsheetId !== target.artifactId) {
    throw new Error("Staging number-format read returned an unexpected spreadsheet.")
  }
  return response.data
}

/**
 * Reads the complete form of a registered copied spreadsheet without asking
 * googleapis/node-fetch to materialize one unbounded grid-data response. The
 * static workbook form is read once; column metadata and cell-scale form are
 * then folded into a compact snapshot through bounded, read-only numeric grid
 * filters (so unusual tab titles never affect range parsing).
 */
export async function readStagingSheetStructureSnapshot(
  key: Exclude<StagingArtifactKey, "elt_doc">,
  clients: GoogleWorkspaceStagingClients,
  options: { valueOwnedFormatRanges?: readonly SheetStructureCellRange[] } = {}
): Promise<SheetStructureSnapshot> {
  return (await readBoundedStagingSheetForm(
    key,
    clients,
    false,
    new Set(),
    options.valueOwnedFormatRanges ?? []
  )).structure
}

export function deliveryRpsValueOwnedFormatRanges(
  reportDate: string
): readonly SheetStructureCellRange[] {
  return [
    {
      sheetId: deliveryRpsTargetSheetId(reportDate),
      startRowIndex: 1,
      endRowIndex: DELIVERY_RPS_DATED_GRID_ROW_COUNT,
      startColumnIndex: 0,
      endColumnIndex: DELIVERY_RPS_REPORT_FORMAT_END_COLUMN_INDEX,
    },
    ...deliveryRpsLedgerDateFormatRanges(),
  ]
}

/**
 * The ledger date columns this writer publishes into. Ownership covers the whole
 * column below the header so an append into previously untouched rows can carry
 * its own number format; the mutation itself still touches only the rows the
 * value plan writes.
 */
export function deliveryRpsLedgerDateFormatRanges(): readonly SheetStructureCellRange[] {
  return appendDateFormatOwnedRanges("delivery_roles_rps")
}

/**
 * The owned date columns as whole-column structure ranges. Planning and write
 * must fold in the SAME ranges or their structure hashes diverge and every
 * write is refused -- both sides call this one function.
 */
export function appendDateFormatOwnedRanges(
  artifactKey: string
): readonly SheetStructureCellRange[] {
  return (APPEND_DATE_FORMAT_COLUMNS[artifactKey] ?? []).map((spec) => ({
    sheetId: spec.sheetId,
    startRowIndex: spec.firstRowIndex,
    endRowIndex: DELIVERY_RPS_LEDGER_FORMAT_END_ROW_INDEX,
    startColumnIndex: spec.startColumnIndex,
    endColumnIndex: spec.endColumnIndex,
  }))
}

export interface StagingStructuralNormalizationSnapshot {
  spreadsheet: SheetsApiSpreadsheetSnapshot
  structure: SheetStructureSnapshot
  literalRanges: readonly StagingStructuralLiteralObservationRange[]
  literalCellUpperBound: number
}

/**
 * Full copy-only structural preflight for a single exact normalization spec.
 * Whole-workbook reads contain formulas/formats/pivots but no literal values.
 * A second bounded pass overlays only the literal cells the observer consumes.
 */
export async function readStagingStructuralNormalizationSnapshot(
  spec: StagingStructuralNormalizationSpec,
  clients: GoogleWorkspaceStagingClients
): Promise<StagingStructuralNormalizationSnapshot> {
  // Proves exact registry binding and a reversible before-state contract before
  // any Google read is attempted.
  planStagingStructuralNormalization(spec, spec.expectedBefore)
  const requestedLiteralRanges = stagingStructuralNormalizationLiteralRanges(spec)
    .map((range) => validateStructuralLiteralRange(range))
  const read = await readBoundedStagingSheetForm(spec.artifactKey, clients, true)
  if (!read.spreadsheet) throw new Error("Structural observer snapshot was not retained.")

  const descriptors = new Map(
    (read.metadata.sheets ?? []).map((sheet) => {
      const descriptor = structureSheetDescriptor(sheet)
      return [descriptor.sheetId, descriptor] as const
    })
  )
  const literalRanges = requestedLiteralRanges
    // A spec may describe a deterministic sheet that is absent before and
    // present after duplication. Missing target sheets are skipped, never
    // replaced by an unscoped fallback read.
    .filter((range) => descriptors.has(range.gridRange.sheetId))
  let literalCellUpperBound = 0
  const literalReads = literalRanges.map((range) => {
    const descriptor = descriptors.get(range.gridRange.sheetId)!
    if (descriptor.title !== range.sheetTitle) {
      throw new Error("Structural literal observation range is bound to an unexpected sheet title.")
    }
    if (
      range.gridRange.endRowIndex > descriptor.rowCount ||
      range.gridRange.endColumnIndex > descriptor.columnCount
    ) {
      throw new Error("Structural literal observation range is outside the audited sheet grid.")
    }
    const estimatedCells =
      (range.gridRange.endRowIndex - range.gridRange.startRowIndex) *
      (range.gridRange.endColumnIndex - range.gridRange.startColumnIndex)
    literalCellUpperBound += estimatedCells
    return { gridRange: range.gridRange, estimatedCells }
  })

  for (const gridRanges of batchCellRanges(literalReads)) {
    await paceStagingSheetsRead()
    const response = await clients.sheets.spreadsheets.getByDataFilter({
      spreadsheetId: spec.spreadsheetId,
      fields: STAGING_STRUCTURAL_LITERAL_CELL_FIELDS,
      requestBody: {
        includeGridData: true,
        dataFilters: gridRanges.map((gridRange) => ({ gridRange })),
      },
    })
    appendLiteralObserverGridResponse(read.spreadsheet, response.data, gridRanges)
  }

  return {
    spreadsheet: read.spreadsheet as SheetsApiSpreadsheetSnapshot,
    structure: read.structure,
    literalRanges,
    literalCellUpperBound,
  }
}

async function readBoundedStagingSheetForm(
  key: Exclude<StagingArtifactKey, "elt_doc">,
  clients: GoogleWorkspaceStagingClients,
  retainObserverSpreadsheet: boolean,
  valueCoupledAutoLinkCoordinates: ReadonlySet<string> = new Set(),
  valueOwnedFormatRanges: readonly SheetStructureCellRange[] = []
): Promise<{
  metadata: GoogleSpreadsheet
  structure: SheetStructureSnapshot
  valueCoupledAutoLinkStructure?: SheetStructureSnapshot
  spreadsheet?: GoogleSpreadsheet
}> {
  const target = getStagingArtifact(key)
  if (target.kind !== "google_sheet") throw new Error(`${key} is not a registered staging spreadsheet.`)
  await paceStagingSheetsRead()
  const metadataResponse = await clients.sheets.spreadsheets.get({
    spreadsheetId: target.artifactId,
    includeGridData: false,
    fields: SHEET_STRUCTURE_METADATA_FIELDS,
  })
  const metadata = metadataResponse.data
  if (metadata.spreadsheetId !== target.artifactId) {
    throw new Error(`${key} structure response is not the registered staging spreadsheet.`)
  }
  const accumulator = new SheetStructureSnapshotAccumulator(metadata, {
    valueOwnedFormatRanges,
  })
  const valueCoupledAutoLinkAccumulator = valueCoupledAutoLinkCoordinates.size > 0
    ? new SheetStructureSnapshotAccumulator(metadata, {
        valueCoupledAutoLinkCoordinates,
        valueOwnedFormatRanges,
        ...(VALUE_COUPLED_AUTO_LINK_DEFAULT_TEXT_FORMAT_BY_ARTIFACT[key]
          ? {
              valueCoupledAutoLinkMaterializedDefaultTextFormat:
                VALUE_COUPLED_AUTO_LINK_DEFAULT_TEXT_FORMAT_BY_ARTIFACT[key],
            }
          : {}),
      })
    : undefined
  const observerSpreadsheet = retainObserverSpreadsheet
    ? cloneStructureMetadata(metadata)
    : undefined
  const sheets = (metadata.sheets ?? []).map((sheet) => structureSheetDescriptor(sheet))

  for (const gridRanges of batchGridRanges(sheets.map((sheet) => sheet.gridRange), 50)) {
    await paceStagingSheetsRead()
    const response = await clients.sheets.spreadsheets.getByDataFilter({
      spreadsheetId: target.artifactId,
      fields: SHEET_STRUCTURE_COLUMN_METADATA_FIELDS,
      requestBody: {
        includeGridData: true,
        dataFilters: gridRanges.map((gridRange) => ({ gridRange })),
      },
    })
    addStructureGridResponse(accumulator, response.data, "column_metadata")
    if (valueCoupledAutoLinkAccumulator) {
      addStructureGridResponse(valueCoupledAutoLinkAccumulator, response.data, "column_metadata")
    }
    if (observerSpreadsheet) {
      appendObserverGridResponse(observerSpreadsheet, response.data, "column_metadata")
    }
  }

  const rowRanges = sheets.flatMap((sheet) => {
    const rowsPerRead = sheetStructureRowsPerRead(sheet.columnCount)
    const ranges: Array<{ gridRange: sheets_v4.Schema$GridRange; estimatedCells: number }> = []
    for (let startRow = 0; startRow < sheet.rowCount; startRow += rowsPerRead) {
      const endRow = Math.min(sheet.rowCount, startRow + rowsPerRead)
      ranges.push({
        gridRange: {
          sheetId: sheet.sheetId,
          startRowIndex: startRow,
          endRowIndex: endRow,
          startColumnIndex: 0,
          endColumnIndex: sheet.columnCount,
        },
        estimatedCells: (endRow - startRow) * sheet.columnCount,
      })
    }
    return ranges
  })
  for (const gridRanges of batchCellRanges(rowRanges)) {
    await paceStagingSheetsRead()
    const response = await clients.sheets.spreadsheets.getByDataFilter({
      spreadsheetId: target.artifactId,
      fields: SHEET_STRUCTURE_CELL_FIELDS,
      requestBody: {
        includeGridData: true,
        dataFilters: gridRanges.map((gridRange) => ({ gridRange })),
      },
    })
    addStructureGridResponse(accumulator, response.data, "cell_form")
    if (valueCoupledAutoLinkAccumulator) {
      addStructureGridResponse(valueCoupledAutoLinkAccumulator, response.data, "cell_form")
    }
    if (observerSpreadsheet) appendObserverGridResponse(observerSpreadsheet, response.data, "cell_form")
  }
  return {
    metadata,
    structure: accumulator.finish(),
    ...(valueCoupledAutoLinkAccumulator
      ? { valueCoupledAutoLinkStructure: valueCoupledAutoLinkAccumulator.finish() }
      : {}),
    ...(observerSpreadsheet ? { spreadsheet: observerSpreadsheet } : {}),
  }
}

function cloneStructureMetadata(metadata: GoogleSpreadsheet): GoogleSpreadsheet {
  const clone = structuredClone(metadata)
  for (const sheet of clone.sheets ?? []) delete sheet.data
  return clone
}

function appendObserverGridResponse(
  observer: GoogleSpreadsheet,
  response: GoogleSpreadsheet,
  kind: "column_metadata" | "cell_form"
): void {
  const observerSheets = new Map(
    (observer.sheets ?? []).map((sheet) => [sheet.properties?.sheetId, sheet] as const)
  )
  for (const responseSheet of response.sheets ?? []) {
    const sheetId = responseSheet.properties?.sheetId
    if (!Number.isInteger(sheetId)) {
      throw new Error("Bounded structural observer response omitted its sheet id.")
    }
    const target = observerSheets.get(sheetId)
    if (!target) throw new Error("Bounded structural observer response referenced an unknown sheet id.")
    const data = (responseSheet.data ?? []).map((grid) => {
      assertNoLiteralPayloadInStructuralGrid(grid)
      if (kind === "column_metadata") {
        return {
          ...(grid.startColumn === undefined ? {} : { startColumn: grid.startColumn }),
          ...(grid.columnMetadata === undefined
            ? {}
            : { columnMetadata: structuredClone(grid.columnMetadata) }),
        }
      }
      return {
        ...(grid.startRow === undefined ? {} : { startRow: grid.startRow }),
        ...(grid.startColumn === undefined ? {} : { startColumn: grid.startColumn }),
        ...(grid.rowMetadata === undefined ? {} : { rowMetadata: structuredClone(grid.rowMetadata) }),
        ...(grid.rowData === undefined
          ? {}
          : {
              rowData: grid.rowData.map((row) => ({
                ...(row.values === undefined
                  ? {}
                  : {
                      values: row.values.map((cell) => ({
                        ...(cell.userEnteredValue?.formulaValue === undefined
                          ? {}
                          : { userEnteredValue: { formulaValue: cell.userEnteredValue.formulaValue } }),
                        ...(cell.userEnteredFormat === undefined
                          ? {}
                          : { userEnteredFormat: structuredClone(cell.userEnteredFormat) }),
                        ...(cell.textFormatRuns === undefined
                          ? {}
                          : { textFormatRuns: structuredClone(cell.textFormatRuns) }),
                        ...(cell.dataValidation === undefined
                          ? {}
                          : { dataValidation: structuredClone(cell.dataValidation) }),
                        ...(cell.pivotTable === undefined
                          ? {}
                          : { pivotTable: structuredClone(cell.pivotTable) }),
                      })),
                    }),
              })),
            }),
      }
    })
    target.data = [...(target.data ?? []), ...data]
  }
}

function assertNoLiteralPayloadInStructuralGrid(grid: sheets_v4.Schema$GridData): void {
  for (const row of grid.rowData ?? []) {
    for (const cell of row.values ?? []) {
      const entered = cell.userEnteredValue
      if (
        entered?.stringValue !== undefined ||
        entered?.numberValue !== undefined ||
        entered?.boolValue !== undefined ||
        entered?.errorValue !== undefined ||
        cell.effectiveValue !== undefined ||
        cell.formattedValue !== undefined ||
        cell.note !== undefined
      ) {
        throw new Error("Bounded structural form response contained unapproved literal cell data.")
      }
    }
  }
}

function appendLiteralObserverGridResponse(
  observer: GoogleSpreadsheet,
  response: GoogleSpreadsheet,
  allowedRanges: readonly sheets_v4.Schema$GridRange[]
): void {
  const observerSheets = new Map(
    (observer.sheets ?? []).map((sheet) => [sheet.properties?.sheetId, sheet] as const)
  )
  for (const responseSheet of response.sheets ?? []) {
    const sheetId = responseSheet.properties?.sheetId
    if (!Number.isInteger(sheetId)) {
      throw new Error("Bounded structural literal response omitted its sheet id.")
    }
    const target = observerSheets.get(sheetId)
    if (!target) throw new Error("Bounded structural literal response referenced an unknown sheet id.")
    for (const grid of responseSheet.data ?? []) {
      const startRow = grid.startRow ?? 0
      const startColumn = grid.startColumn ?? 0
      for (const [rowOffset, row] of (grid.rowData ?? []).entries()) {
        for (const [columnOffset, cell] of (row.values ?? []).entries()) {
          const literal = sanctionedLiteralCell(cell)
          if (!literal) continue
          const rowIndex = startRow + rowOffset
          const columnIndex = startColumn + columnOffset
          const allowed = allowedRanges.some(
            (range) =>
              range.sheetId === sheetId &&
              rowIndex >= (range.startRowIndex ?? 0) &&
              rowIndex < (range.endRowIndex ?? 0) &&
              columnIndex >= (range.startColumnIndex ?? 0) &&
              columnIndex < (range.endColumnIndex ?? 0)
          )
          if (!allowed) {
            throw new Error("Structural literal response escaped its spec-sanctioned range.")
          }
          target.data = [
            ...(target.data ?? []),
            {
              startRow: rowIndex,
              startColumn: columnIndex,
              rowData: [{ values: [literal] }],
            },
          ]
        }
      }
    }
  }
}

function sanctionedLiteralCell(cell: sheets_v4.Schema$CellData): sheets_v4.Schema$CellData | null {
  const entered = cell.userEnteredValue
  if (entered?.formulaValue !== undefined || entered?.errorValue !== undefined) {
    throw new Error("Structural literal response contained an unapproved ExtendedValue member.")
  }
  const literalEntered =
    entered?.stringValue !== undefined ||
    entered?.numberValue !== undefined ||
    entered?.boolValue !== undefined
      ? {
          ...(entered.stringValue === undefined ? {} : { stringValue: entered.stringValue }),
          ...(entered.numberValue === undefined ? {} : { numberValue: entered.numberValue }),
          ...(entered.boolValue === undefined ? {} : { boolValue: entered.boolValue }),
        }
      : undefined
  if (literalEntered === undefined && cell.note === undefined) return null
  return {
    ...(literalEntered === undefined ? {} : { userEnteredValue: literalEntered }),
    ...(cell.note === undefined ? {} : { note: cell.note }),
  }
}

function validateStructuralLiteralRange(
  range: StagingStructuralLiteralObservationRange
): StagingStructuralLiteralObservationRange {
  if (!range.sheetTitle.trim()) {
    throw new Error("Structural literal observation range must name its exact sheet title.")
  }
  const values = Object.values(range.gridRange)
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("Structural literal observation range must contain non-negative integer bounds.")
  }
  if (
    range.gridRange.endRowIndex <= range.gridRange.startRowIndex ||
    range.gridRange.endColumnIndex <= range.gridRange.startColumnIndex
  ) {
    throw new Error("Structural literal observation range must be non-empty and bounded.")
  }
  const estimatedCells =
    (range.gridRange.endRowIndex - range.gridRange.startRowIndex) *
    (range.gridRange.endColumnIndex - range.gridRange.startColumnIndex)
  if (estimatedCells > SHEET_STRUCTURE_MAX_CELLS_PER_READ) {
    throw new Error("Structural literal observation range exceeds the bounded cell limit.")
  }
  return range
}

function structureSheetDescriptor(sheet: GoogleSheet): {
  sheetId: number
  title: string
  rowCount: number
  columnCount: number
  gridRange: sheets_v4.Schema$GridRange
} {
  const sheetId = sheet.properties?.sheetId
  const title = sheet.properties?.title?.trim()
  const rowCount = sheet.properties?.gridProperties?.rowCount
  const columnCount = sheet.properties?.gridProperties?.columnCount
  if (!Number.isInteger(sheetId) || !title || !Number.isInteger(rowCount) || (rowCount as number) <= 0) {
    throw new Error("Google Sheet structure metadata is missing an id, title, or positive row count.")
  }
  if (!Number.isInteger(columnCount) || (columnCount as number) <= 0) {
    throw new Error(`Google Sheet ${title} structure metadata is missing a positive column count.`)
  }
  return {
    sheetId: sheetId as number,
    title,
    rowCount: rowCount as number,
    columnCount: columnCount as number,
    gridRange: {
      sheetId: sheetId as number,
      startRowIndex: 0,
      endRowIndex: rowCount as number,
      startColumnIndex: 0,
      endColumnIndex: columnCount as number,
    },
  }
}

function addStructureGridResponse(
  accumulator: SheetStructureSnapshotAccumulator,
  spreadsheet: GoogleSpreadsheet,
  kind: "column_metadata" | "cell_form"
): void {
  for (const sheet of spreadsheet.sheets ?? []) {
    const sheetId = sheet.properties?.sheetId
    if (!Number.isInteger(sheetId)) {
      throw new Error("Bounded Google Sheet structure response omitted its sheet id.")
    }
    const grids = (sheet.data ?? []).map((grid) =>
      kind === "column_metadata"
        ? {
            startColumn: grid.startColumn,
            columnMetadata: grid.columnMetadata,
          }
        : {
            startRow: grid.startRow,
            startColumn: grid.startColumn,
            rowMetadata: grid.rowMetadata,
            rowData: grid.rowData,
          }
    )
    accumulator.addSheetGridData(sheetId as number, grids)
  }
}

function batchGridRanges(
  ranges: readonly sheets_v4.Schema$GridRange[],
  maximumRanges: number
): sheets_v4.Schema$GridRange[][] {
  const batches: sheets_v4.Schema$GridRange[][] = []
  for (let index = 0; index < ranges.length; index += maximumRanges) {
    batches.push(ranges.slice(index, index + maximumRanges))
  }
  return batches
}

function batchCellRanges(
  ranges: readonly { gridRange: sheets_v4.Schema$GridRange; estimatedCells: number }[]
): sheets_v4.Schema$GridRange[][] {
  const batches: sheets_v4.Schema$GridRange[][] = []
  let current: sheets_v4.Schema$GridRange[] = []
  let currentCells = 0
  for (const item of ranges) {
    if (!Number.isInteger(item.estimatedCells) || item.estimatedCells <= 0) {
      throw new Error("Google Sheet structure range plan is invalid.")
    }
    if (item.estimatedCells > SHEET_STRUCTURE_MAX_CELLS_PER_READ) {
      throw new Error("Google Sheet structure range exceeds the bounded cell limit.")
    }
    if (
      current.length > 0 &&
      (currentCells + item.estimatedCells > SHEET_STRUCTURE_MAX_CELLS_PER_READ || current.length >= 50)
    ) {
      batches.push(current)
      current = []
      currentCells = 0
    }
    current.push(item.gridRange)
    currentCells += item.estimatedCells
  }
  if (current.length > 0) batches.push(current)
  return batches
}

export async function readStagingDocument(
  key: StagingArtifactKey,
  clients: GoogleWorkspaceStagingClients
): Promise<docs_v1.Schema$Document> {
  const target = getStagingArtifact(key)
  if (target.kind !== "google_doc") throw new Error(`${key} is not a registered staging document.`)
  const response = await clients.docs.documents.get({
    documentId: target.artifactId,
    includeTabsContent: true,
  })
  return response.data
}

export interface StableStagingEltDocumentRead {
  document: GoogleDocsDocumentSnapshot
  driveVersion: string
  permissionFingerprint: string
}

/**
 * Accepts a Docs state only when two identical all-tab reads are bracketed by
 * one unchanged Drive version and one unchanged required-subset ACL HMAC (the
 * approved owner and writer service account; extra readers may drift freely).
 */
export async function readStableStagingEltDocument(input: {
  clients: GoogleWorkspaceStagingClients
  dataProvenance: EltDocDryRunPrivatePlan["dataProvenance"]
  requiredDriveVersion?: string
  minimumDriveVersionExclusive?: string
  expectedPermissionFingerprint?: string
  allowUnadvancedFinalState?: boolean
}): Promise<StableStagingEltDocumentRead> {
  if (input.requiredDriveVersion && input.minimumDriveVersionExclusive) {
    throw new Error("Stable ELT read cannot require both an exact and an advanced Drive version.")
  }
  const registered = getStagingArtifact("elt_doc")
  const maximumAttempts = input.minimumDriveVersionExclusive
    ? input.allowUnadvancedFinalState
      ? STAGING_STRUCTURAL_CONSISTENCY_MAXIMUM_ATTEMPTS
      : STAGING_RESOLVED_SETTLEMENT_MAXIMUM_ATTEMPTS
    : STAGING_STRUCTURAL_CONSISTENCY_MAXIMUM_ATTEMPTS

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const metadataBefore = await readStagingDriveMetadata("elt_doc", input.clients)
    assertEditableStagingEltDocMetadata(metadataBefore, registered.artifactId)
    const driveVersionBefore = requiredDriveVersion(metadataBefore)
    if (
      input.requiredDriveVersion &&
      driveVersionBefore !== input.requiredDriveVersion
    ) {
      throw new Error("Staging ELT Drive version changed after planning; refusing mutation.")
    }

    const finalAttempt = attempt === maximumAttempts - 1
    const advanced = input.minimumDriveVersionExclusive
      ? driveVersionAdvancedBeyond(
          driveVersionBefore,
          input.minimumDriveVersionExclusive
        )
      : true
    const unadvancedFinalAllowed =
      finalAttempt &&
      input.allowUnadvancedFinalState === true &&
      driveVersionBefore === input.minimumDriveVersionExclusive
    if (!advanced && !unadvancedFinalAllowed) {
      await (input.minimumDriveVersionExclusive && !input.allowUnadvancedFinalState
        ? waitForResolvedStagingSettlementRetry(attempt)
        : waitForStagingStructuralConsistencyRetry(attempt))
      continue
    }

    const permissionBefore = await readEltDocPermissionFingerprint(
      input.clients,
      registered.artifactId,
      input.dataProvenance
    )
    const first = eltDocSnapshotOf(await readStagingDocument("elt_doc", input.clients))
    const second = eltDocSnapshotOf(await readStagingDocument("elt_doc", input.clients))
    const permissionAfter = await readEltDocPermissionFingerprint(
      input.clients,
      registered.artifactId,
      input.dataProvenance
    )
    const metadataAfter = await readStagingDriveMetadata("elt_doc", input.clients)
    assertEditableStagingEltDocMetadata(metadataAfter, registered.artifactId)
    const driveVersionAfter = requiredDriveVersion(metadataAfter)

    if (
      driveVersionAfter === driveVersionBefore &&
      permissionAfter === permissionBefore &&
      (!input.expectedPermissionFingerprint ||
        permissionAfter === input.expectedPermissionFingerprint) &&
      stableSerialize(first) === stableSerialize(second)
    ) {
      assertExactEltDocSnapshot(first)
      const revisionId = first.revisionId?.trim()
      if (!revisionId) throw new Error("Stable ELT document revision id is missing.")
      return {
        document: first,
        driveVersion: driveVersionAfter,
        permissionFingerprint: permissionAfter,
      }
    }

    await (input.minimumDriveVersionExclusive && !input.allowUnadvancedFinalState
      ? waitForResolvedStagingSettlementRetry(attempt)
      : waitForStagingStructuralConsistencyRetry(attempt))
  }
  throw new Error("Staging ELT document state did not stabilize at the required Drive and ACL fence.")
}

export async function readStagingValueRanges(
  key: Exclude<StagingArtifactKey, "elt_doc">,
  ranges: readonly string[],
  clients: GoogleWorkspaceStagingClients
): Promise<readonly { range: string; values: readonly (readonly SheetCellValue[])[] }[]> {
  const target = getStagingArtifact(key)
  if (target.kind !== "google_sheet") throw new Error(`${key} is not a registered staging spreadsheet.`)
  if (ranges.length === 0 || ranges.some((range) => !range.trim())) {
    throw new Error("Staging value read requires explicit non-empty ranges.")
  }
  await paceStagingSheetsRead()
  const response = await clients.sheets.spreadsheets.values.batchGet({
    spreadsheetId: target.artifactId,
    ranges: [...ranges],
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
  })
  return ranges.map((requested, index) => ({
    range: response.data.valueRanges?.[index]?.range ?? requested,
    values: (response.data.valueRanges?.[index]?.values ?? []).map((row) =>
      row.map((value): SheetCellValue => {
        if (value === undefined || value === null || value === "") return null
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
        throw new Error("Google Sheets returned a non-scalar cell value.")
      })
    ),
  }))
}

export interface StagingSheetWriteSummary {
  artifactKey: Exclude<StagingArtifactKey, "elt_doc">
  runId: string
  status: "no_change" | "written"
  changedRangeCount: number
  mutationCallCount: number
  beforeStructureHash: string
  afterStructureHash: string
  structureCertification: "exact" | "value_coupled_auto_link" | "exact_value_owned_format"
  beforeDriveVersion: string | null
  afterDriveVersion: string | null
  compensationAttempted: boolean
}

export interface StagingEltDocWriteSummary {
  artifactKey: "elt_doc"
  runId: string
  status: "no_change" | "written"
  action: EltDocDryRunPrivatePlan["action"]
  requestCount: number
  mutationCallCount: number
  beforeRevisionId: string
  afterRevisionId: string
  beforeDriveVersion: string
  afterDriveVersion: string
  preimageFingerprint: string
  beforePermissionFingerprint: string
  afterPermissionFingerprint: string
  beforeOutsideContentFingerprint: string
  afterOutsideContentFingerprint: string
  rollbackRequestCount: number
  rollbackAttempted: false
}

export type StagingMutationCertificationStatus =
  | "not_attempted"
  | "preimage_verified"
  | "postimage_verified"
  | "postimage_rejected"
  | "ambiguous"
  | "rollback_verified"
  | "rollback_unverified"

export type StagingSheetValueWriteFailureStage =
  | "authorization"
  | "preimage_read"
  | "preimage_validation"
  | "mutation"
  | "postimage_read"
  | "postimage_validation"
  | "ambiguous_settlement"
  | "writer_unknown"

/** PII-free evidence retained when a copied Sheet value write cannot certify success. */
export class StagingSheetValueWriteExecutionError extends Error {
  readonly artifactKey: StagingSheetValuePlan["artifactKey"]
  readonly runId: string
  readonly failureStage: StagingSheetValueWriteFailureStage
  readonly mutationCallCount: number
  readonly beforeDriveVersion: string | null
  readonly afterDriveVersion: string | null
  readonly certificationStatus: StagingMutationCertificationStatus

  constructor(input: {
    plan: StagingSheetValuePlan
    failureStage: StagingSheetValueWriteFailureStage
    mutationCallCount: number
    beforeDriveVersion: string | null
    afterDriveVersion: string | null
    certificationStatus: StagingMutationCertificationStatus
    cause: unknown
  }) {
    super(input.cause instanceof Error ? input.cause.message : "Staging Sheet value write failed.", {
      cause: input.cause,
    })
    this.name = "StagingSheetValueWriteExecutionError"
    this.artifactKey = input.plan.artifactKey
    this.runId = input.plan.runId
    this.failureStage = input.failureStage
    this.mutationCallCount = input.mutationCallCount
    this.beforeDriveVersion = input.beforeDriveVersion
    this.afterDriveVersion = input.afterDriveVersion
    this.certificationStatus = input.certificationStatus
  }
}

export interface DeliveryRpsReportFormatPlan {
  sheetId: number
  sheetTitle: string
  valueOwnedFormatRanges: readonly SheetStructureCellRange[]
  desiredFormats: readonly (readonly sheets_v4.Schema$CellFormat[])[]
  requests: readonly sheets_v4.Schema$Request[]
  desiredFingerprint: string
  /**
   * Number-format coverage for the ledger date columns, gated separately from
   * the dated-report formats above: the dated tab is rewritten whenever its
   * whole-grid fingerprint drifts, whereas these fire only when an append would
   * otherwise land in a cell that cannot display a date. Absent when the plan is
   * built from the dated write alone.
   */
  ledgerRequests?: readonly sheets_v4.Schema$Request[]
  ledgerDateFormatChecks?: readonly DeliveryRpsLedgerDateFormatCheck[]
}

interface DeliveryRpsObservedFormats {
  formats: readonly (readonly sheets_v4.Schema$CellFormat[])[]
  fingerprint: string
}

export function buildDeliveryRpsReportFormatPlan(
  plan: StagingSheetValuePlan
): DeliveryRpsReportFormatPlan | null {
  if (plan.artifactKey !== "delivery_roles_rps") return null
  const datedWrites = plan.writes.filter((write) => write.rangeId === "delivery_rps_dated")
  if (datedWrites.length !== 1) {
    throw new Error("Delivery RPS value plan requires one exact dated-report range.")
  }
  const dated = buildDeliveryRpsReportFormatPlanForDatedWrite(datedWrites[0])
  const ledger = buildAppendDateFormatProjection(plan)
  return {
    ...dated,
    ledgerRequests: ledger.requests,
    ledgerDateFormatChecks: ledger.checks,
  }
}

export interface DeliveryRpsLedgerDateFormatCheck {
  sheetTitle: string
  a1Range: string
  startRowIndex: number
  endRowIndex: number
  columnIndexes: readonly number[]
  requiredType: string
  requiredPattern: string | null
}

/**
 * Number-format coverage for the ledger date columns over exactly the rows this
 * plan writes. Sheets applies a batch whole or not at all, so pairing these with
 * the value requests is what makes a date serial and its display arrive together.
 */
function buildAppendDateFormatProjection(plan: StagingSheetValuePlan): {
  requests: readonly sheets_v4.Schema$Request[]
  checks: readonly DeliveryRpsLedgerDateFormatCheck[]
} {
  const specs = APPEND_DATE_FORMAT_COLUMNS[plan.artifactKey] ?? []
  const requests: sheets_v4.Schema$Request[] = []
  const checks: DeliveryRpsLedgerDateFormatCheck[] = []
  for (const spec of specs) {
    const matching = plan.writes.filter((write) => write.rangeId === spec.rangeId)
    if (matching.length > 1) {
      throw new Error(`${plan.artifactKey} value plan requires one exact ${spec.rangeId} range.`)
    }
    // A plan that does not carry the owned range publishes no date serials
    // into it, so there is nothing to format or certify.
    const write = matching[0]
    if (!write || write.values.length === 0) continue
    // Anchor at the write's own start row, never an assumed one: the delivery
    // ledgers are full replacements from row 2, but a bounded range (All
    // Hires) starts at its changed window. The 2026-08-13 catch-up proved the
    // difference the hard way - a hardcoded anchor formatted six rows at the
    // top of the sheet instead of the six that were written.
    const anchorMatch = /!([A-Z]+)(\d+):/.exec(write.a1Range)
    if (!anchorMatch) {
      throw new Error(`${plan.artifactKey} ${spec.rangeId} range is not an exact anchored A1 range.`)
    }
    const startRowIndex = Number(anchorMatch[2]) - 1
    if (!Number.isInteger(startRowIndex) || startRowIndex < spec.firstRowIndex) {
      throw new Error(`${plan.artifactKey} ${spec.rangeId} range starts above its governed first data row.`)
    }
    const endRowIndex = startRowIndex + write.values.length
    // updateCells, deliberately not repeatCell: Google silently no-ops
    // repeatCell on at least one canonical spreadsheet (All Hires,
    // 2026-08-13) - the batch is accepted, the version advances, and nothing
    // changes - while updateCells with the identical field mask applies.
    // Proven live, side by side, on the same cells. The narrow mask keeps
    // fonts, borders and fills on retained history untouched.
    requests.push({
      updateCells: {
        start: {
          sheetId: spec.sheetId,
          rowIndex: startRowIndex,
          columnIndex: spec.startColumnIndex,
        },
        rows: Array.from({ length: write.values.length }, () => ({
          values: Array.from(
            { length: spec.endColumnIndex - spec.startColumnIndex },
            () => ({ userEnteredFormat: { numberFormat: { ...spec.numberFormat } } })
          ),
        })),
        fields: "userEnteredFormat.numberFormat",
      },
    })
    const columnIndexes: number[] = []
    for (let column = spec.startColumnIndex; column < spec.endColumnIndex; column += 1) {
      columnIndexes.push(column)
    }
    checks.push({
      sheetTitle: spec.sheetTitle,
      a1Range: `'${spec.sheetTitle}'!${columnLetter(spec.startColumnIndex)}${startRowIndex + 1}:` +
        `${columnLetter(spec.endColumnIndex - 1)}${endRowIndex}`,
      startRowIndex,
      endRowIndex,
      columnIndexes,
      requiredType: spec.numberFormat.type ?? "DATE",
      requiredPattern: spec.numberFormat.pattern ?? null,
    })
  }
  return { requests, checks }
}

function columnLetter(columnIndex: number): string {
  let index = columnIndex
  let letters = ""
  do {
    letters = String.fromCharCode(65 + (index % 26)) + letters
    index = Math.floor(index / 26) - 1
  } while (index >= 0)
  return letters
}

export function buildDeliveryRpsReportFormatPlanForDatedWrite(
  write: PlannedSheetRangeWrite
): DeliveryRpsReportFormatPlan {
  if (write.rangeId !== "delivery_rps_dated") {
    throw new Error("Delivery RPS format projection requires the exact dated-report range.")
  }
  const match = /^'((?:[^']|'')+)'!A3:N(\d+)$/.exec(write.a1Range)
  if (!match) throw new Error("Delivery RPS dated-report range is not the exact A3:N contract.")
  const sheetTitle = match[1].replaceAll("''", "'")
  const reportDate = deliveryRpsIsoDateFromTabTitle(sheetTitle)
  const sheetId = deliveryRpsTargetSheetId(reportDate)
  if (
    write.values.length === 0 ||
    write.values.some((row) => row.length !== DELIVERY_RPS_REPORT_FORMAT_END_COLUMN_INDEX)
  ) {
    throw new Error("Delivery RPS dated-report values must be a non-empty 14-column matrix.")
  }
  const lastValueOffset = findLastIndex(write.values, (row) =>
    row.some((value) => value !== null && value !== "")
  )
  if (lastValueOffset < 1) throw new Error("Delivery RPS dated report is missing its governed body.")
  const reportEndRowIndex = 2 + lastValueOffset + 1
  if (reportEndRowIndex > DELIVERY_RPS_DATED_GRID_ROW_COUNT) {
    throw new Error("Delivery RPS dated report exceeds its audited 1,000-row format capacity.")
  }

  const headerRows = DELIVERY_RPS_REPORT_SECTION_LABELS.map((label, sectionIndex) => {
    const sectionOffset = write.values.findIndex((row) => row[0] === label)
    if (sectionOffset < 0) throw new Error(`Delivery RPS dated report is missing ${label}.`)
    const expectedHeaders = DELIVERY_RPS_REPORT_HEADERS[sectionIndex]
    const actualHeaders = write.values[sectionOffset + 1]?.slice(0, expectedHeaders.length)
    if (stableSerialize(actualHeaders) !== stableSerialize(expectedHeaders)) {
      throw new Error(`Delivery RPS dated report ${label} headers drifted.`)
    }
    return {
      rowIndex: 2 + sectionOffset + 1,
      width: expectedHeaders.length,
    }
  })
  if (headerRows.some((row, index) => index > 0 && row.rowIndex <= headerRows[index - 1].rowIndex)) {
    throw new Error("Delivery RPS dated report sections are out of order.")
  }

  const desiredFormats = Array.from(
    { length: DELIVERY_RPS_DATED_GRID_ROW_COUNT - 1 },
    (_, rowOffset) => {
      const rowIndex = rowOffset + 1
      return Array.from(
        { length: DELIVERY_RPS_REPORT_FORMAT_END_COLUMN_INDEX },
        (__, columnIndex) => {
          if (rowIndex >= reportEndRowIndex) return {}
          const header = headerRows.find((candidate) => candidate.rowIndex === rowIndex)
          return canonicalCellFormat(
            header && columnIndex < header.width
              ? DELIVERY_RPS_HEADER_CELL_FORMAT
              : DELIVERY_RPS_BASE_CELL_FORMAT
          )
        }
      )
    }
  )
  const requests: sheets_v4.Schema$Request[] = [
    repeatCellFormatRequest(sheetId, 1, reportEndRowIndex, 0, 14, DELIVERY_RPS_BASE_CELL_FORMAT),
    ...headerRows.map((header) => repeatCellFormatRequest(
      sheetId,
      header.rowIndex,
      header.rowIndex + 1,
      0,
      header.width,
      DELIVERY_RPS_HEADER_CELL_FORMAT
    )),
    ...(reportEndRowIndex < DELIVERY_RPS_DATED_GRID_ROW_COUNT
      ? [repeatCellFormatRequest(
          sheetId,
          reportEndRowIndex,
          DELIVERY_RPS_DATED_GRID_ROW_COUNT,
          0,
          DELIVERY_RPS_REPORT_FORMAT_END_COLUMN_INDEX,
          {}
        )]
      : []),
  ]
  return {
    sheetId,
    sheetTitle,
    valueOwnedFormatRanges: deliveryRpsValueOwnedFormatRanges(reportDate),
    desiredFormats,
    requests,
    desiredFingerprint: createPayloadFingerprint(desiredFormats),
  }
}

async function readDeliveryRpsReportFormats(
  spreadsheetId: string,
  plan: DeliveryRpsReportFormatPlan,
  clients: GoogleWorkspaceStagingClients
): Promise<DeliveryRpsObservedFormats> {
  await paceStagingSheetsRead()
  const escapedTitle = plan.sheetTitle.replaceAll("'", "''")
  const response = await clients.sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [`'${escapedTitle}'!A2:N${DELIVERY_RPS_DATED_GRID_ROW_COUNT}`],
    includeGridData: true,
    fields: "spreadsheetId,sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(userEnteredFormat))))",
  })
  if (response.data.spreadsheetId !== spreadsheetId) {
    throw new Error("Delivery RPS format read returned an unexpected spreadsheet.")
  }
  const matching = (response.data.sheets ?? []).filter(
    (sheet) => sheet.properties?.sheetId === plan.sheetId && sheet.properties?.title === plan.sheetTitle
  )
  if (matching.length !== 1) {
    throw new Error("Delivery RPS format read did not return the exact dated tab.")
  }
  const formats = Array.from(
    { length: DELIVERY_RPS_DATED_GRID_ROW_COUNT - 1 },
    () => Array.from(
      { length: DELIVERY_RPS_REPORT_FORMAT_END_COLUMN_INDEX },
      (): sheets_v4.Schema$CellFormat => ({})
    )
  )
  for (const grid of matching[0].data ?? []) {
    const startRow = grid.startRow ?? 0
    const startColumn = grid.startColumn ?? 0
    for (const [rowOffset, row] of (grid.rowData ?? []).entries()) {
      const rowIndex = startRow + rowOffset
      if (rowIndex < 1 || rowIndex >= DELIVERY_RPS_DATED_GRID_ROW_COUNT) continue
      for (const [columnOffset, cell] of (row.values ?? []).entries()) {
        const columnIndex = startColumn + columnOffset
        if (columnIndex < 0 || columnIndex >= DELIVERY_RPS_REPORT_FORMAT_END_COLUMN_INDEX) continue
        formats[rowIndex - 1][columnIndex] = canonicalCellFormat(cell.userEnteredFormat ?? {})
      }
    }
  }
  return { formats, fingerprint: createPayloadFingerprint(formats) }
}

function assertDeliveryRpsReportFormats(
  observed: DeliveryRpsObservedFormats,
  plan: DeliveryRpsReportFormatPlan
): void {
  if (observed.fingerprint !== plan.desiredFingerprint) {
    throw new Error("Delivery RPS dated-report formatting did not match the exact planned post-state.")
  }
}

/**
 * Counts ledger date cells that cannot display a date. Used twice: before the
 * mutation to decide whether the format requests are needed at all, and after it
 * to certify that none is left unable to render the serial it now holds.
 */
export async function countDeliveryRpsLedgerDateFormatGaps(
  artifactKey: Exclude<StagingArtifactKey, "elt_doc">,
  checks: readonly DeliveryRpsLedgerDateFormatCheck[],
  clients: GoogleWorkspaceStagingClients
): Promise<number> {
  if (checks.length === 0) return 0
  const snapshot = await readStagingSheetNumberFormatRanges(
    artifactKey,
    checks.map((check) => check.a1Range),
    clients
  )
  let gaps = 0
  for (const check of checks) {
    const sheet = snapshot.sheets?.find(
      (candidate) => candidate.properties?.title === check.sheetTitle
    )
    for (let row = check.startRowIndex; row < check.endRowIndex; row += 1) {
      for (const column of check.columnIndexes) {
        const format = sheet ? numberFormatAt(sheet, row, column) : undefined
        if (format?.type !== check.requiredType) {
          gaps += 1
          continue
        }
        if (
          check.requiredPattern !== null &&
          canonicalNumberFormatPattern(format.pattern) !==
            canonicalNumberFormatPattern(check.requiredPattern)
        ) {
          gaps += 1
        }
      }
    }
  }
  return gaps
}

/**
 * Sheets canonicalizes stored patterns by quoting literal characters: writing
 * "mmm d, yyyy" reads back as mmm" "d", "yyyy - the identical display. The
 * quotes only ever delimit literals, so stripping them yields a
 * display-equivalent form to compare.
 */
function canonicalNumberFormatPattern(pattern: string | null | undefined): string {
  return (pattern ?? "").replaceAll('"', "")
}

function numberFormatAt(
  sheet: GoogleSheet,
  rowIndex: number,
  columnIndex: number
): { type?: string | null; pattern?: string | null } | undefined {
  for (const data of sheet.data ?? []) {
    const rowOffset = rowIndex - (data.startRow ?? 0)
    const columnOffset = columnIndex - (data.startColumn ?? 0)
    if (rowOffset < 0 || columnOffset < 0) continue
    const row = data.rowData?.[rowOffset]
    if (!row) continue
    const cell = row.values?.[columnOffset]
    if (cell) return cell.userEnteredFormat?.numberFormat ?? undefined
  }
  return undefined
}

function deliveryRpsIsoDateFromTabTitle(sheetTitle: string): string {
  const match = /^(\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})$/.exec(sheetTitle)
  if (!match) throw new Error("Delivery RPS dated-report tab title is invalid.")
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    .indexOf(match[2])
  const timestamp = Date.UTC(Number(match[3]), month, Number(match[1]))
  const isoDate = new Date(timestamp).toISOString().slice(0, 10)
  const expectedTitle = `${String(new Date(timestamp).getUTCDate()).padStart(2, "0")} ${match[2]} ${match[3]}`
  if (expectedTitle !== sheetTitle) throw new Error("Delivery RPS dated-report tab title is invalid.")
  return isoDate
}

function repeatCellFormatRequest(
  sheetId: number,
  startRowIndex: number,
  endRowIndex: number,
  startColumnIndex: number,
  endColumnIndex: number,
  format: sheets_v4.Schema$CellFormat
): sheets_v4.Schema$Request {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex },
      cell: { userEnteredFormat: canonicalCellFormat(format) },
      fields: "userEnteredFormat",
    },
  }
}

function canonicalCellFormat(value: sheets_v4.Schema$CellFormat): sheets_v4.Schema$CellFormat {
  return JSON.parse(stableSerialize(value)) as sheets_v4.Schema$CellFormat
}

function solidBlackBorder(): sheets_v4.Schema$Border {
  return {
    style: "SOLID",
    width: 1,
    color: {},
    colorStyle: { rgbColor: {} },
  }
}

function findLastIndex<T>(
  values: readonly T[],
  predicate: (value: T) => boolean
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) return index
  }
  return -1
}

/**
 * Public-safe stage labels for the copied ELT Doc writer. The underlying
 * Google/document error remains private; scheduled evidence needs only enough
 * information to distinguish a rejected plan from a failed mutation or
 * post-write proof.
 */
export type StagingEltDocWriteFailureStage =
  | "request_compile"
  | "authorization"
  | "preimage_read"
  | "preimage_validation"
  | "permission_read"
  | "permission_validation"
  | "mutation"
  | "postimage_read"
  | "postimage_validation"
  | "rollback"
  | "writer_unknown"

export class StagingEltDocWriteExecutionError extends Error {
  readonly stage: Exclude<StagingEltDocWriteFailureStage, "writer_unknown">
  readonly mutationCallCount: number
  readonly providerHttpStatus: number | null
  readonly providerRequestIndex: number | null
  readonly beforeRevisionId: string | null
  readonly afterRevisionId: string | null
  readonly beforeDriveVersion: string | null
  readonly afterDriveVersion: string | null
  readonly rollbackDriveVersion: string | null
  readonly beforePermissionFingerprint: string | null
  readonly afterPermissionFingerprint: string | null
  readonly rollbackPermissionFingerprint: string | null
  readonly certificationStatus: StagingMutationCertificationStatus
  readonly rollbackAttempted: boolean
  readonly rollbackVerified: boolean

  constructor(
    stage: Exclude<StagingEltDocWriteFailureStage, "writer_unknown">,
    cause: unknown,
    evidence: {
      mutationCallCount?: number
      beforeRevisionId?: string | null
      afterRevisionId?: string | null
      beforeDriveVersion?: string | null
      afterDriveVersion?: string | null
      rollbackDriveVersion?: string | null
      beforePermissionFingerprint?: string | null
      afterPermissionFingerprint?: string | null
      rollbackPermissionFingerprint?: string | null
      certificationStatus?: StagingMutationCertificationStatus
      rollbackAttempted?: boolean
      rollbackVerified?: boolean
    } = {}
  ) {
    super(cause instanceof Error ? cause.message : "Staging ELT document write failed.", {
      cause,
    })
    const providerDiagnostic = eltDocProviderDiagnostic(cause)
    this.name = "StagingEltDocWriteExecutionError"
    this.stage = stage
    this.mutationCallCount = evidence.mutationCallCount ?? 0
    this.providerHttpStatus = providerDiagnostic.httpStatus
    this.providerRequestIndex = providerDiagnostic.requestIndex
    this.beforeRevisionId = evidence.beforeRevisionId ?? null
    this.afterRevisionId = evidence.afterRevisionId ?? null
    this.beforeDriveVersion = evidence.beforeDriveVersion ?? null
    this.afterDriveVersion = evidence.afterDriveVersion ?? null
    this.rollbackDriveVersion = evidence.rollbackDriveVersion ?? null
    this.beforePermissionFingerprint = evidence.beforePermissionFingerprint ?? null
    this.afterPermissionFingerprint = evidence.afterPermissionFingerprint ?? null
    this.rollbackPermissionFingerprint = evidence.rollbackPermissionFingerprint ?? null
    this.certificationStatus = evidence.certificationStatus ?? "not_attempted"
    this.rollbackAttempted = evidence.rollbackAttempted ?? false
    this.rollbackVerified = evidence.rollbackVerified ?? false
  }
}

function eltDocProviderDiagnostic(error: unknown): {
  httpStatus: number | null
  requestIndex: number | null
} {
  const record =
    error !== null && typeof error === "object"
      ? error as Record<string, unknown>
      : null
  const response =
    record?.response !== null && typeof record?.response === "object"
      ? record.response as Record<string, unknown>
      : null
  const status = response?.status
  const httpStatus =
    Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599
      ? Number(status)
      : null
  const responseData =
    response?.data !== null && typeof response?.data === "object"
      ? response.data as Record<string, unknown>
      : null
  const responseError =
    responseData?.error !== null && typeof responseData?.error === "object"
      ? responseData.error as Record<string, unknown>
      : null
  const messages = [
    error instanceof Error ? error.message : null,
    typeof responseError?.message === "string" ? responseError.message : null,
  ]
  let requestIndex: number | null = null
  for (const message of messages) {
    const match = message?.match(/\bInvalid requests\[(\d{1,6})\]/u)
    if (!match) continue
    const parsed = Number.parseInt(match[1], 10)
    if (Number.isSafeInteger(parsed)) {
      requestIndex = parsed
      break
    }
  }
  return { httpStatus, requestIndex }
}

/**
 * The fullest text Docs gave us for a rejected batch, redacted. A rejection can
 * echo the text it refused to insert, which for this document is candidate
 * names, so this never reaches a log un-redacted.
 */
function safeEltDocDiagnostic(error: unknown): string {
  const record =
    error !== null && typeof error === "object" ? error as Record<string, unknown> : null
  const response =
    record?.response !== null && typeof record?.response === "object"
      ? record.response as Record<string, unknown>
      : null
  const responseData =
    response?.data !== null && typeof response?.data === "object"
      ? response.data as Record<string, unknown>
      : null
  const responseError =
    responseData?.error !== null && typeof responseData?.error === "object"
      ? responseData.error as Record<string, unknown>
      : null
  const message =
    (typeof responseError?.message === "string" ? responseError.message : null) ??
    (error instanceof Error ? error.message : String(error))
  return redactPublicText(message).replace(/[\r\n]+/g, " ").slice(0, 300)
}

export function stagingEltDocWriteFailureStage(
  error: unknown
): StagingEltDocWriteFailureStage {
  return error instanceof StagingEltDocWriteExecutionError ? error.stage : "writer_unknown"
}

export interface StagingSheetStructuralWriteSummary {
  artifactKey: StagingStructuralNormalizationSpec["artifactKey"]
  runId: string
  normalizationId: string
  status: "already_normalized" | "normalized"
  forwardRequestCount: number
  rollbackRequestCount: number
  mutationCallCount: number
  rollbackAttempted: false
  beforeDriveVersion: string
  afterDriveVersion: string
  beforeStructureFingerprint: string
  afterStructureFingerprint: string
  beforeStateFingerprint: string
  afterStateFingerprint: string
  forwardRequestsFingerprint: string
  rollbackRequestsFingerprint: string
  nonApprovedStructureUnchanged: true
}

export type StagingStructuralFailureStage =
  | "forward_mutation"
  | "post_verification"
  | "rollback"

/** PII-free failure metadata suitable for the delivery ledger and alerting. */
export class StagingStructuralNormalizationExecutionError extends Error {
  readonly artifactKey: StagingStructuralNormalizationSpec["artifactKey"]
  readonly normalizationId: string
  readonly runId: string
  readonly failureStage: StagingStructuralFailureStage
  readonly mutationCallCount: number
  readonly rollbackAttempted: boolean
  readonly rollbackVerified: boolean
  readonly safePreimageVerified: boolean
  readonly beforeStructureFingerprint: string
  readonly beforeDriveVersion: string | null
  readonly afterDriveVersion: string | null
  readonly certificationStatus: StagingMutationCertificationStatus

  constructor(input: {
    spec: StagingStructuralNormalizationSpec
    permit: StagingStructuralWritePermit
    failureStage: StagingStructuralFailureStage
    mutationCallCount: number
    rollbackAttempted: boolean
    rollbackVerified: boolean
    safePreimageVerified: boolean
    beforeStructureFingerprint: string
    beforeDriveVersion?: string | null
    afterDriveVersion?: string | null
    certificationStatus?: StagingMutationCertificationStatus
    cause?: unknown
    reasonDetail?: string
  }) {
    const recovery = input.safePreimageVerified
      ? "the exact structural preimage was verified"
      : "the exact structural preimage could not be verified"
    const detail = input.reasonDetail ? ` ${input.reasonDetail}` : ""
    super(
      `Staging structural normalization failed at ${input.failureStage}; ${recovery}.${detail}`,
      input.cause === undefined ? undefined : { cause: input.cause }
    )
    this.name = "StagingStructuralNormalizationExecutionError"
    this.artifactKey = input.spec.artifactKey
    this.normalizationId = input.spec.id
    this.runId = input.permit.runId
    this.failureStage = input.failureStage
    this.mutationCallCount = input.mutationCallCount
    this.rollbackAttempted = input.rollbackAttempted
    this.rollbackVerified = input.rollbackVerified
    this.safePreimageVerified = input.safePreimageVerified
    this.beforeStructureFingerprint = input.beforeStructureFingerprint
    this.beforeDriveVersion = input.beforeDriveVersion ?? null
    this.afterDriveVersion = input.afterDriveVersion ?? null
    this.certificationStatus = input.certificationStatus ?? (
      input.rollbackAttempted
        ? input.rollbackVerified ? "rollback_verified" : "rollback_unverified"
        : input.safePreimageVerified ? "preimage_verified" : "ambiguous"
    )
  }
}

/**
 * The sole Google Sheets structural-mutation entry point. It accepts only a
 * registered copied spreadsheet and a fresh permit minted from the same full
 * structural snapshot. Exact after-state reruns make zero mutation calls.
 */
export async function normalizeStagingSheetStructure(input: {
  spec: StagingStructuralNormalizationSpec
  permit: StagingStructuralWritePermit
  clients: GoogleWorkspaceStagingClients
  env?: Readonly<Record<string, string | undefined>>
  nowMs: number
  currentTimeMs?: () => number
  revalidateKillSwitchClear?: (input: {
    artifactKey: StagingStructuralNormalizationSpec["artifactKey"]
    nowMs: number
  }) => Promise<void>
}): Promise<StagingSheetStructuralWriteSummary> {
  const { spec, permit, clients } = input
  const currentTimeMs = input.currentTimeMs ?? Date.now
  // Validate the complete reversible contract before any Google API access.
  planStagingStructuralNormalization(spec, spec.expectedBefore)
  const registered = requireStagingMutationTarget({
    key: spec.artifactKey,
    artifactId: spec.spreadsheetId,
    kind: "google_sheet",
  })
  const authorizationNowMs = currentTimeMs()
  if (!stagingHydrationEnabled(spec.artifactKey, authorizationNowMs, input.env)) {
    throw new Error("Staging hydration flags are not enabled for this artifact.")
  }
  assertStagingStructuralWritePermit({
    permit,
    spec,
    env: input.env,
    nowMs: authorizationNowMs,
  })

  const [beforeMetadata, beforeRead] = await Promise.all([
    readStagingDriveMetadata(spec.artifactKey, clients),
    readStagingStructuralNormalizationSnapshot(spec, clients),
  ])
  assertEditableStagingSheetMetadata(beforeMetadata, registered.artifactId)
  const beforeDriveVersion = requiredDriveVersion(beforeMetadata)
  if (beforeDriveVersion !== permit.expectedDriveVersion) {
    throw new Error("Staging structural Drive version changed after authorization; refusing mutation.")
  }

  const beforeState = projectStagingStructuralNormalizationState(
    beforeRead.spreadsheet,
    spec
  )
  const plan = planStagingStructuralNormalization(spec, beforeState)
  if (plan.status !== permit.expectedStatus) {
    throw new Error("Staging structural state no longer matches the authorized plan status.")
  }
  const beforeStructure = beforeRead.structure
  if (beforeStructure.structureHash !== permit.observedStructureFingerprint) {
    throw new Error("Staging sheet structure changed after structural authorization; refusing mutation.")
  }

  const immediateMetadata = await readStagingDriveMetadata(spec.artifactKey, clients)
  assertEditableStagingSheetMetadata(immediateMetadata, registered.artifactId)
  if (requiredDriveVersion(immediateMetadata) !== beforeDriveVersion) {
    throw new Error("Staging sheet Drive version changed during structural preflight; refusing mutation.")
  }

  if (plan.status === "already_normalized") {
    return {
      artifactKey: spec.artifactKey,
      runId: permit.runId,
      normalizationId: spec.id,
      status: "already_normalized",
      forwardRequestCount: 0,
      rollbackRequestCount: 0,
      mutationCallCount: 0,
      rollbackAttempted: false,
      beforeDriveVersion,
      afterDriveVersion: beforeDriveVersion,
      beforeStructureFingerprint: beforeStructure.structureHash,
      afterStructureFingerprint: beforeStructure.structureHash,
      beforeStateFingerprint: plan.requestMetadata.preimageFingerprint,
      afterStateFingerprint: plan.requestMetadata.afterStateFingerprint,
      forwardRequestsFingerprint: plan.requestMetadata.forwardRequestsFingerprint,
      rollbackRequestsFingerprint: plan.requestMetadata.rollbackRequestsFingerprint,
      nonApprovedStructureUnchanged: true,
    }
  }

  let mutationCallCount = 0
  let forwardResolved = false
  let postStateOutcome: StagingStructuralPostStateOutcome | undefined
  try {
    const mutationNowMs = currentTimeMs()
    if (!stagingHydrationEnabled(spec.artifactKey, mutationNowMs, input.env)) {
      throw new Error("Staging hydration flags expired before the structural mutation boundary.")
    }
    assertStagingStructuralWritePermit({ permit, spec, env: input.env, nowMs: mutationNowMs })
    if (!input.revalidateKillSwitchClear) {
      throw new Error("Staging structural mutation requires durable kill-switch revalidation.")
    }
    await input.revalidateKillSwitchClear({ artifactKey: spec.artifactKey, nowMs: mutationNowMs })
    mutationCallCount += 1
    await executeStagingSheetStructuralRequests(
      clients,
      registered.artifactId,
      plan.requests
    )
    forwardResolved = true

    postStateOutcome = await readStableStagingStructuralPostState(
      spec,
      clients,
      beforeDriveVersion
    )
    if (!postStateOutcome.settled) {
      throw new Error(
        "Staging sheet structural post-state did not advance, stabilize, and match the " +
          `exact expected state; reason=${postStateOutcome.classification}.`
      )
    }
    const afterDriveVersion = postStateOutcome.driveVersion
    const afterRead = postStateOutcome.snapshot
    const verification = verifyStagingStructuralNormalizationAfter({
      spec,
      beforeSnapshot: beforeRead.spreadsheet,
      afterSnapshot: afterRead.spreadsheet,
    })
    const afterStructure = afterRead.structure
    return {
      artifactKey: spec.artifactKey,
      runId: permit.runId,
      normalizationId: spec.id,
      status: "normalized",
      forwardRequestCount: plan.requestMetadata.forwardRequestCount,
      rollbackRequestCount: plan.requestMetadata.rollbackRequestCount,
      mutationCallCount,
      rollbackAttempted: false,
      beforeDriveVersion,
      afterDriveVersion,
      beforeStructureFingerprint: beforeStructure.structureHash,
      afterStructureFingerprint: afterStructure.structureHash,
      beforeStateFingerprint: plan.requestMetadata.preimageFingerprint,
      afterStateFingerprint: plan.requestMetadata.afterStateFingerprint,
      forwardRequestsFingerprint: plan.requestMetadata.forwardRequestsFingerprint,
      rollbackRequestsFingerprint: plan.requestMetadata.rollbackRequestsFingerprint,
      nonApprovedStructureUnchanged: verification.nonApprovedStructureUnchanged,
    }
  } catch (error) {
    // Once the forward structural batchUpdate has resolved, the mutation is
    // no longer ours to compensate: a rollback batchUpdate here would act on
    // whatever concurrent state Drive/Sheets holds now, not the preimage we
    // authorized against. Certify what we can and throw undone.
    if (forwardResolved) {
      const reasonCode = postStateOutcome
        ? postStateOutcome.settled
          ? "non_approved_structure_drift"
          : postStateOutcome.classification
        : "post_state_not_observed"
      const certificationStatus: StagingMutationCertificationStatus =
        postStateOutcome?.settled ? "postimage_verified" : "ambiguous"
      throw new StagingStructuralNormalizationExecutionError({
        spec,
        permit,
        failureStage: "post_verification",
        mutationCallCount,
        rollbackAttempted: false,
        rollbackVerified: false,
        safePreimageVerified: false,
        beforeStructureFingerprint: beforeStructure.structureHash,
        beforeDriveVersion,
        afterDriveVersion: postStateOutcome?.driveVersion ?? null,
        certificationStatus,
        cause: error,
        reasonDetail: `reason=${reasonCode}; stale compensation was not attempted.`,
      })
    }
    if (mutationCallCount === 0) {
      throw new StagingStructuralNormalizationExecutionError({
        spec,
        permit,
        failureStage: "forward_mutation",
        mutationCallCount: 0,
        rollbackAttempted: false,
        rollbackVerified: false,
        safePreimageVerified: true,
        beforeStructureFingerprint: beforeStructure.structureHash,
        beforeDriveVersion,
        afterDriveVersion: beforeDriveVersion,
        certificationStatus: "not_attempted",
      })
    }

    const recovery = await stagingStructuralPreimageRecovered({
      spec,
      clients,
      expectedStructureFingerprint: beforeStructure.structureHash,
    })
    if (recovery.recovered) {
      throw new StagingStructuralNormalizationExecutionError({
        spec,
        permit,
        failureStage: "forward_mutation",
        mutationCallCount,
        rollbackAttempted: false,
        rollbackVerified: false,
        safePreimageVerified: true,
        beforeStructureFingerprint: beforeStructure.structureHash,
        beforeDriveVersion,
        afterDriveVersion: recovery.driveVersion,
      })
    }

    mutationCallCount += 1
    try {
      await executeStagingSheetStructuralRequests(
        clients,
        registered.artifactId,
        plan.rollback.requests
      )
    } catch {
      // A rejected response can still mean the atomic batch committed. The
      // exact preimage settlement below decides recovery without a third write.
    }

    const rollbackRecovery = await stagingStructuralPreimageRecovered({
      spec,
      clients,
      expectedStructureFingerprint: beforeStructure.structureHash,
      minimumDriveVersionExclusive: beforeDriveVersion,
    })
    const rollbackVerified = rollbackRecovery.recovered
    throw new StagingStructuralNormalizationExecutionError({
      spec,
      permit,
      failureStage: rollbackVerified ? "post_verification" : "rollback",
      mutationCallCount,
      rollbackAttempted: true,
      rollbackVerified,
      safePreimageVerified: rollbackVerified,
      beforeStructureFingerprint: beforeStructure.structureHash,
      beforeDriveVersion,
      afterDriveVersion: rollbackRecovery.driveVersion ?? null,
    })
  }
}

/**
 * The sole Google Docs mutation chokepoint. It accepts only the registered ELT
 * copy, re-proves its permit/revision/outside-content preimage, uses an atomic
 * required-revision batch, then verifies the date/table facts and proves every
 * narrative byte stayed outside the mutation. Canonical ids never reach I/O.
 */
export async function writeStagingEltDocument(input: {
  plan: EltDocDryRunPrivatePlan
  permit: StagingWritePermit
  clients: GoogleWorkspaceStagingClients
  env?: Readonly<Record<string, string | undefined>>
  currentTimeMs: () => number
  revalidateKillSwitchClear: (input: { nowMs: number }) => Promise<void>
}): Promise<StagingEltDocWriteSummary> {
  const { plan, permit, clients } = input
  const failureEvidence = {
    mutationCallCount: 0,
    beforeRevisionId: null as string | null,
    afterRevisionId: null as string | null,
    beforeDriveVersion: null as string | null,
    afterDriveVersion: null as string | null,
    rollbackDriveVersion: null as string | null,
    beforePermissionFingerprint: null as string | null,
    afterPermissionFingerprint: null as string | null,
    rollbackPermissionFingerprint: null as string | null,
    certificationStatus: "not_attempted" as StagingMutationCertificationStatus,
  }
  const requests = eltDocWriteStage(
    "request_compile",
    () => buildEltDocBatchUpdateRequests(plan),
    failureEvidence
  )
  const registered = eltDocWriteStage("authorization", () => {
    const authorizationNowMs = input.currentTimeMs()
    const exactTarget = requireStagingMutationTarget({
      key: "elt_doc",
      artifactId: plan.documentId,
      kind: "google_doc",
    })
    if (!stagingHydrationEnabled("elt_doc", authorizationNowMs, input.env)) {
      throw new Error("Staging hydration flags are not enabled for this artifact.")
    }
    assertStagingWritePermit({
      permit,
      expectedArtifactKey: "elt_doc",
      requiredRangeIds: plan.approvedRangeIds,
      env: input.env,
      nowMs: authorizationNowMs,
    })
    if (permit.payloadFingerprint !== plan.payloadFingerprint) {
      throw new Error("Staging write permit payload does not match the private ELT document plan.")
    }
    if (permit.structureHash !== plan.outsideContentFingerprint) {
      throw new Error("Staging write permit structure does not match the ELT outside-content proof.")
    }
    if (permit.runId !== plan.runId || permit.sourceGeneratedAt !== plan.sourceGeneratedAt) {
      throw new Error("Staging write permit run/source identity does not match the private ELT document plan.")
    }
    if (plan.action === "no_op" && requests.length !== 0) {
      throw new Error("ELT no-op unexpectedly compiled mutation requests.")
    }
    if (plan.action !== "no_op" && requests.length === 0) {
      throw new Error("ELT mutation plan compiled no Docs requests.")
    }
    return exactTarget
  }, failureEvidence)

  const beforeState = await eltDocWriteStageAsync(
    "preimage_read",
    async () => readStableStagingEltDocument({
      clients,
      dataProvenance: plan.dataProvenance,
    }),
    failureEvidence
  )
  const beforeDocument = beforeState.document
  failureEvidence.beforeRevisionId = beforeDocument.revisionId?.trim() || null
  failureEvidence.beforeDriveVersion = beforeState.driveVersion
  failureEvidence.beforePermissionFingerprint = beforeState.permissionFingerprint
  const preimage = eltDocWriteStage(
    "preimage_validation",
    () => {
      assertExactEltDocSnapshot(beforeDocument)
      if (beforeDocument.revisionId !== plan.requiredRevisionId) {
        throw new Error("Staging ELT document revision changed after dry-run; refusing mutation.")
      }
      // Both endpoints must be anchors AND consecutive boundaries. Endpoint
      // checks alone proved adjacency only by accident of the top-of-archive
      // start index; a mid-archive plan needs it proven, or a stale plan could
      // straddle a block that appeared between planning and writing.
      const boundaryStarts = eltDocArchiveBoundaryStartIndexes({
        document: beforeDocument,
        tabId: plan.tabId,
        referenceGeneratedAt: plan.sourceGeneratedAt,
      })
      const blockOrdinal = boundaryStarts.indexOf(plan.archiveBlockRange.startIndex)
      if (
        blockOrdinal < 0 ||
        boundaryStarts[blockOrdinal + 1] !== plan.archiveBlockRange.endIndex
      ) {
        throw new Error("Staging ELT archive boundary proof no longer matches the copied document.")
      }
      const preRange = eltDocPreMutationRange(plan)
      const preimageFingerprint = fingerprintEltDocContentRange({
        document: beforeDocument,
        ...preRange,
        dataProvenance: plan.dataProvenance,
      })
      if (preimageFingerprint !== plan.preimageFingerprint) {
        throw new Error("Staging ELT fact-table preimage changed after dry-run; refusing mutation.")
      }
      const outsideContentFingerprint = fingerprintEltDocOutsideContent({
        document: beforeDocument,
        ...preRange,
        dataProvenance: plan.dataProvenance,
      })
      if (outsideContentFingerprint !== plan.outsideContentFingerprint) {
        throw new Error("Staging ELT outside content changed after dry-run; refusing mutation.")
      }
      const documentFingerprint = fingerprintEltDocDocumentContent(
        beforeDocument,
        plan.tabId,
        plan.dataProvenance
      )
      if (documentFingerprint !== plan.preimageDocumentFingerprint) {
        throw new Error("Staging ELT full document preimage changed after dry-run; refusing mutation.")
      }
      const payloadFingerprint = createPiiFingerprint(plan.factTable, {
        context: "recops:p1:elt-doc:weekly-facts",
        dataProvenance: plan.dataProvenance,
      })
      if (payloadFingerprint !== plan.payloadFingerprint) {
        throw new Error("Staging ELT fact-table payload no longer matches its approved HMAC.")
      }
      if (plan.action !== "insert_top_week") {
        const expectedPreimageFacts =
          plan.action === "no_op" ? plan.factTable : plan.rollbackFactTable
        if (!expectedPreimageFacts) {
          throw new Error("Staging ELT replacement is missing its rollback fact table.")
        }
        const certifiedPreimage = certifyEltDocFactTablePostimage({
          document: beforeDocument,
          plan: { ...plan, factTable: expectedPreimageFacts },
        })
        const certifiedPreimageRange = certifiedPreimage.factTableRange
        if (
          plan.action === "replace_top_week" &&
          !certifiedPreimage.rollbackRendererCompatible
        ) {
          throw new Error(
            "Staging ELT fact-table preimage is not exactly reconstructible by rollback."
          )
        }
        if (
          certifiedPreimageRange.tabId !== preRange.tabId ||
          certifiedPreimageRange.startIndex !== preRange.startIndex ||
          certifiedPreimageRange.endIndex !== preRange.endIndex
        ) {
          throw new Error("Staging ELT rollback facts do not reconstruct the exact guarded preimage.")
        }
      }
      return { preimageFingerprint, outsideContentFingerprint }
    },
    failureEvidence
  )

  if (plan.action === "no_op") {
    failureEvidence.afterRevisionId = failureEvidence.beforeRevisionId
    failureEvidence.afterDriveVersion = beforeState.driveVersion
    failureEvidence.afterPermissionFingerprint = beforeState.permissionFingerprint
    failureEvidence.certificationStatus = "preimage_verified"
    return {
      artifactKey: "elt_doc",
      runId: plan.runId,
      status: "no_change",
      action: plan.action,
      requestCount: 0,
      mutationCallCount: 0,
      beforeRevisionId: beforeDocument.revisionId!,
      afterRevisionId: beforeDocument.revisionId!,
      beforeDriveVersion: beforeState.driveVersion,
      afterDriveVersion: beforeState.driveVersion,
      preimageFingerprint: preimage.preimageFingerprint,
      beforePermissionFingerprint: beforeState.permissionFingerprint,
      afterPermissionFingerprint: beforeState.permissionFingerprint,
      beforeOutsideContentFingerprint: preimage.outsideContentFingerprint,
      afterOutsideContentFingerprint: preimage.outsideContentFingerprint,
      rollbackRequestCount: 0,
      rollbackAttempted: false,
    }
  }

  await eltDocWriteStageAsync("mutation", async () => {
    const mutationNowMs = input.currentTimeMs()
    if (!stagingHydrationEnabled("elt_doc", mutationNowMs, input.env)) {
      throw new Error("Staging hydration flags expired before the mutation boundary.")
    }
    assertStagingWritePermit({
      permit,
      expectedArtifactKey: "elt_doc",
      requiredRangeIds: plan.approvedRangeIds,
      env: input.env,
      nowMs: mutationNowMs,
    })
    await input.revalidateKillSwitchClear({ nowMs: mutationNowMs })
    const commitNowMs = input.currentTimeMs()
    if (!stagingHydrationEnabled("elt_doc", commitNowMs, input.env)) {
      throw new Error("Staging hydration flags expired before the mutation commit boundary.")
    }
    assertStagingWritePermit({
      permit,
      expectedArtifactKey: "elt_doc",
      requiredRangeIds: plan.approvedRangeIds,
      env: input.env,
      nowMs: commitNowMs,
    })
  }, failureEvidence)

  let committedRevisionId: string | null = null
  let mutationTransportError: unknown = null
  failureEvidence.mutationCallCount += 1
  failureEvidence.certificationStatus = "ambiguous"
  try {
    const response = await clients.docs.documents.batchUpdate({
      documentId: registered.artifactId,
      requestBody: {
        requests: requests.map((request) => request as docs_v1.Schema$Request),
        writeControl: { requiredRevisionId: plan.requiredRevisionId },
      },
    })
    committedRevisionId =
      response.data.writeControl?.requiredRevisionId?.trim() || null
    if (!committedRevisionId) {
      throw new Error("Docs mutation response omitted its exclusive committed revision.")
    }
  } catch (error) {
    // Only the HTTP status and the offending request index survive into the
    // ledger, and Docs names the reason it rejected a batch nowhere else.
    console.error(
      "[recruiting-ops-elt-doc] docs batchUpdate rejected:",
      safeEltDocDiagnostic(error)
    )
    mutationTransportError = error
  }

  if (mutationTransportError) {
    let settled: StableStagingEltDocumentRead
    try {
      settled = await readStableStagingEltDocument({
        clients,
        dataProvenance: plan.dataProvenance,
        minimumDriveVersionExclusive: beforeState.driveVersion,
        expectedPermissionFingerprint: beforeState.permissionFingerprint,
        allowUnadvancedFinalState: true,
      })
    } catch (settlementError) {
      throw new StagingEltDocWriteExecutionError("mutation", settlementError, failureEvidence)
    }
    failureEvidence.afterRevisionId = settled.document.revisionId?.trim() || null
    failureEvidence.afterDriveVersion = settled.driveVersion
    failureEvidence.afterPermissionFingerprint = settled.permissionFingerprint
    if (
      settled.driveVersion === beforeState.driveVersion &&
      settled.document.revisionId?.trim() === plan.requiredRevisionId &&
      eltDocDocumentMatchesPreimage(settled.document, plan)
    ) {
      failureEvidence.certificationStatus = "preimage_verified"
      throw new StagingEltDocWriteExecutionError(
        "mutation",
        mutationTransportError,
        failureEvidence
      )
    }
    const ambiguousPostimage = driveVersionAdvancedBeyond(
      settled.driveVersion,
      beforeState.driveVersion
    )
      ? certifiedEltDocPostimage(settled.document, plan)
      : null
    if (ambiguousPostimage) {
      failureEvidence.certificationStatus = "postimage_verified"
      return {
        artifactKey: "elt_doc",
        runId: plan.runId,
        status: "written",
        action: plan.action,
        requestCount: requests.length,
        mutationCallCount: 1,
        beforeRevisionId: plan.requiredRevisionId,
        afterRevisionId: settled.document.revisionId!,
        beforeDriveVersion: beforeState.driveVersion,
        afterDriveVersion: settled.driveVersion,
        preimageFingerprint: preimage.preimageFingerprint,
        beforePermissionFingerprint: beforeState.permissionFingerprint,
        afterPermissionFingerprint: settled.permissionFingerprint,
        beforeOutsideContentFingerprint: preimage.outsideContentFingerprint,
        afterOutsideContentFingerprint: ambiguousPostimage.outsideContentFingerprint,
        rollbackRequestCount: buildEltDocRollbackRequests(
          plan,
          ambiguousPostimage.factTableRange
        ).length,
        rollbackAttempted: false,
      }
    }
    throw new StagingEltDocWriteExecutionError(
      "mutation",
      new Error(
        "Ambiguous Docs mutation reached an unknown state; neither retry nor rollback was attempted.",
        { cause: mutationTransportError }
      ),
      failureEvidence
    )
  }

  failureEvidence.certificationStatus = "postimage_rejected"
  const afterState = await eltDocWriteStageAsync(
    "postimage_read",
    async () => readStableStagingEltDocument({
      clients,
      dataProvenance: plan.dataProvenance,
      minimumDriveVersionExclusive: beforeState.driveVersion,
      expectedPermissionFingerprint: beforeState.permissionFingerprint,
    }),
    failureEvidence
  )
  const afterDocument = afterState.document
  failureEvidence.afterRevisionId = afterDocument.revisionId?.trim() || null
  failureEvidence.afterDriveVersion = afterState.driveVersion
  failureEvidence.afterPermissionFingerprint = afterState.permissionFingerprint
  type EltDocCertifiedPostimage = {
    afterRevisionId: string
    afterDriveVersion: string
    afterPermissionFingerprint: string
    factTableRange: { tabId: string; startIndex: number; endIndex: number }
    afterOutsideContentFingerprint: string
  }
  let safeRollback: EltDocCertifiedPostimage | null = null
  let postimage: EltDocCertifiedPostimage
  try {
    assertExactEltDocSnapshot(afterDocument)
    const afterRevisionId = afterDocument.revisionId?.trim()
    if (!afterRevisionId) {
      throw new Error("Staging ELT post-write revision id is missing.")
    }
    if (afterRevisionId === plan.requiredRevisionId) {
      throw new Error("Staging ELT mutation did not advance the document revision.")
    }
    if (!committedRevisionId || afterRevisionId !== committedRevisionId) {
      throw new Error(
        "Staging ELT post-write revision does not match the exclusive committed revision."
      )
    }
    const factTableRange = locateEltDocRollbackFactRange(afterDocument, plan)
    const afterOutsideContentFingerprint = fingerprintEltDocOutsideContent({
      document: afterDocument,
      ...factTableRange,
      dataProvenance: plan.dataProvenance,
    })
    if (afterOutsideContentFingerprint !== plan.outsideContentFingerprint) {
      throw new Error("Staging ELT narrative or archive content changed during hydration.")
    }
    safeRollback = {
      afterRevisionId,
      afterDriveVersion: afterState.driveVersion,
      afterPermissionFingerprint: afterState.permissionFingerprint,
      factTableRange,
      afterOutsideContentFingerprint,
    }
    const certifiedRange = certifyEltDocFactTablePostimage({
      document: afterDocument,
      plan,
    }).factTableRange
    if (
      certifiedRange.tabId !== factTableRange.tabId ||
      certifiedRange.startIndex !== factTableRange.startIndex ||
      certifiedRange.endIndex !== factTableRange.endIndex
    ) {
      throw new Error("Staging ELT certified fact range changed after rollback fencing.")
    }
    postimage = safeRollback
  } catch (error) {
    if (!safeRollback) {
      throw new StagingEltDocWriteExecutionError("postimage_validation", error, failureEvidence)
    }
    const rollbackRequests = buildEltDocRollbackRequests(plan, safeRollback.factTableRange)
    let rollbackTransportError: unknown = null
    let rollbackCommittedRevisionId: string | null = null
    try {
      failureEvidence.mutationCallCount += 1
      failureEvidence.certificationStatus = "rollback_unverified"
      const response = await clients.docs.documents.batchUpdate({
        documentId: registered.artifactId,
        requestBody: {
          requests: rollbackRequests.map((request) => request as docs_v1.Schema$Request),
          writeControl: { requiredRevisionId: safeRollback.afterRevisionId },
        },
      })
      rollbackCommittedRevisionId =
        response.data.writeControl?.requiredRevisionId?.trim() || null
      if (!rollbackCommittedRevisionId) {
        throw new Error("Docs rollback response omitted its exclusive committed revision.")
      }
    } catch (rollbackError) {
      rollbackTransportError = rollbackError
    }

    try {
      const recovered = await readStableStagingEltDocument({
        clients,
        dataProvenance: plan.dataProvenance,
        minimumDriveVersionExclusive: safeRollback.afterDriveVersion,
        expectedPermissionFingerprint: beforeState.permissionFingerprint,
        ...(rollbackTransportError ? { allowUnadvancedFinalState: true } : {}),
      })
      failureEvidence.rollbackDriveVersion = recovered.driveVersion
      failureEvidence.rollbackPermissionFingerprint = recovered.permissionFingerprint
      const recoveredRevisionId = recovered.document.revisionId?.trim() || null
      const rollbackAdvanced = driveVersionAdvancedBeyond(
        recovered.driveVersion,
        safeRollback.afterDriveVersion
      )
      if (!rollbackAdvanced && rollbackTransportError) {
        throw rollbackTransportError
      }
      if (
        !rollbackAdvanced ||
        !eltDocDocumentMatchesPreimage(recovered.document, plan) ||
        (rollbackCommittedRevisionId !== null &&
          recoveredRevisionId !== rollbackCommittedRevisionId)
      ) {
        throw new Error("Staging ELT rollback did not recover the exact document preimage.")
      }
      throw new StagingEltDocWriteExecutionError("postimage_validation", error, {
        ...failureEvidence,
        afterRevisionId: recoveredRevisionId ?? safeRollback.afterRevisionId,
        certificationStatus: "rollback_verified",
        rollbackAttempted: true,
        rollbackVerified: true,
      })
    } catch (rollbackError) {
      if (
        rollbackError instanceof StagingEltDocWriteExecutionError &&
        rollbackError.rollbackVerified
      ) {
        throw rollbackError
      }
      throw new StagingEltDocWriteExecutionError("rollback", rollbackError, {
        ...failureEvidence,
        certificationStatus: "rollback_unverified",
        rollbackAttempted: true,
        rollbackVerified: false,
      })
    }
  }
  failureEvidence.certificationStatus = "postimage_verified"
  const rollbackRequestCount = buildEltDocRollbackRequests(plan, postimage.factTableRange).length

  return {
    artifactKey: "elt_doc",
    runId: plan.runId,
    status: "written",
    action: plan.action,
    requestCount: requests.length,
    mutationCallCount: 1,
    beforeRevisionId: plan.requiredRevisionId,
    afterRevisionId: postimage.afterRevisionId,
    beforeDriveVersion: beforeState.driveVersion,
    afterDriveVersion: postimage.afterDriveVersion,
    preimageFingerprint: preimage.preimageFingerprint,
    beforePermissionFingerprint: beforeState.permissionFingerprint,
    afterPermissionFingerprint: postimage.afterPermissionFingerprint,
    beforeOutsideContentFingerprint: preimage.outsideContentFingerprint,
    afterOutsideContentFingerprint: postimage.afterOutsideContentFingerprint,
    rollbackRequestCount,
    rollbackAttempted: false,
  }
}

// Canonical is shared with an unbounded set of readers, so the ACL fence
// pages through the full permission list looking for the two REQUIRED
// recipients rather than rejecting pagination outright. Bounded to stop a
// runaway/duplicating API from looping forever.
const ELT_DOC_PERMISSION_FENCE_MAX_PAGES = 20

interface NormalizedEltDocPermission {
  type: string
  role: string
  emailAddress: string
  deleted: boolean
  pendingOwner: boolean
}

function normalizedEltDocPermissions(
  permissions: readonly drive_v3.Schema$Permission[]
): NormalizedEltDocPermission[] {
  return permissions.map((permission) => ({
    type: permission.type?.trim() ?? "",
    role: permission.role?.trim() ?? "",
    emailAddress: permission.emailAddress?.trim().toLocaleLowerCase("en-US") ?? "",
    deleted: permission.deleted === true,
    pendingOwner: permission.pendingOwner === true,
  }))
}

function requiredEltDocPermissions(): readonly Omit<NormalizedEltDocPermission, "deleted" | "pendingOwner">[] {
  return [
    {
      type: "user",
      role: "owner",
      emailAddress: RECRUITING_OPS_ELT_DOC_OWNER.trim().toLocaleLowerCase("en-US"),
    },
    {
      type: "user",
      role: "writer",
      emailAddress: RECRUITING_OPS_GOOGLE_WRITER_SERVICE_ACCOUNT.trim().toLocaleLowerCase("en-US"),
    },
  ]
}

/** True once every required recipient (owner + writer SA) has been observed. */
function eltDocPermissionFenceSatisfied(normalized: readonly NormalizedEltDocPermission[]): boolean {
  return requiredEltDocPermissions().every((required) =>
    normalized.some(
      (permission) =>
        permission.type === required.type &&
        permission.role === required.role &&
        permission.emailAddress === required.emailAddress &&
        !permission.deleted &&
        !permission.pendingOwner
    )
  )
}

/**
 * Subset ACL fence: canonical is shared with readers who come and go, so this
 * only REQUIRES the exact owner and the exact writer service account to be
 * present (undeleted, not pending). Extra recipients (readers, an "anyone"
 * link) are tolerated. The returned fingerprint covers only the required
 * subset, so an unrelated reader added or removed mid-write never changes it.
 */
function certifyEltDocPermissionFence(
  permissions: readonly drive_v3.Schema$Permission[],
  dataProvenance: EltDocDryRunPrivatePlan["dataProvenance"]
): string {
  const normalized = normalizedEltDocPermissions(permissions)
  const requiredSubset = requiredEltDocPermissions().map((required) => {
    const found = normalized.find(
      (permission) =>
        permission.type === required.type &&
        permission.role === required.role &&
        permission.emailAddress === required.emailAddress &&
        !permission.deleted &&
        !permission.pendingOwner
    )
    if (!found) {
      throw new Error("Staging ELT canonical-Doc ACL does not carry the required approved recipient.")
    }
    return found
  })
  requiredSubset.sort((left, right) =>
    `${left.role}:${left.emailAddress}`.localeCompare(`${right.role}:${right.emailAddress}`)
  )
  return createPiiFingerprint(requiredSubset, {
    context: "recops:p1:elt-doc:permission-fence",
    dataProvenance,
  })
}

async function readEltDocPermissionFingerprint(
  clients: GoogleWorkspaceStagingClients,
  artifactId: string,
  dataProvenance: EltDocDryRunPrivatePlan["dataProvenance"]
): Promise<string> {
  const permissions: drive_v3.Schema$Permission[] = []
  try {
    let pageToken: string | undefined
    let pages = 0
    do {
      const response = await clients.drive.permissions.list({
        fileId: artifactId,
        supportsAllDrives: true,
        pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
        fields: "nextPageToken,permissions(type,role,emailAddress,deleted,pendingOwner)",
      })
      permissions.push(...(response.data.permissions ?? []))
      pageToken = response.data.nextPageToken?.trim() || undefined
      pages += 1
      if (eltDocPermissionFenceSatisfied(normalizedEltDocPermissions(permissions))) break
    } while (pageToken && pages < ELT_DOC_PERMISSION_FENCE_MAX_PAGES)
  } catch (error) {
    throw new EltDocPermissionFenceError("permission_read", error)
  }
  try {
    return certifyEltDocPermissionFence(permissions, dataProvenance)
  } catch (error) {
    throw new EltDocPermissionFenceError("permission_validation", error)
  }
}

class EltDocPermissionFenceError extends Error {
  constructor(
    readonly stage: "permission_read" | "permission_validation",
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : "Staging ELT permission fence failed.", {
      cause,
    })
  }
}

function eltDocWriteStage<T>(
  stage: Exclude<StagingEltDocWriteFailureStage, "writer_unknown">,
  action: () => T,
  evidence: {
    mutationCallCount: number
    beforeRevisionId: string | null
    afterRevisionId: string | null
    certificationStatus: StagingMutationCertificationStatus
  }
): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof StagingEltDocWriteExecutionError) throw error
    if (error instanceof EltDocPermissionFenceError) {
      throw new StagingEltDocWriteExecutionError(error.stage, error, evidence)
    }
    throw new StagingEltDocWriteExecutionError(stage, error, evidence)
  }
}

async function eltDocWriteStageAsync<T>(
  stage: Exclude<StagingEltDocWriteFailureStage, "writer_unknown">,
  action: () => Promise<T>,
  evidence: {
    mutationCallCount: number
    beforeRevisionId: string | null
    afterRevisionId: string | null
    certificationStatus: StagingMutationCertificationStatus
  }
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof StagingEltDocWriteExecutionError) throw error
    if (error instanceof EltDocPermissionFenceError) {
      throw new StagingEltDocWriteExecutionError(error.stage, error, evidence)
    }
    throw new StagingEltDocWriteExecutionError(stage, error, evidence)
  }
}

/**
 * The sole Sheets value-mutation chokepoint. It re-proves the permit, exact
 * staging ID, structure hash, Drive revision and PII-safe range preimages
 * immediately before the write, then verifies both form and values after.
 * A failed or ambiguous postcondition settles and reports without a second
 * mutation because no exclusive lease can prove that a rollback is still ours.
 */
export interface WriteStagingSheetValuesInput {
  plan: StagingSheetValuePlan
  permit: StagingWritePermit
  clients: GoogleWorkspaceStagingClients
  env?: Readonly<Record<string, string | undefined>>
  nowMs: number
  currentTimeMs: () => number
  revalidateKillSwitchClear: (input: {
    artifactKey: StagingSheetValuePlan["artifactKey"]
    nowMs: number
  }) => Promise<void>
}

interface StagingSheetValueFailureEvidenceState {
  failureStage: StagingSheetValueWriteFailureStage
  mutationCallCount: number
  beforeDriveVersion: string | null
  afterDriveVersion: string | null
  certificationStatus: StagingMutationCertificationStatus
}

export async function writeStagingSheetValues(
  input: WriteStagingSheetValuesInput
): Promise<StagingSheetWriteSummary> {
  const failureEvidence: StagingSheetValueFailureEvidenceState = {
    failureStage: "authorization",
    mutationCallCount: 0,
    beforeDriveVersion: null,
    afterDriveVersion: null,
    certificationStatus: "not_attempted",
  }
  try {
    return await writeStagingSheetValuesWithEvidence(input, failureEvidence)
  } catch (error) {
    if (error instanceof StagingSheetValueWriteExecutionError) throw error
    throw new StagingSheetValueWriteExecutionError({
      plan: input.plan,
      ...failureEvidence,
      cause: error,
    })
  }
}

async function writeStagingSheetValuesWithEvidence(
  input: WriteStagingSheetValuesInput,
  failureEvidence: StagingSheetValueFailureEvidenceState
): Promise<StagingSheetWriteSummary> {
  const { plan, permit, clients } = input
  const deliveryFormatPlan = buildDeliveryRpsReportFormatPlan(plan)
  const registered = getStagingArtifact(plan.artifactKey)
  requireStagingMutationTarget({
    key: plan.artifactKey,
    artifactId: registered.artifactId,
    kind: "google_sheet",
  })
  if (!stagingHydrationEnabled(plan.artifactKey, input.nowMs, input.env)) {
    throw new Error("Staging hydration flags are not enabled for this artifact.")
  }
  assertStagingWritePermit({
    permit,
    expectedArtifactKey: plan.artifactKey,
    requiredRangeIds: plan.approvedRangeIds,
    env: input.env,
    nowMs: input.nowMs,
  })
  if (permit.payloadFingerprint !== plan.payloadFingerprint) {
    throw new Error("Staging write permit payload does not match the private value plan.")
  }
  if (permit.structureHash !== plan.structureHash) {
    throw new Error("Staging write permit structure does not match the private value plan.")
  }
  if (permit.runId !== plan.runId || permit.sourceGeneratedAt !== plan.sourceGeneratedAt) {
    throw new Error("Staging write permit run/source identity does not match the private value plan.")
  }

  failureEvidence.failureStage = "preimage_read"
  const beforeMetadata = await readStagingDriveMetadata(plan.artifactKey, clients)
  assertEditableStagingSheetMetadata(beforeMetadata, registered.artifactId)
  const beforeDriveVersion = requiredDriveVersion(beforeMetadata)
  failureEvidence.beforeDriveVersion = beforeDriveVersion

  // This is the final content read before mutation. Unlike Values API output,
  // it retains the exact typed user-entered value (including formulas and true
  // blanks) while effectiveValue supplies the same normalized scalar contract
  // used by the dry-run planner.
  const preimages = await readTypedStagingValueRanges({
    spreadsheetId: registered.artifactId,
    writes: plan.writes,
    clients,
  })
  failureEvidence.failureStage = "preimage_validation"
  for (const [index, write] of plan.writes.entries()) {
    const observedFingerprint = rangeFingerprint(
      plan.artifactKey,
      write.rangeId,
      "preimage",
      preimages[index].normalizedValues
    )
    if (observedFingerprint !== write.preimageFingerprint) {
      throw new Error(`Staging range ${write.rangeId} changed after dry-run; refusing mutation.`)
    }
  }
  const deliveryFormatPreimage = deliveryFormatPlan
    ? await readDeliveryRpsReportFormats(registered.artifactId, deliveryFormatPlan, clients)
    : null
  if (deliveryFormatPlan) {
    const datedRangeIndex = plan.writes.findIndex((write) => write.rangeId === "delivery_rps_dated")
    if (preimages[datedRangeIndex]?.gridRange.sheetId !== deliveryFormatPlan.sheetId) {
      throw new Error("Delivery RPS dated-report values resolved to an unexpected sheet id.")
    }
  }
  const changedCells = changedStagingValueCells(plan, preimages)
  // Ledger date-format coverage is decided on its own evidence: an append into
  // rows the sheet has never formatted needs the number format to travel with
  // the serial, while a runway that already renders dates must not provoke a
  // mutation of its own. Reading the gap count before the batch is what keeps an
  // unchanged cycle a genuine no-change.
  const appendDateFormat = buildAppendDateFormatProjection(plan)
  const ledgerDateFormatChecks = appendDateFormat.checks
  const ledgerDateFormatGapsBefore = await countDeliveryRpsLedgerDateFormatGaps(
    plan.artifactKey,
    ledgerDateFormatChecks,
    clients
  )
  const deliveryFormatRequests = [
    ...(deliveryFormatPlan &&
      deliveryFormatPreimage?.fingerprint !== deliveryFormatPlan.desiredFingerprint
      ? deliveryFormatPlan.requests
      : []),
    ...(ledgerDateFormatGapsBefore > 0 ? appendDateFormat.requests : []),
  ]
  if (ledgerDateFormatChecks.length > 0) {
    // Coordinates and counts only -- never values. The 2026-08-13 heal loop
    // was undiagnosable without knowing what window the writer believed it
    // was formatting.
    console.error(
      `[recruiting-ops-append-date-format] ${plan.artifactKey} gapsBefore=${ledgerDateFormatGapsBefore} ` +
      `requests=${appendDateFormat.requests.length} windows=${appendDateFormat.checks
        .map((check) => `${check.a1Range}`)
        .join("|")}`
    )
  }
  const valueCoupledAutoLinkCoordinates = new Set(
    changedCells.map((cell) =>
      sheetStructureCellCoordinateKey(cell.sheetId, cell.rowIndex, cell.columnIndex)
    )
  )
  const beforeStructureRead = await readBoundedStagingSheetForm(
    plan.artifactKey,
    clients,
    false,
    valueCoupledAutoLinkCoordinates,
    deliveryFormatPlan?.valueOwnedFormatRanges ?? appendDateFormatOwnedRanges(plan.artifactKey)
  )
  const beforeStructure = beforeStructureRead.structure
  const beforeValueCoupledAutoLinkStructure =
    beforeStructureRead.valueCoupledAutoLinkStructure
  if (beforeStructure.structureHash !== plan.structureHash) {
    throw new Error("Staging sheet structure changed after dry-run; refusing mutation.")
  }
  if (changedCells.length > 0 && !beforeValueCoupledAutoLinkStructure) {
    throw new Error("Staging sheet auto-link structure projection was unavailable before mutation.")
  }
  // Sheets does not expose a revision precondition for batchUpdate. The
  // staging kill switch/single-writer window is the primary exclusion guard;
  // this trailing Drive fence rejects edits observed while the typed preimage
  // and exact whole-workbook structure projections were being captured.
  const immediateMetadata = await readStagingDriveMetadata(plan.artifactKey, clients)
  assertEditableStagingSheetMetadata(immediateMetadata, registered.artifactId)
  const immediateDriveVersion = requiredDriveVersion(immediateMetadata)
  if (immediateDriveVersion !== beforeDriveVersion) {
    throw new Error("Staging sheet Drive version changed during preflight; refusing mutation.")
  }

  const changedRangeIndexes = new Set(changedCells.map((cell) => cell.rangeIndex))
  if (deliveryFormatRequests.length > 0) {
    changedRangeIndexes.add(plan.writes.findIndex((write) => write.rangeId === "delivery_rps_dated"))
  }
  const changedRangeCount = changedRangeIndexes.size
  if (changedCells.length === 0 && deliveryFormatRequests.length === 0) {
    return {
      artifactKey: plan.artifactKey,
      runId: plan.runId,
      status: "no_change",
      changedRangeCount: 0,
      mutationCallCount: 0,
      beforeStructureHash: beforeStructure.structureHash,
      afterStructureHash: beforeStructure.structureHash,
      structureCertification: "exact",
      beforeDriveVersion,
      afterDriveVersion: immediateDriveVersion,
      compensationAttempted: false,
    }
  }

  // Compile and size-check the complete atomic mutation before the first write
  // attempt. A malformed/oversized request can therefore never enter the
  // ambiguous "API may have applied" settlement path.
  const valueRequests = compileTypedStagingValueRequests(
    changedCells.map((cell) => ({
      sheetId: cell.sheetId,
      rowIndex: cell.rowIndex,
      columnIndex: cell.columnIndex,
      userEnteredValue: sheetScalarUserEnteredValue(cell.desiredValue),
    }))
  )
  const forwardRequests = [...valueRequests, ...deliveryFormatRequests]
  assertAtomicStagingValueRequestBounds(forwardRequests)
  // Pacing a large workbook's structural reads can consume several minutes.
  // Re-prove the time-bounded flags, permit, and durable stop control at the
  // actual mutation boundary; the timestamp captured when planning began is
  // deliberately insufficient here.
  const preAuthorizationNowMs = input.currentTimeMs()
  failureEvidence.failureStage = "mutation"
  if (!stagingHydrationEnabled(plan.artifactKey, preAuthorizationNowMs, input.env)) {
    throw new Error("Staging hydration flags expired before the mutation boundary.")
  }
  assertStagingWritePermit({
    permit,
    expectedArtifactKey: plan.artifactKey,
    requiredRangeIds: plan.approvedRangeIds,
    env: input.env,
    nowMs: preAuthorizationNowMs,
  })
  await input.revalidateKillSwitchClear({
    artifactKey: plan.artifactKey,
    nowMs: preAuthorizationNowMs,
  })
  const mutationNowMs = input.currentTimeMs()
  if (!stagingHydrationEnabled(plan.artifactKey, mutationNowMs, input.env)) {
    throw new Error("Staging hydration flags expired before the mutation boundary.")
  }
  assertStagingWritePermit({
    permit,
    expectedArtifactKey: plan.artifactKey,
    requiredRangeIds: plan.approvedRangeIds,
    env: input.env,
    nowMs: mutationNowMs,
  })
  let forwardResolved = false
  let lastPostStateMismatchCode = "post_state_not_observed"
  try {
    failureEvidence.mutationCallCount += 1
    failureEvidence.certificationStatus = "ambiguous"
    await executeTypedStagingValueRequests(
      clients,
      registered.artifactId,
      forwardRequests
    )
    forwardResolved = true
    failureEvidence.failureStage = "postimage_read"
    failureEvidence.certificationStatus = "postimage_rejected"

    const stablePostState = await readStableStagingValueStateAfterMutation({
      artifactKey: plan.artifactKey,
      spreadsheetId: registered.artifactId,
      writes: plan.writes,
      ranges: preimages.map((preimage) => preimage.gridRange),
      minimumDriveVersionExclusive: beforeDriveVersion,
      valueCoupledAutoLinkCoordinates,
      valueOwnedFormatRanges: deliveryFormatPlan?.valueOwnedFormatRanges ?? appendDateFormatOwnedRanges(plan.artifactKey),
      acceptState: (state) => {
        failureEvidence.afterDriveVersion = state.driveVersion
        failureEvidence.failureStage = "postimage_validation"
        const comparison = compareStagingValuePostimage({
          state,
          plan,
          preimages,
          changedCells,
          expectedStructureHash: beforeStructure.structureHash,
          expectedValueCoupledAutoLinkStructureHash:
            beforeValueCoupledAutoLinkStructure?.structureHash,
        })
        lastPostStateMismatchCode =
          comparison.mismatchCode ?? "post_state_matches"
        return comparison.matches
      },
      clients,
    })
    failureEvidence.afterDriveVersion = stablePostState.driveVersion
    if (deliveryFormatPlan) {
      const observedFormats = await readDeliveryRpsReportFormats(
        registered.artifactId,
        deliveryFormatPlan,
        clients
      )
      assertDeliveryRpsReportFormats(observedFormats, deliveryFormatPlan)
      const formatFence = await readStagingDriveMetadata(plan.artifactKey, clients)
      assertEditableStagingSheetMetadata(formatFence, registered.artifactId)
      if (requiredDriveVersion(formatFence) !== stablePostState.driveVersion) {
        throw new Error("Delivery RPS dated-report formatting changed during post-write verification.")
      }
    }
    // Certifies for every artifact that publishes date serials, not only the
    // one whose guard happened to be written first: a date cell that cannot
    // render is a wrong number on the page even though the serial underneath
    // is right.
    if (ledgerDateFormatChecks.length > 0) {
      const ledgerDateFormatGapsAfter = await countDeliveryRpsLedgerDateFormatGaps(
        plan.artifactKey,
        ledgerDateFormatChecks,
        clients
      )
      if (ledgerDateFormatGapsAfter > 0) {
        throw new Error(
          `${plan.artifactKey} date columns still hold ${ledgerDateFormatGapsAfter} cell(s) ` +
          "that cannot display a date after the write."
        )
      }
    }
    failureEvidence.certificationStatus = "postimage_verified"
    return {
      artifactKey: plan.artifactKey,
      runId: plan.runId,
      status: "written",
      changedRangeCount,
      mutationCallCount: failureEvidence.mutationCallCount,
      beforeStructureHash: beforeStructure.structureHash,
      afterStructureHash: stablePostState.structure.structureHash,
      structureCertification:
        deliveryFormatRequests.length > 0
          ? "exact_value_owned_format"
          : stablePostState.structure.structureHash === beforeStructure.structureHash
          ? "exact"
          : "value_coupled_auto_link",
      beforeDriveVersion,
      afterDriveVersion: stablePostState.driveVersion,
      compensationAttempted: false,
    }
  } catch (error) {
    if (forwardResolved) {
      throw new Error(
        "Staging value post-state did not settle to the exact planned state; " +
          `reason=${lastPostStateMismatchCode}; stale compensation was not attempted.`,
        { cause: error }
      )
    }
    failureEvidence.failureStage = "ambiguous_settlement"
    failureEvidence.certificationStatus = "ambiguous"
    let settledAmbiguousState: StableStagingValueState
    try {
      settledAmbiguousState = await readStableStagingValueStateAfterMutation({
        artifactKey: plan.artifactKey,
        spreadsheetId: registered.artifactId,
        writes: plan.writes,
        ranges: preimages.map((preimage) => preimage.gridRange),
        minimumDriveVersionExclusive: beforeDriveVersion,
        valueCoupledAutoLinkCoordinates,
        valueOwnedFormatRanges: deliveryFormatPlan?.valueOwnedFormatRanges ?? appendDateFormatOwnedRanges(plan.artifactKey),
        allowUnadvancedFinalState: true,
        settleThroughFinalAttempt: true,
        clients,
      })
    } catch (settlementError) {
      throw new Error(
        "Ambiguous staging value mutation did not settle to a safely classifiable state; compensation was not attempted.",
        { cause: settlementError }
      )
    }
    failureEvidence.afterDriveVersion = settledAmbiguousState.driveVersion
    const settledFormats = deliveryFormatPlan
      ? await readDeliveryRpsReportFormats(registered.artifactId, deliveryFormatPlan, clients)
      : null
    if (
      stagingValueStateMatchesPreimage({
        state: settledAmbiguousState,
        preimages,
        expectedStructureHash: beforeStructure.structureHash,
      }) &&
      (!deliveryFormatPlan || settledFormats?.fingerprint === deliveryFormatPreimage?.fingerprint)
    ) {
      failureEvidence.failureStage = "mutation"
      failureEvidence.certificationStatus = "preimage_verified"
      throw error
    }
    if (
      driveVersionAdvancedBeyond(
        settledAmbiguousState.driveVersion,
        beforeDriveVersion
      ) &&
      stagingValueStateMatchesPostimage({
        state: settledAmbiguousState,
        plan,
        preimages,
        changedCells,
        expectedStructureHash: beforeStructure.structureHash,
        expectedValueCoupledAutoLinkStructureHash:
          beforeValueCoupledAutoLinkStructure?.structureHash,
      }) &&
      (!deliveryFormatPlan || settledFormats?.fingerprint === deliveryFormatPlan.desiredFingerprint)
    ) {
      failureEvidence.certificationStatus = "postimage_verified"
      throw new Error(
        "Ambiguous staging value mutation reached the exact planned post-state; compensation was not attempted without an exclusive writer lease.",
        { cause: error }
      )
    }
    throw new Error(
      "Ambiguous staging value mutation reached an unexpected or concurrent state; stale compensation was not attempted.",
      { cause: error }
    )
  }
}

interface TypedStagingValueCell {
  userEnteredValue: sheets_v4.Schema$ExtendedValue | null
  normalizedValue: SheetCellValue
  fullCellLinkUri: string | null
  hasTextOrChipRuns: boolean
}

interface TypedStagingValueRange {
  gridRange: ExactStagingValueGridRange
  cells: readonly (readonly TypedStagingValueCell[])[]
  normalizedValues: readonly (readonly SheetCellValue[])[]
}

interface StableStagingValueState {
  driveVersion: string
  structure: SheetStructureSnapshot
  valueCoupledAutoLinkStructure?: SheetStructureSnapshot
  ranges: readonly TypedStagingValueRange[]
}

interface ExactStagingValueGridRange {
  sheetId: number
  startRowIndex: number
  endRowIndex: number
  startColumnIndex: number
  endColumnIndex: number
}

interface ChangedStagingValueCell {
  rangeIndex: number
  rowOffset: number
  columnOffset: number
  sheetId: number
  rowIndex: number
  columnIndex: number
  desiredValue: SheetCellValue
  preservedCompanionLinkUri: string | null
}

interface TypedUserEnteredValueTarget {
  sheetId: number
  rowIndex: number
  columnIndex: number
  userEnteredValue: sheets_v4.Schema$ExtendedValue | null
}

async function readTypedStagingValueRanges(input: {
  spreadsheetId: string
  writes: StagingSheetValuePlan["writes"]
  clients: GoogleWorkspaceStagingClients
}): Promise<readonly TypedStagingValueRange[]> {
  const bounds = input.writes.map((write) => {
    const parsed = parseBoundedStagingValueA1(write.a1Range)
    assertStagingValueRangeShape(parsed, write.values)
    return parsed
  })
  assertTypedStagingValueCellLimit(bounds.reduce(
    (total, bound) => total +
      (bound.endRowIndex - bound.startRowIndex) *
      (bound.endColumnIndex - bound.startColumnIndex),
    0
  ))
  await paceStagingSheetsRead()
  const response = await input.clients.sheets.spreadsheets.get({
    spreadsheetId: input.spreadsheetId,
    ranges: input.writes.map((write) => write.a1Range),
    includeGridData: true,
    fields: STAGING_VALUE_CELL_FIELDS,
  })
  if (response.data.spreadsheetId !== input.spreadsheetId) {
    throw new Error("Typed staging value read returned an unexpected spreadsheet.")
  }

  return bounds.map((bound, index) => {
    const matchingSheets = (response.data.sheets ?? []).filter(
      (sheet) => sheet.properties?.title === bound.sheetTitle
    )
    if (matchingSheets.length !== 1) {
      throw new Error("Typed staging value read did not resolve one exact sheet title.")
    }
    const sheet = matchingSheets[0]
    const sheetId = sheet.properties?.sheetId
    if (!Number.isInteger(sheetId)) {
      throw new Error("Typed staging value read omitted the sheet id.")
    }
    const grids = (sheet.data ?? []).filter(
      (grid) =>
        (grid.startRow ?? 0) === bound.startRowIndex &&
        (grid.startColumn ?? 0) === bound.startColumnIndex
    )
    if (grids.length !== 1) {
      throw new Error("Typed staging value read did not return one exact grid block.")
    }
    return typedStagingValueRange({
      grid: grids[0],
      gridRange: {
        sheetId: sheetId as number,
        startRowIndex: bound.startRowIndex,
        endRowIndex: bound.endRowIndex,
        startColumnIndex: bound.startColumnIndex,
        endColumnIndex: bound.endColumnIndex,
      },
      shape: input.writes[index].values,
    })
  })
}

async function readTypedStagingValueGridRanges(input: {
  spreadsheetId: string
  ranges: readonly TypedStagingValueRange["gridRange"][]
  writes: StagingSheetValuePlan["writes"]
  clients: GoogleWorkspaceStagingClients
}): Promise<readonly TypedStagingValueRange[]> {
  assertTypedStagingValueCellLimit(input.ranges.reduce(
    (total, range) => total +
      (range.endRowIndex - range.startRowIndex) *
      (range.endColumnIndex - range.startColumnIndex),
    0
  ))
  await paceStagingSheetsRead()
  const response = await input.clients.sheets.spreadsheets.getByDataFilter({
    spreadsheetId: input.spreadsheetId,
    fields: STAGING_VALUE_CELL_FIELDS,
    requestBody: {
      includeGridData: true,
      dataFilters: input.ranges.map((gridRange) => ({ gridRange })),
    },
  })
  if (response.data.spreadsheetId !== input.spreadsheetId) {
    throw new Error("Typed staging value verification returned an unexpected spreadsheet.")
  }
  return input.ranges.map((range, index) => {
    const matchingSheets = (response.data.sheets ?? []).filter(
      (sheet) => sheet.properties?.sheetId === range.sheetId
    )
    if (matchingSheets.length !== 1) {
      throw new Error("Typed staging value verification did not resolve one exact sheet id.")
    }
    const grids = (matchingSheets[0].data ?? []).filter(
      (grid) =>
        (grid.startRow ?? 0) === range.startRowIndex &&
        (grid.startColumn ?? 0) === range.startColumnIndex
    )
    if (grids.length !== 1) {
      throw new Error("Typed staging value verification did not return one exact grid block.")
    }
    return typedStagingValueRange({
      grid: grids[0],
      gridRange: range,
      shape: input.writes[index].values,
    })
  })
}

function assertTypedStagingValueCellLimit(cellCount: number): void {
  if (
    !Number.isSafeInteger(cellCount) ||
    cellCount <= 0 ||
    cellCount > STAGING_VALUE_MAXIMUM_TYPED_CELLS
  ) {
    throw new Error("Typed staging value read exceeds the bounded cell limit.")
  }
}

function typedStagingValueRange(input: {
  grid: sheets_v4.Schema$GridData
  gridRange: TypedStagingValueRange["gridRange"]
  shape: readonly (readonly SheetCellValue[])[]
}): TypedStagingValueRange {
  const height = input.gridRange.endRowIndex - input.gridRange.startRowIndex
  const width = input.gridRange.endColumnIndex - input.gridRange.startColumnIndex
  if (input.shape.length !== height || input.shape[0]?.length !== width) {
    throw new Error("Typed staging value grid does not match the planned shape.")
  }
  if (
    (input.grid.rowData?.length ?? 0) > height ||
    (input.grid.rowData ?? []).some((row) => (row.values?.length ?? 0) > width)
  ) {
    throw new Error("Typed staging value grid exceeded the planned range.")
  }
  const cells = Array.from({ length: height }, (_, rowIndex) =>
    Array.from({ length: width }, (__, columnIndex): TypedStagingValueCell => {
      const cell = input.grid.rowData?.[rowIndex]?.values?.[columnIndex]
      return {
        userEnteredValue: exactUserEnteredValue(cell?.userEnteredValue),
        normalizedValue: normalizedEffectiveValue(cell?.effectiveValue),
        fullCellLinkUri: exactFullCellLinkUri(cell),
        hasTextOrChipRuns:
          (cell?.textFormatRuns?.length ?? 0) > 0 ||
          (cell?.chipRuns ?? []).some(
            (run) => run.chip != null && Object.keys(run.chip).length > 0
          ),
      }
    })
  )
  return {
    gridRange: input.gridRange,
    cells,
    normalizedValues: cells.map((row) => row.map((cell) => cell.normalizedValue)),
  }
}

function exactFullCellLinkUri(cell: sheets_v4.Schema$CellData | undefined): string | null {
  const uri = cell?.userEnteredFormat?.textFormat?.link?.uri
  if (uri === undefined || uri === null) return null
  if (typeof uri !== "string" || uri.length === 0) {
    throw new Error("Typed staging value read returned an invalid full-cell link URI.")
  }
  return uri
}

function changedStagingValueCells(
  plan: StagingSheetValuePlan,
  preimages: readonly TypedStagingValueRange[]
): ChangedStagingValueCell[] {
  const changed: ChangedStagingValueCell[] = []
  const occupiedCoordinates = new Set<string>()
  const normalizedDesiredValues = plan.writes.map((write) => {
    const values = write.values.map((row) => row.map(normalizeStagingSheetScalar))
    if (
      rangeFingerprint(plan.artifactKey, write.rangeId, "desired", values) !==
      write.desiredFingerprint
    ) {
      throw new Error(`Staging range ${write.rangeId} contains a non-normalized desired scalar.`)
    }
    return values
  })
  const stableCompanionLinks = stableCompanionFullCellLinkKeys(
    preimages,
    normalizedDesiredValues
  )
  for (const [rangeIndex] of plan.writes.entries()) {
    const preimage = preimages[rangeIndex]
    for (const [rowOffset, row] of normalizedDesiredValues[rangeIndex].entries()) {
      for (const [columnOffset, desiredValue] of row.entries()) {
        const sheetId = preimage.gridRange.sheetId
        const rowIndex = preimage.gridRange.startRowIndex + rowOffset
        const columnIndex = preimage.gridRange.startColumnIndex + columnOffset
        const coordinate = sheetStructureCellCoordinateKey(sheetId, rowIndex, columnIndex)
        if (occupiedCoordinates.has(coordinate)) {
          throw new Error("Staging value plan contains overlapping cell ranges.")
        }
        occupiedCoordinates.add(coordinate)
        const preimageCell = preimage.cells[rowOffset][columnOffset]
        if (desiredValue === preimageCell.normalizedValue) continue
        if (preimageCell.hasTextOrChipRuns) {
          throw new Error("Staging value mutation would erase text-format or smart-chip runs.")
        }
        const preservedCompanionLinkUri = preservedCompanionFullCellLinkUri(
          preimageCell,
          sheetId,
          rowIndex,
          stableCompanionLinks
        )
        assertValueCoupledPreimageLink(preimageCell, preservedCompanionLinkUri)
        changed.push({
          rangeIndex,
          rowOffset,
          columnOffset,
          sheetId,
          rowIndex,
          columnIndex,
          desiredValue,
          preservedCompanionLinkUri,
        })
      }
    }
  }
  return changed
}

function assertValueCoupledPreimageLink(
  cell: TypedStagingValueCell,
  preservedCompanionLinkUri: string | null = null
): void {
  if (cell.fullCellLinkUri === null) return
  const enteredValue = cell.userEnteredValue?.stringValue
  if (
    (autoLinkUriForValue(enteredValue ?? null) !== cell.fullCellLinkUri ||
      enteredValue !== cell.fullCellLinkUri) &&
    preservedCompanionLinkUri !== cell.fullCellLinkUri
  ) {
    throw new Error("Staging value mutation would overwrite a non-value-coupled full-cell link.")
  }
}

function stableCompanionFullCellLinkKeys(
  preimages: readonly TypedStagingValueRange[],
  desiredValues: readonly (readonly (readonly SheetCellValue[])[])[]
): ReadonlySet<string> {
  // A linked label is safe to update only when the same physical row retains
  // an exact companion URL; the value-only mutation must preserve that link.
  const keys = new Set<string>()
  for (const [rangeIndex, preimage] of preimages.entries()) {
    for (const [rowOffset, row] of preimage.cells.entries()) {
      for (const [columnOffset, cell] of row.entries()) {
        const desired = desiredValues[rangeIndex][rowOffset][columnOffset]
        if (
          typeof desired !== "string" ||
          cell.normalizedValue !== desired ||
          cell.userEnteredValue?.stringValue !== desired ||
          autoLinkUriForValue(desired) !== desired
        ) continue
        keys.add(stableCompanionFullCellLinkKey(
          preimage.gridRange.sheetId,
          preimage.gridRange.startRowIndex + rowOffset,
          desired
        ))
      }
    }
  }
  return keys
}

function preservedCompanionFullCellLinkUri(
  cell: TypedStagingValueCell,
  sheetId: number,
  rowIndex: number,
  stableCompanionLinks: ReadonlySet<string>
): string | null {
  const uri = cell.fullCellLinkUri
  if (uri === null) return null
  const enteredValue = cell.userEnteredValue?.stringValue
  if (enteredValue === uri && autoLinkUriForValue(enteredValue) === uri) return null
  return stableCompanionLinks.has(stableCompanionFullCellLinkKey(sheetId, rowIndex, uri))
    ? uri
    : null
}

function stableCompanionFullCellLinkKey(
  sheetId: number,
  rowIndex: number,
  uri: string
): string {
  return `${sheetId}:${rowIndex}:${uri}`
}

function assertTypedStagingPostimage(input: {
  plan: StagingSheetValuePlan
  preimages: readonly TypedStagingValueRange[]
  postimages: readonly TypedStagingValueRange[]
  changedCells: readonly ChangedStagingValueCell[]
}): void {
  const changedByCoordinate = new Map(
    input.changedCells.map((cell) => [
      sheetStructureCellCoordinateKey(cell.sheetId, cell.rowIndex, cell.columnIndex),
      cell,
    ] as const)
  )
  for (const [rangeIndex, write] of input.plan.writes.entries()) {
    const postimage = input.postimages[rangeIndex]
    const desiredFingerprint = rangeFingerprint(
      input.plan.artifactKey,
      write.rangeId,
      "desired",
      postimage.normalizedValues
    )
    if (desiredFingerprint !== write.desiredFingerprint) {
      throw new Error(`Staging range ${write.rangeId} did not match the planned post-state.`)
    }
    for (const [rowOffset, row] of postimage.cells.entries()) {
      for (const [columnOffset, postCell] of row.entries()) {
        const sheetId = postimage.gridRange.sheetId
        const rowIndex = postimage.gridRange.startRowIndex + rowOffset
        const columnIndex = postimage.gridRange.startColumnIndex + columnOffset
        const changed = changedByCoordinate.get(
          sheetStructureCellCoordinateKey(sheetId, rowIndex, columnIndex)
        )
        const expected = changed
          ? sheetScalarUserEnteredValue(changed.desiredValue)
          : input.preimages[rangeIndex].cells[rowOffset][columnOffset].userEnteredValue
        if (!sameUserEnteredValue(postCell.userEnteredValue, expected)) {
          throw new Error(`Staging range ${write.rangeId} changed an unexpected typed cell value.`)
        }
      }
    }
  }
}

function assertValueCoupledAutoLinkPostimage(input: {
  preimages: readonly TypedStagingValueRange[]
  postimages: readonly TypedStagingValueRange[]
  changedCells: readonly ChangedStagingValueCell[]
}): void {
  for (const changed of input.changedCells) {
    const preimage = input.preimages[changed.rangeIndex].cells[changed.rowOffset][changed.columnOffset]
    const postimage = input.postimages[changed.rangeIndex].cells[changed.rowOffset][changed.columnOffset]
    const preservedLink = changed.preservedCompanionLinkUri
    assertValueCoupledPreimageLink(preimage, preservedLink)
    const expectedPostLink = preservedLink ?? autoLinkUriForValue(changed.desiredValue)
    if (postimage.fullCellLinkUri !== expectedPostLink) {
      throw new Error("Staging value post-state contained a non-value-coupled full-cell link.")
    }
  }
}

function assertRawExactAutoLinkPostimage(input: {
  preimages: readonly TypedStagingValueRange[]
  postimages: readonly TypedStagingValueRange[]
  changedCells: readonly ChangedStagingValueCell[]
}): void {
  for (const changed of input.changedCells) {
    const preimage = input.preimages[changed.rangeIndex].cells[changed.rowOffset][changed.columnOffset]
    const postimage = input.postimages[changed.rangeIndex].cells[changed.rowOffset][changed.columnOffset]
    const preservedLink = changed.preservedCompanionLinkUri
    assertValueCoupledPreimageLink(preimage, preservedLink)
    if (postimage.fullCellLinkUri !== preimage.fullCellLinkUri) {
      throw new Error("Staging value raw-exact post-state contained changed full-cell link metadata.")
    }
    if (
      preservedLink === null &&
      preimage.fullCellLinkUri !== null &&
      postimage.fullCellLinkUri !== autoLinkUriForValue(changed.desiredValue)
    ) {
      throw new Error("Staging value raw-exact post-state retained a stale full-cell link.")
    }
  }
}

function autoLinkUriForValue(value: SheetCellValue): string | null {
  if (typeof value !== "string") return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? value : null
  } catch {
    return null
  }
}

function assertTypedStagingPreimageRecovered(
  preimages: readonly TypedStagingValueRange[],
  recovered: readonly TypedStagingValueRange[]
): void {
  for (const [rangeIndex, preimage] of preimages.entries()) {
    for (const [rowIndex, row] of preimage.cells.entries()) {
      for (const [columnIndex, cell] of row.entries()) {
        if (!sameUserEnteredValue(cell.userEnteredValue, recovered[rangeIndex].cells[rowIndex][columnIndex].userEnteredValue)) {
          throw new Error("Staging value compensation verification found typed preimage drift.")
        }
      }
    }
  }
}

async function executeTypedStagingValueRequests(
  clients: GoogleWorkspaceStagingClients,
  spreadsheetId: string,
  requests: readonly sheets_v4.Schema$Request[]
): Promise<void> {
  if (requests.length === 0) throw new Error("Typed staging value mutation requires at least one changed cell.")
  await clients.sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      includeSpreadsheetInResponse: false,
      requests: [...requests],
    },
  })
}

/**
 * Sheets can expose a completed batchUpdate before Drive publishes the file's
 * next revision. Poll the cheap Drive endpoint until the revision advances,
 * then accept only structure plus typed ranges bracketed by that same advanced
 * revision. Ambiguous transport failures may opt into one final, stable V0
 * read so a proven non-application does not trigger a destructive rollback.
 */
async function readStableStagingValueStateAfterMutation(input: {
  artifactKey: StagingSheetValuePlan["artifactKey"]
  spreadsheetId: string
  writes: StagingSheetValuePlan["writes"]
  ranges: readonly ExactStagingValueGridRange[]
  minimumDriveVersionExclusive: string
  valueCoupledAutoLinkCoordinates?: ReadonlySet<string>
  valueOwnedFormatRanges?: readonly SheetStructureCellRange[]
  allowUnadvancedFinalState?: boolean
  settleThroughFinalAttempt?: boolean
  acceptState?: (state: StableStagingValueState) => boolean
  clients: GoogleWorkspaceStagingClients
}): Promise<StableStagingValueState> {
  let lastRejectedStableVersion: string | undefined
  const maximumAttempts = input.settleThroughFinalAttempt === true
    ? STAGING_STRUCTURAL_CONSISTENCY_MAXIMUM_ATTEMPTS
    : STAGING_RESOLVED_SETTLEMENT_MAXIMUM_ATTEMPTS
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const metadataBefore = await readStagingDriveMetadata(input.artifactKey, input.clients)
    assertEditableStagingSheetMetadata(metadataBefore, input.spreadsheetId)
    const beforeVersion = requiredDriveVersion(metadataBefore)
    const finalAttempt =
      attempt === maximumAttempts - 1
    const advanced = driveVersionAdvancedBeyond(
      beforeVersion,
      input.minimumDriveVersionExclusive
    )
    const unadvancedFinalAllowed =
      finalAttempt &&
      input.allowUnadvancedFinalState === true &&
      beforeVersion === input.minimumDriveVersionExclusive
    const shouldReadSnapshot =
      (
        advanced &&
        (input.settleThroughFinalAttempt !== true || finalAttempt) &&
        (beforeVersion !== lastRejectedStableVersion || finalAttempt)
      ) ||
      unadvancedFinalAllowed

    if (shouldReadSnapshot) {
      const structureRead = await readBoundedStagingSheetForm(
        input.artifactKey,
        input.clients,
        false,
        input.valueCoupledAutoLinkCoordinates,
        input.valueOwnedFormatRanges
      )
      const ranges = await readTypedStagingValueGridRanges({
        spreadsheetId: input.spreadsheetId,
        ranges: input.ranges,
        writes: input.writes,
        clients: input.clients,
      })
      const metadataAfter = await readStagingDriveMetadata(
        input.artifactKey,
        input.clients
      )
      assertEditableStagingSheetMetadata(metadataAfter, input.spreadsheetId)
      const afterVersion = requiredDriveVersion(metadataAfter)
      const stableAdvanced =
        beforeVersion === afterVersion &&
        driveVersionAdvancedBeyond(afterVersion, input.minimumDriveVersionExclusive)
      const stableUnadvancedFinal =
        unadvancedFinalAllowed && afterVersion === beforeVersion
      if (stableAdvanced || stableUnadvancedFinal) {
        const state = {
          driveVersion: afterVersion,
          structure: structureRead.structure,
          ...(structureRead.valueCoupledAutoLinkStructure
            ? { valueCoupledAutoLinkStructure: structureRead.valueCoupledAutoLinkStructure }
            : {}),
          ranges,
        }
        if (!input.acceptState || input.acceptState(state)) return state
        lastRejectedStableVersion = afterVersion
      } else {
        lastRejectedStableVersion = undefined
      }
    }
    await (input.settleThroughFinalAttempt === true
      ? waitForStagingStructuralConsistencyRetry(attempt)
      : waitForResolvedStagingSettlementRetry(attempt))
  }
  throw new Error(
    "Staging value state did not publish and stabilize at the required Drive revision."
  )
}

function stagingValueStateMatchesPreimage(input: {
  state: StableStagingValueState
  preimages: readonly TypedStagingValueRange[]
  expectedStructureHash: string
}): boolean {
  try {
    assertTypedStagingPreimageRecovered(input.preimages, input.state.ranges)
    return input.state.structure.structureHash === input.expectedStructureHash
  } catch {
    return false
  }
}

function stagingValueStateMatchesPostimage(input: {
  state: StableStagingValueState
  plan: StagingSheetValuePlan
  preimages: readonly TypedStagingValueRange[]
  changedCells: readonly ChangedStagingValueCell[]
  expectedStructureHash: string
  expectedValueCoupledAutoLinkStructureHash?: string
}): boolean {
  return compareStagingValuePostimage(input).matches
}

interface StagingValuePostimageComparison {
  matches: boolean
  /** Stable, public-safe category; never contains a cell value or coordinate. */
  mismatchCode: string | null
}

function compareStagingValuePostimage(input: {
  state: StableStagingValueState
  plan: StagingSheetValuePlan
  preimages: readonly TypedStagingValueRange[]
  changedCells: readonly ChangedStagingValueCell[]
  expectedStructureHash: string
  expectedValueCoupledAutoLinkStructureHash?: string
}): StagingValuePostimageComparison {
  try {
    assertTypedStagingPostimage({
      plan: input.plan,
      preimages: input.preimages,
      postimages: input.state.ranges,
      changedCells: input.changedCells,
    })
    if (input.state.structure.structureHash === input.expectedStructureHash) {
      try {
        assertRawExactAutoLinkPostimage({
          preimages: input.preimages,
          postimages: input.state.ranges,
          changedCells: input.changedCells,
        })
        return { matches: true, mismatchCode: null }
      } catch {
        return { matches: false, mismatchCode: "raw_auto_link_mismatch" }
      }
    }
    if (!input.expectedValueCoupledAutoLinkStructureHash) {
      return {
        matches: false,
        mismatchCode: "value_coupled_structure_projection_missing",
      }
    }
    if (
      input.state.valueCoupledAutoLinkStructure?.structureHash !==
      input.expectedValueCoupledAutoLinkStructureHash
    ) {
      return { matches: false, mismatchCode: "non_value_structure_mismatch" }
    }
    try {
      assertValueCoupledAutoLinkPostimage({
        preimages: input.preimages,
        postimages: input.state.ranges,
        changedCells: input.changedCells,
      })
      return { matches: true, mismatchCode: null }
    } catch {
      return { matches: false, mismatchCode: "value_coupled_auto_link_mismatch" }
    }
  } catch (error) {
    return {
      matches: false,
      mismatchCode: typedPostimageMismatchCode(error, input.plan),
    }
  }
}

function typedPostimageMismatchCode(
  error: unknown,
  plan: StagingSheetValuePlan
): string {
  const message = error instanceof Error ? error.message : ""
  for (const write of plan.writes) {
    if (message === `Staging range ${write.rangeId} did not match the planned post-state.`) {
      return `normalized_value_mismatch:${write.rangeId}`
    }
    if (message === `Staging range ${write.rangeId} changed an unexpected typed cell value.`) {
      return `typed_value_mismatch:${write.rangeId}`
    }
  }
  return "typed_postimage_mismatch"
}

interface TypedStagingValueRowRun {
  sheetId: number
  startRowIndex: number
  endRowIndex: number
  startColumnIndex: number
  endColumnIndex: number
  blank: boolean
  rows: sheets_v4.Schema$ExtendedValue[][]
}

function compileTypedStagingValueRequests(
  cells: readonly TypedUserEnteredValueTarget[]
): sheets_v4.Schema$Request[] {
  const sorted = cells
    .map((cell) => ({
      ...cell,
      userEnteredValue: exactUserEnteredValue(cell.userEnteredValue),
    }))
    .sort(
      (left, right) =>
        left.sheetId - right.sheetId ||
        left.rowIndex - right.rowIndex ||
        left.columnIndex - right.columnIndex
    )
  const rowRuns: TypedStagingValueRowRun[] = []
  const coordinates = new Set<string>()
  for (const cell of sorted) {
    if (
      !Number.isInteger(cell.sheetId) ||
      !Number.isInteger(cell.rowIndex) ||
      !Number.isInteger(cell.columnIndex) ||
      cell.rowIndex < 0 ||
      cell.columnIndex < 0
    ) {
      throw new Error("Typed staging value mutation contains an invalid grid coordinate.")
    }
    const coordinate = `${cell.sheetId}:${cell.rowIndex}:${cell.columnIndex}`
    if (coordinates.has(coordinate)) {
      throw new Error("Typed staging value mutation contains a duplicate grid coordinate.")
    }
    coordinates.add(coordinate)
    const blank = cell.userEnteredValue === null
    const previous = rowRuns.at(-1)
    if (
      previous &&
      previous.sheetId === cell.sheetId &&
      previous.startRowIndex === cell.rowIndex &&
      previous.endColumnIndex === cell.columnIndex &&
      previous.blank === blank
    ) {
      previous.endColumnIndex += 1
      if (!blank) previous.rows[0].push(cell.userEnteredValue!)
      continue
    }
    rowRuns.push({
      sheetId: cell.sheetId,
      startRowIndex: cell.rowIndex,
      endRowIndex: cell.rowIndex + 1,
      startColumnIndex: cell.columnIndex,
      endColumnIndex: cell.columnIndex + 1,
      blank,
      rows: blank ? [] : [[cell.userEnteredValue!]],
    })
  }

  const rectangularRuns: TypedStagingValueRowRun[] = []
  for (const run of rowRuns) {
    const previous = rectangularRuns.at(-1)
    if (
      previous &&
      previous.sheetId === run.sheetId &&
      previous.endRowIndex === run.startRowIndex &&
      previous.startColumnIndex === run.startColumnIndex &&
      previous.endColumnIndex === run.endColumnIndex &&
      previous.blank === run.blank
    ) {
      previous.endRowIndex = run.endRowIndex
      if (!run.blank) previous.rows.push(...run.rows)
      continue
    }
    rectangularRuns.push({ ...run, rows: run.rows.map((row) => [...row]) })
  }

  const requests = rectangularRuns.map((run): sheets_v4.Schema$Request => {
    if (run.blank) {
      return {
        updateCells: {
          start: {
            sheetId: run.sheetId,
            rowIndex: run.startRowIndex,
            columnIndex: run.startColumnIndex,
          },
          // Each explicit empty CellData message clears userEnteredValue via
          // the field mask. Empty/null top-level cell or row messages can be
          // dropped by client JSON serialization and reach Sheets as a no-op.
          rows: Array.from(
            { length: run.endRowIndex - run.startRowIndex },
            () => ({
              values: Array.from(
                { length: run.endColumnIndex - run.startColumnIndex },
                () => ({})
              ),
            })
          ),
          fields: "userEnteredValue",
        },
      }
    }
    return {
      updateCells: {
        start: {
          sheetId: run.sheetId,
          rowIndex: run.startRowIndex,
          columnIndex: run.startColumnIndex,
        },
        rows: run.rows.map((row) => ({
          values: row.map((userEnteredValue) => ({ userEnteredValue })),
        })),
        fields: "userEnteredValue",
      },
    }
  })
  assertAtomicStagingValueRequestBounds(requests)
  return requests
}

function assertAtomicStagingValueRequestBounds(
  requests: readonly sheets_v4.Schema$Request[]
): void {
  if (requests.length > STAGING_VALUE_MAXIMUM_MUTATION_REQUESTS) {
    throw new Error("Typed staging value mutation exceeds the atomic request-count limit.")
  }
  if (Buffer.byteLength(JSON.stringify({ requests }), "utf8") > STAGING_VALUE_MAXIMUM_MUTATION_BYTES) {
    throw new Error("Typed staging value mutation exceeds the atomic payload-size limit.")
  }
}

function exactUserEnteredValue(
  value: sheets_v4.Schema$ExtendedValue | null | undefined
): sheets_v4.Schema$ExtendedValue | null {
  if (value === undefined || value === null) return null
  const members: sheets_v4.Schema$ExtendedValue[] = []
  if (value.stringValue !== undefined && value.stringValue !== null) {
    if (typeof value.stringValue !== "string") {
      throw new Error("Google Sheets returned an invalid typed string preimage.")
    }
    members.push({ stringValue: value.stringValue })
  }
  if (value.numberValue !== undefined && value.numberValue !== null) {
    if (typeof value.numberValue !== "number" || !Number.isFinite(value.numberValue)) {
      throw new Error("Google Sheets returned an invalid typed number preimage.")
    }
    members.push({ numberValue: value.numberValue })
  }
  if (value.boolValue !== undefined && value.boolValue !== null) {
    if (typeof value.boolValue !== "boolean") {
      throw new Error("Google Sheets returned an invalid typed boolean preimage.")
    }
    members.push({ boolValue: value.boolValue })
  }
  if (value.formulaValue !== undefined && value.formulaValue !== null) {
    if (typeof value.formulaValue !== "string") {
      throw new Error("Google Sheets returned an invalid typed formula preimage.")
    }
    members.push({ formulaValue: value.formulaValue })
  }
  if (value.errorValue !== undefined && value.errorValue !== null) {
    throw new Error("Google Sheets returned an error as a user-entered value.")
  }
  if (members.length > 1) {
    throw new Error("Google Sheets returned an ambiguous typed user-entered value.")
  }
  return members[0] ?? null
}

function normalizedEffectiveValue(
  value: sheets_v4.Schema$ExtendedValue | null | undefined
): SheetCellValue {
  if (value?.errorValue !== undefined && value.errorValue !== null) {
    throw new Error("Google Sheets returned a cell error in a staging value range.")
  }
  const entered = exactUserEnteredValue(value)
  if (entered === null) return null
  if (entered.formulaValue !== undefined) {
    throw new Error("Google Sheets returned a formula as an effective cell value.")
  }
  if (entered.stringValue !== undefined) return entered.stringValue === "" ? null : entered.stringValue
  if (entered.numberValue !== undefined) return entered.numberValue
  if (entered.boolValue !== undefined) return entered.boolValue
  throw new Error("Google Sheets returned an unsupported effective cell value.")
}

function sheetScalarUserEnteredValue(
  value: SheetCellValue
): sheets_v4.Schema$ExtendedValue | null {
  const normalized = normalizeStagingSheetScalar(value)
  if (normalized === null) return null
  if (typeof normalized === "string") return { stringValue: normalized }
  if (typeof normalized === "number") return { numberValue: normalized }
  return { boolValue: normalized }
}

function sameUserEnteredValue(
  left: sheets_v4.Schema$ExtendedValue | null,
  right: sheets_v4.Schema$ExtendedValue | null
): boolean {
  if (left === null || right === null) return left === right
  return (
    left.stringValue === right.stringValue &&
    Object.is(left.numberValue, right.numberValue) &&
    left.boolValue === right.boolValue &&
    left.formulaValue === right.formulaValue
  )
}

interface BoundedStagingValueA1 {
  sheetTitle: string
  startRowIndex: number
  endRowIndex: number
  startColumnIndex: number
  endColumnIndex: number
}

function parseBoundedStagingValueA1(range: string): BoundedStagingValueA1 {
  const separator = range.lastIndexOf("!")
  if (separator <= 0) throw new Error("Staging value write requires a sheet-qualified bounded A1 range.")
  const rawTitle = range.slice(0, separator).trim()
  const sheetTitle = rawTitle.startsWith("'")
    ? unquoteStagingValueSheetTitle(rawTitle)
    : rawTitle
  const coordinates = range.slice(separator + 1).replaceAll("$", "").toUpperCase()
  const match = coordinates.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/)
  if (!sheetTitle || !match) throw new Error("Staging value write requires an exact bounded A1 range.")
  const startColumnIndex = stagingValueColumnIndex(match[1])
  const startRow = Number(match[2])
  const endColumnIndexInclusive = stagingValueColumnIndex(match[3] ?? match[1])
  const endRow = Number(match[4] ?? match[2])
  if (
    !Number.isSafeInteger(startRow) ||
    !Number.isSafeInteger(endRow) ||
    startRow <= 0 ||
    endRow < startRow ||
    endColumnIndexInclusive < startColumnIndex
  ) {
    throw new Error("Staging value write A1 bounds are invalid or reversed.")
  }
  return {
    sheetTitle,
    startRowIndex: startRow - 1,
    endRowIndex: endRow,
    startColumnIndex,
    endColumnIndex: endColumnIndexInclusive + 1,
  }
}

function unquoteStagingValueSheetTitle(value: string): string {
  if (value.length < 2 || !value.endsWith("'")) {
    throw new Error("Staging value write has a malformed quoted sheet title.")
  }
  return value.slice(1, -1).replaceAll("''", "'")
}

function stagingValueColumnIndex(label: string): number {
  let index = 0
  for (const character of label) index = index * 26 + character.charCodeAt(0) - 64
  return index - 1
}

function assertStagingValueRangeShape(
  range: BoundedStagingValueA1,
  values: readonly (readonly SheetCellValue[])[]
): void {
  const height = range.endRowIndex - range.startRowIndex
  const width = range.endColumnIndex - range.startColumnIndex
  if (
    values.length !== height ||
    values.some((row) => row.length !== width)
  ) {
    throw new Error("Staging value plan does not completely cover its bounded A1 range.")
  }
}

function rangeFingerprint(
  artifactKey: StagingSheetValuePlan["artifactKey"],
  rangeId: string,
  state: "preimage" | "desired",
  values: readonly (readonly SheetCellValue[])[]
): string {
  return createPiiFingerprint(values, {
    context: `recops:staging:${artifactKey}:${rangeId}:${state}`,
    dataProvenance: "live",
  })
}

function driveVersionOf(file: drive_v3.Schema$File): string | null {
  return file.version === undefined || file.version === null ? null : String(file.version)
}

function requiredDriveVersion(file: drive_v3.Schema$File): string {
  const version = driveVersionOf(file)?.trim()
  if (!version) throw new Error("Staging artifact Drive version is unavailable; refusing mutation.")
  normalizedDecimalDriveVersion(version)
  return version
}

function assertEditableStagingEltDocMetadata(
  file: drive_v3.Schema$File,
  expectedArtifactId: string
): void {
  if (
    file.id !== expectedArtifactId ||
    file.mimeType !== "application/vnd.google-apps.document"
  ) {
    throw new Error("Google Drive returned metadata for an unapproved staging ELT document.")
  }
  if (file.trashed === true) throw new Error("Registered staging ELT document is trashed.")
  if (file.capabilities?.canEdit !== true || file.capabilities.canModifyContent !== true) {
    throw new Error("Registered staging ELT document is not editable by the approved writer identity.")
  }
}

function assertEditableStagingSheetMetadata(
  file: drive_v3.Schema$File,
  expectedArtifactId: string
): void {
  if (file.id !== expectedArtifactId) {
    throw new Error("Google Drive returned metadata for an unapproved staging artifact.")
  }
  if (file.trashed === true) throw new Error("Registered staging sheet is trashed.")
  if (file.capabilities?.canEdit !== true || file.capabilities.canModifyContent !== true) {
    throw new Error("Registered staging sheet is not editable by the approved writer identity.")
  }
}

async function stagingStructuralPreimageRecovered(input: {
  spec: StagingStructuralNormalizationSpec
  clients: GoogleWorkspaceStagingClients
  expectedStructureFingerprint: string
  minimumDriveVersionExclusive?: string
}): Promise<{ recovered: boolean; driveVersion: string | null }> {
  let lastRejectedStableVersion: string | undefined
  let lastObservedDriveVersion: string | null = null
  const maximumAttempts = input.minimumDriveVersionExclusive
    ? STAGING_RESOLVED_SETTLEMENT_MAXIMUM_ATTEMPTS
    : STAGING_STRUCTURAL_CONSISTENCY_MAXIMUM_ATTEMPTS
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      const metadata = await readStagingDriveMetadata(input.spec.artifactKey, input.clients)
      assertEditableStagingSheetMetadata(metadata, input.spec.spreadsheetId)
      const recoveryDriveVersion = requiredDriveVersion(metadata)
      lastObservedDriveVersion = recoveryDriveVersion
      const versionAdvanced =
        input.minimumDriveVersionExclusive === undefined ||
        driveVersionAdvancedBeyond(
          recoveryDriveVersion,
          input.minimumDriveVersionExclusive
        )
      const finalAttempt = attempt === maximumAttempts - 1

      // Do not repeatedly re-read a rejected full snapshot while Drive still
      // advertises the same version. Poll cheap metadata until it advances;
      // retain one final same-version read for Sheets-after-Drive lag.
      if (
        versionAdvanced &&
        (recoveryDriveVersion !== lastRejectedStableVersion || finalAttempt)
      ) {
        const recovered = await readStagingStructuralNormalizationSnapshot(input.spec, input.clients)
        const immediateMetadata = await readStagingDriveMetadata(input.spec.artifactKey, input.clients)
        assertEditableStagingSheetMetadata(immediateMetadata, input.spec.spreadsheetId)
        const immediateDriveVersion = requiredDriveVersion(immediateMetadata)
        if (immediateDriveVersion === recoveryDriveVersion) {
          const recoveredState = projectStagingStructuralNormalizationState(
            recovered.spreadsheet,
            input.spec
          )
          const recoveredPlan = planStagingStructuralNormalization(input.spec, recoveredState)
          if (
            recoveredPlan.status === "planned" &&
            recovered.structure.structureHash === input.expectedStructureFingerprint
          ) {
            return { recovered: true, driveVersion: recoveryDriveVersion }
          }
          lastRejectedStableVersion = recoveryDriveVersion
        } else {
          lastRejectedStableVersion = undefined
        }
      }
    } catch {
      // Recovery remains fail-closed, but transient read/projection failures
      // get the same bounded eventual-consistency window as version lag.
    }
    await (input.minimumDriveVersionExclusive
      ? waitForResolvedStagingSettlementRetry(attempt)
      : waitForStagingStructuralConsistencyRetry(attempt))
  }
  return { recovered: false, driveVersion: lastObservedDriveVersion }
}

/** Three-way read of what a post-mutation structural snapshot actually shows. */
type StagingStructuralPostProjectionClassification =
  | "matches_expected_after"
  | "matches_preimage_or_other"
  | "projection_unreadable"

/**
 * The bounded outcome of polling for a settled post-mutation structural
 * state. `settled: false` still reports the last observed Drive version and
 * projection classification instead of throwing, so a caller that must never
 * compensate past a resolved forward write can certify precisely what was
 * (and was not) observed.
 */
type StagingStructuralPostStateOutcome =
  | {
      settled: true
      driveVersion: string
      classification: "matches_expected_after"
      snapshot: Awaited<ReturnType<typeof readStagingStructuralNormalizationSnapshot>>
    }
  | {
      settled: false
      driveVersion: string | null
      classification: Exclude<StagingStructuralPostProjectionClassification, "matches_expected_after">
      diagnostic?: string
    }

/**
 * A successful Sheets batchUpdate can become visible through the Sheets API
 * before Drive publishes the mutation's new file version. Poll cheap Drive
 * metadata until its version advances, then accept only a complete snapshot
 * bracketed by that same advanced version and projected to the exact expected
 * after-state. This preserves the concurrent-edit guard without treating our
 * own eventual-consistency transition as post-write drift. Never throws:
 * transient read/projection failures get the same bounded eventual-consistency
 * window as version lag (mirroring stagingStructuralPreimageRecovered below),
 * and an unsettled outcome is returned rather than raised so the caller can
 * certify exactly what was observed.
 */
async function readStableStagingStructuralPostState(
  spec: StagingStructuralNormalizationSpec,
  clients: GoogleWorkspaceStagingClients,
  authorizedPreMutationDriveVersion: string
): Promise<StagingStructuralPostStateOutcome> {
  let lastRejectedStableVersion: string | undefined
  let lastObservedDriveVersion: string | null = null
  let lastClassification: Exclude<StagingStructuralPostProjectionClassification, "matches_expected_after"> =
    "projection_unreadable"
  let lastDiagnostic: string | undefined
  for (let attempt = 0; attempt < STAGING_RESOLVED_SETTLEMENT_MAXIMUM_ATTEMPTS; attempt += 1) {
    try {
      const beforeMetadata = await readStagingDriveMetadata(spec.artifactKey, clients)
      assertEditableStagingSheetMetadata(beforeMetadata, spec.spreadsheetId)
      const beforeVersion = requiredDriveVersion(beforeMetadata)
      lastObservedDriveVersion = beforeVersion
      const finalAttempt =
        attempt === STAGING_RESOLVED_SETTLEMENT_MAXIMUM_ATTEMPTS - 1
      if (
        driveVersionAdvancedBeyond(beforeVersion, authorizedPreMutationDriveVersion) &&
        (beforeVersion !== lastRejectedStableVersion || finalAttempt)
      ) {
        const snapshot = await readStagingStructuralNormalizationSnapshot(spec, clients)
        const afterMetadata = await readStagingDriveMetadata(spec.artifactKey, clients)
        assertEditableStagingSheetMetadata(afterMetadata, spec.spreadsheetId)
        const afterVersion = requiredDriveVersion(afterMetadata)
        lastObservedDriveVersion = afterVersion
        if (
          beforeVersion === afterVersion &&
          driveVersionAdvancedBeyond(afterVersion, authorizedPreMutationDriveVersion)
        ) {
          const classified = classifyStagingStructuralPostSnapshot(spec, snapshot)
          if (classified.classification === "matches_expected_after") {
            return {
              settled: true,
              driveVersion: afterVersion,
              classification: "matches_expected_after",
              snapshot,
            }
          }
          lastClassification = classified.classification
          lastDiagnostic = classified.diagnostic
          lastRejectedStableVersion = afterVersion
        } else {
          lastRejectedStableVersion = undefined
        }
      }
    } catch (error) {
      // Recovery remains fail-closed, but transient read/projection failures
      // get the same bounded eventual-consistency window as version lag.
      lastClassification = "projection_unreadable"
      lastDiagnostic = error instanceof Error ? error.message : String(error)
    }
    await waitForResolvedStagingSettlementRetry(attempt)
  }
  return {
    settled: false,
    driveVersion: lastObservedDriveVersion,
    classification: lastClassification,
    diagnostic: lastDiagnostic,
  }
}

function classifyStagingStructuralPostSnapshot(
  spec: StagingStructuralNormalizationSpec,
  snapshot: Awaited<ReturnType<typeof readStagingStructuralNormalizationSnapshot>>
): {
  classification: StagingStructuralPostProjectionClassification
  diagnostic?: string
} {
  try {
    const state = projectStagingStructuralNormalizationState(snapshot.spreadsheet, spec)
    return planStagingStructuralNormalization(spec, state).status === "already_normalized"
      ? { classification: "matches_expected_after" }
      : { classification: "matches_preimage_or_other" }
  } catch (error) {
    return {
      classification: "projection_unreadable",
      diagnostic: error instanceof Error ? error.message : String(error),
    }
  }
}

function driveVersionAdvancedBeyond(candidate: string, baseline: string): boolean {
  const normalizedCandidate = normalizedDecimalDriveVersion(candidate)
  const normalizedBaseline = normalizedDecimalDriveVersion(baseline)
  if (normalizedCandidate.length !== normalizedBaseline.length) {
    return normalizedCandidate.length > normalizedBaseline.length
  }
  return normalizedCandidate > normalizedBaseline
}

function normalizedDecimalDriveVersion(version: string): string {
  if (!/^\d+$/.test(version)) {
    throw new Error("Staging sheet Drive version is not a decimal revision.")
  }
  return version.replace(/^0+(?=\d)/, "")
}

async function waitForStagingStructuralConsistencyRetry(attempt: number): Promise<void> {
  if (attempt >= STAGING_STRUCTURAL_CONSISTENCY_MAXIMUM_ATTEMPTS - 1) return
  const delayMs = Math.min(
    STAGING_STRUCTURAL_CONSISTENCY_BASE_DELAY_MS * (2 ** attempt),
    STAGING_STRUCTURAL_CONSISTENCY_MAX_DELAY_MS
  )
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

async function waitForResolvedStagingSettlementRetry(attempt: number): Promise<void> {
  if (attempt >= STAGING_RESOLVED_SETTLEMENT_MAXIMUM_ATTEMPTS - 1) return
  const delayMs = Math.min(
    STAGING_STRUCTURAL_CONSISTENCY_BASE_DELAY_MS * (2 ** attempt),
    STAGING_RESOLVED_SETTLEMENT_MAX_DELAY_MS
  )
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

/** Exactly one lexical Sheets structural mutation call for forward and rollback. */
async function executeStagingSheetStructuralRequests(
  clients: GoogleWorkspaceStagingClients,
  spreadsheetId: string,
  requests: readonly GoogleSheetsRequestData[]
): Promise<void> {
  if (requests.length === 0) throw new Error("Structural mutation requires non-empty bounded requests.")
  await clients.sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      includeSpreadsheetInResponse: false,
      requests: requests.map((request) => request as sheets_v4.Schema$Request),
    },
  })
}

function eltDocSnapshotOf(document: docs_v1.Schema$Document): GoogleDocsDocumentSnapshot {
  // The dry-run snapshot deliberately models only the Docs fields used by the
  // ELT guard. Google may represent absent leaf fields as null; every consumer
  // below already canonicalizes them through optional access/defaults.
  return document as unknown as GoogleDocsDocumentSnapshot
}

function assertExactEltDocSnapshot(document: GoogleDocsDocumentSnapshot): void {
  const tab = findEltDocTab(document, P1_ELT_DOC_TARGET.tabId)
  const conflicts = eltDocTargetConflicts({
    documentId: document.documentId,
    title: document.title,
    tabId: tab?.tabProperties?.tabId,
  })
  if (conflicts.length > 0) {
    throw new Error(`Google returned an unapproved ELT staging document: ${conflicts.join(" ")}`)
  }
  if (!eltDocTabTopologyIsExact(document)) {
    throw new Error("Google returned an unapproved ELT document tab topology.")
  }
}

/**
 * Locates only the exact mutation-owned top fact block needed for a rollback.
 * It deliberately does not certify fact values or formatting: those are the
 * postimage checks whose failure may require recovery. The strict adjacency
 * and structural boundaries keep narrative/history outside the candidate.
 */
function locateEltDocRollbackFactRange(
  document: GoogleDocsDocumentSnapshot,
  plan: EltDocDryRunPrivatePlan
): { tabId: string; startIndex: number; endIndex: number } {
  const tab = findEltDocTab(document, plan.tabId)
  if (!tab) throw new Error("Approved ELT document tab is missing.")
  const content = tab.documentTab?.body?.content ?? []
  // The mutated block starts where the plan put it: the planned insertion
  // point for an insert (1 at the top of the archive), the top of the document
  // for replace and no_op, whose geometry is the top block's by contract.
  const blockStart = plan.action === "insert_top_week" ? plan.insertAt!.index : 1
  const headingIndex = content.findIndex((element) => element.startIndex === blockStart)
  const heading = content[headingIndex]
  const interstitial = content[headingIndex + 1]
  const table = content[headingIndex + 2]
  const following = content[headingIndex + 3]
  const expectedTableStart =
    plan.action === "insert_top_week"
      ? blockStart + 9
      : plan.action === "replace_top_week"
        ? plan.contentGuardRange.startIndex + 1
        : plan.contentGuardRange.startIndex
  if (
    headingIndex < 0 ||
    !heading?.paragraph ||
    !interstitial?.paragraph ||
    interstitial.startIndex !== heading.endIndex ||
    table?.startIndex !== interstitial.endIndex ||
    table.startIndex !== expectedTableStart ||
    (plan.action === "replace_top_week" &&
      (interstitial.startIndex !== plan.contentGuardRange.startIndex ||
        interstitial.endIndex !== expectedTableStart)) ||
    !table.table ||
    !Number.isInteger(table.endIndex) ||
    table.endIndex! <= expectedTableStart ||
    following?.startIndex !== table.endIndex ||
    !following.paragraph
  ) {
    throw new Error("Staging ELT post-write top fact range is not uniquely rollback-safe.")
  }
  if (
    plan.action === "insert_top_week" &&
    (heading.endIndex !== blockStart + 8 ||
      interstitial.startIndex !== blockStart + 8 ||
      interstitial.endIndex !== blockStart + 9)
  ) {
    throw new Error("Staging ELT inserted fact range is not uniquely rollback-safe.")
  }
  // The mutation-owned block now runs through the Role Progress narrative
  // tail, not just the table: its exclusive end is the next archive boundary —
  // the one after the mutated block's own, wherever in the archive that sits.
  const boundaryStarts = eltDocArchiveBoundaryStartIndexes({
    document,
    tabId: plan.tabId,
    referenceGeneratedAt: plan.sourceGeneratedAt,
  })
  const blockBoundaryOrdinal = boundaryStarts.indexOf(blockStart)
  const nextBoundaryStart = blockBoundaryOrdinal >= 0
    ? boundaryStarts[blockBoundaryOrdinal + 1]
    : undefined
  if (nextBoundaryStart === undefined || nextBoundaryStart < table.endIndex!) {
    throw new Error("Staging ELT post-write next archive boundary is not uniquely rollback-safe.")
  }
  return {
    tabId: plan.tabId,
    startIndex:
      plan.action === "insert_top_week"
        ? blockStart
        : plan.action === "replace_top_week"
          ? plan.contentGuardRange.startIndex
          : expectedTableStart,
    endIndex: nextBoundaryStart,
  }
}

function eltDocDocumentMatchesPreimage(
  document: GoogleDocsDocumentSnapshot,
  plan: EltDocDryRunPrivatePlan
): boolean {
  try {
    assertExactEltDocSnapshot(document)
    return fingerprintEltDocDocumentContent(
      document,
      plan.tabId,
      plan.dataProvenance
    ) === plan.preimageDocumentFingerprint
  } catch {
    return false
  }
}

function certifiedEltDocPostimage(
  document: GoogleDocsDocumentSnapshot,
  plan: EltDocDryRunPrivatePlan
): {
  factTableRange: { tabId: string; startIndex: number; endIndex: number }
  outsideContentFingerprint: string
} | null {
  try {
    assertExactEltDocSnapshot(document)
    if (
      !document.revisionId?.trim() ||
      document.revisionId === plan.requiredRevisionId
    ) {
      return null
    }
    const factTableRange = locateEltDocRollbackFactRange(document, plan)
    const outsideContentFingerprint = fingerprintEltDocOutsideContent({
      document,
      ...factTableRange,
      dataProvenance: plan.dataProvenance,
    })
    if (outsideContentFingerprint !== plan.outsideContentFingerprint) return null
    const certifiedRange = certifyEltDocFactTablePostimage({ document, plan }).factTableRange
    if (
      certifiedRange.tabId !== factTableRange.tabId ||
      certifiedRange.startIndex !== factTableRange.startIndex ||
      certifiedRange.endIndex !== factTableRange.endIndex
    ) {
      return null
    }
    return { factTableRange, outsideContentFingerprint }
  } catch {
    return null
  }
}
