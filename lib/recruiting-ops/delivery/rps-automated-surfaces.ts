import { createStableChecksum } from "../checksums"
import type { GoogleSheetsRequestData } from "./staging-structural-normalization"
import { getStagingArtifact } from "./staging-artifact-registry"

export type RpsAutomatedSurfaceMode = "plan" | "apply"

export const RPS_AUTOMATED_SURFACE_SPREADSHEET_ID =
  getStagingArtifact("rps_tracking").artifactId
export const RPS_DATA_DUMP_SHEET_ID = 1_092_300_150
export const RPS_AUTOMATED_CLEAN_SHEET_ID = 2_047_072_301
export const RPS_AUTOMATED_SUMMARY_SHEET_ID = 2_047_072_302
export const RPS_AUTOMATED_CLEAN_TITLE = "Automated RPS Clean"
export const RPS_AUTOMATED_SUMMARY_TITLE = "Automated RPS Summary"
export const RPS_AUTOMATED_CLEAN_FORMULA =
  "=FILTER('Data Dump'!A:R,LEN('Data Dump'!A:A))"
export const RPS_AUTOMATED_SUMMARY_FORMULA =
  "=QUERY('Automated RPS Clean'!A:R,\"select P,O,K,N,count(A) where A is not null group by P,O,K,N order by P,O,K,N label P 'Week Order', O 'Week', K 'Submitter', N 'Team', count(A) 'RPS Count'\",1)"

export const RPS_DATA_DUMP_HEADERS = Object.freeze([
  "candidate_name",
  "job_name",
  "requisition_id",
  "status",
  "recruiters",
  "sourcers",
  "interview_name",
  "interviewer",
  "scheduled_interview_ended_at",
  "submitted_at",
  "submitter",
  "match_mismatch",
  "month",
  "submitter_team_name",
  "week",
  "week_order",
  "qa_summary",
  "key_takeaways",
] as const)

export interface RpsAutomatedSurfaceDriveMetadata {
  readonly id?: string | null
  readonly version?: string | number | null
  readonly mimeType?: string | null
  readonly trashed?: boolean | null
  readonly capabilities?: {
    readonly canEdit?: boolean | null
    readonly canModifyContent?: boolean | null
  } | null
}

export interface RpsAutomatedSurfaceSheet {
  readonly sheetId?: number | null
  readonly title?: string | null
  readonly rowCount?: number | null
  readonly columnCount?: number | null
  readonly frozenRowCount?: number | null
}

export interface RpsAutomatedSurfaceSpreadsheet {
  readonly spreadsheetId?: string | null
  readonly sheets: readonly RpsAutomatedSurfaceSheet[]
}

export interface RpsAutomatedSurfaceValueRanges {
  readonly dataDump: readonly (readonly unknown[])[]
  readonly clean: readonly (readonly unknown[])[]
  readonly summary: readonly (readonly unknown[])[]
}

export interface RpsAutomatedSurfaceAdapter {
  readDriveMetadata(): Promise<RpsAutomatedSurfaceDriveMetadata>
  readSpreadsheet(): Promise<RpsAutomatedSurfaceSpreadsheet>
  readDataDumpHeader(): Promise<readonly unknown[]>
  readFormulaAnchors(): Promise<{
    readonly clean: string | null
    readonly summary: string | null
  }>
  readValueRanges(): Promise<RpsAutomatedSurfaceValueRanges>
  createSurfaces(rowCount: number): Promise<void>
  deleteSurfaces(sheetIds: readonly number[]): Promise<void>
}

export interface RunRpsAutomatedSurfaceSetupInput {
  readonly adapter: RpsAutomatedSurfaceAdapter
  readonly mode?: RpsAutomatedSurfaceMode
  readonly expectedDriveVersion?: string
  readonly sleep?: (delayMs: number) => Promise<void>
}

export interface RpsAutomatedSurfaceSetupResult {
  readonly spreadsheetId: string
  readonly status: "planned" | "written" | "no_change"
  readonly beforeDriveVersion: string
  readonly afterDriveVersion: string
  readonly formulaSha256: string
  readonly cleanRows?: number
  readonly summaryRows?: number
  readonly summaryCount?: number
}

export function rpsAutomatedSurfaceFormulaSha256(): string {
  return createStableChecksum(
    `${RPS_AUTOMATED_CLEAN_FORMULA}\n${RPS_AUTOMATED_SUMMARY_FORMULA}`
  )
}

export function rpsAutomatedSurfaceCreationRequests(
  rowCount: number
): readonly GoogleSheetsRequestData[] {
  if (!Number.isInteger(rowCount) || rowCount < 1) {
    throw new Error("RPS automated surfaces require a positive integer row count.")
  }
  return Object.freeze([
    {
      addSheet: {
        properties: {
          sheetId: RPS_AUTOMATED_CLEAN_SHEET_ID,
          title: RPS_AUTOMATED_CLEAN_TITLE,
          gridProperties: { rowCount, columnCount: 18, frozenRowCount: 1 },
        },
      },
    },
    {
      addSheet: {
        properties: {
          sheetId: RPS_AUTOMATED_SUMMARY_SHEET_ID,
          title: RPS_AUTOMATED_SUMMARY_TITLE,
          gridProperties: { rowCount, columnCount: 5, frozenRowCount: 1 },
        },
      },
    },
    formulaRequest(RPS_AUTOMATED_CLEAN_SHEET_ID, RPS_AUTOMATED_CLEAN_FORMULA),
    formulaRequest(RPS_AUTOMATED_SUMMARY_SHEET_ID, RPS_AUTOMATED_SUMMARY_FORMULA),
  ])
}

export function rpsAutomatedSurfaceDeletionRequests(
  sheetIds: readonly number[]
): readonly GoogleSheetsRequestData[] {
  const required = [
    RPS_AUTOMATED_CLEAN_SHEET_ID,
    RPS_AUTOMATED_SUMMARY_SHEET_ID,
  ] as const
  const observed = new Set(sheetIds)
  if (
    sheetIds.length !== required.length ||
    observed.size !== required.length ||
    required.some((sheetId) => !observed.has(sheetId))
  ) {
    throw new Error("RPS automated-surface rollback requires the exact reserved tab pair.")
  }
  return required.map((sheetId) => ({ deleteSheet: { sheetId } }))
}

export async function runRpsAutomatedSurfaceSetup(
  input: RunRpsAutomatedSurfaceSetupInput
): Promise<RpsAutomatedSurfaceSetupResult> {
  const mode = input.mode ?? "plan"
  const sleep = input.sleep ?? defaultSleep

  const [beforeDrive, spreadsheet, header] = await Promise.all([
    input.adapter.readDriveMetadata(),
    input.adapter.readSpreadsheet(),
    input.adapter.readDataDumpHeader(),
  ])
  const beforeDriveVersion = assertTargetAndDriveMetadata(
    beforeDrive,
    spreadsheet
  )
  if (stableRows([header]) !== stableRows([RPS_DATA_DUMP_HEADERS])) {
    throw new Error("RPS Data Dump headers drifted from the automated-surface contract.")
  }
  const state = inspectRpsAutomatedSurfaceState(spreadsheet)

  if (state.status === "present") {
    const reconciled = await verifyRpsAutomatedSurfaces(input.adapter)
    const afterDrive = await input.adapter.readDriveMetadata()
    const afterDriveVersion = requiredStableDriveVersion(
      afterDrive,
      beforeDriveVersion
    )
    return {
      spreadsheetId: RPS_AUTOMATED_SURFACE_SPREADSHEET_ID,
      status: "no_change",
      beforeDriveVersion,
      afterDriveVersion,
      formulaSha256: rpsAutomatedSurfaceFormulaSha256(),
      ...reconciled,
    }
  }

  if (mode === "plan") {
    return {
      spreadsheetId: RPS_AUTOMATED_SURFACE_SPREADSHEET_ID,
      status: "planned",
      beforeDriveVersion,
      afterDriveVersion: beforeDriveVersion,
      formulaSha256: rpsAutomatedSurfaceFormulaSha256(),
    }
  }

  const expectedDriveVersion = requiredExpectedDriveVersion(
    input.expectedDriveVersion
  )
  if (expectedDriveVersion !== beforeDriveVersion) {
    throw new Error("RPS automated-surface Drive version changed since the approved plan.")
  }
  const immediateDrive = await input.adapter.readDriveMetadata()
  requiredStableDriveVersion(
    immediateDrive,
    expectedDriveVersion
  )

  let creationConfirmed = false
  try {
    await input.adapter.createSurfaces(state.outputRowCount)
    creationConfirmed = true
    const settled = await settleRpsAutomatedSurfaces({
      adapter: input.adapter,
      beforeDriveVersion,
      sleep,
    })
    return {
      spreadsheetId: RPS_AUTOMATED_SURFACE_SPREADSHEET_ID,
      status: "written",
      beforeDriveVersion,
      afterDriveVersion: settled.afterDriveVersion,
      formulaSha256: rpsAutomatedSurfaceFormulaSha256(),
      cleanRows: settled.cleanRows,
      summaryRows: settled.summaryRows,
      summaryCount: settled.summaryCount,
    }
  } catch (error) {
    const rollback = creationConfirmed
      ? await rollbackRpsAutomatedSurfaces(input.adapter, beforeDriveVersion)
        .catch(() => "failed")
      : "not_owned"
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `RPS automated-surface setup failed; rollback=${rollback}: ${safeMessage(message)}`
    )
  }
}

function inspectRpsAutomatedSurfaceState(
  spreadsheet: RpsAutomatedSurfaceSpreadsheet
):
  | {
      readonly status: "absent"
      readonly outputRowCount: number
    }
  | {
      readonly status: "present"
      readonly outputRowCount: number
    } {
  const dataDump = exactSheet(spreadsheet.sheets, "Data Dump", RPS_DATA_DUMP_SHEET_ID)
  const dataRowCount = positiveInteger(dataDump.rowCount, "RPS Data Dump row count")
  if (positiveInteger(dataDump.columnCount, "RPS Data Dump column count") < 18) {
    throw new Error("RPS Data Dump no longer exposes the expected A:R source.")
  }

  const clean = optionalExactSheet(
    spreadsheet.sheets,
    RPS_AUTOMATED_CLEAN_TITLE,
    RPS_AUTOMATED_CLEAN_SHEET_ID
  )
  const summary = optionalExactSheet(
    spreadsheet.sheets,
    RPS_AUTOMATED_SUMMARY_TITLE,
    RPS_AUTOMATED_SUMMARY_SHEET_ID
  )
  if (Boolean(clean) !== Boolean(summary)) {
    throw new Error("RPS automated surfaces are in a partial state.")
  }

  // ponytail: 10,000 rows cover the current ~3,600-row ledger; increase this
  // one ceiling if the source approaches it.
  const outputRowCount = Math.max(10_000, dataRowCount)
  if (!clean || !summary) return { status: "absent", outputRowCount }

  assertOutputSheet(clean, 18, outputRowCount)
  assertOutputSheet(summary, 5, outputRowCount)
  return { status: "present", outputRowCount }
}

async function settleRpsAutomatedSurfaces(input: {
  adapter: RpsAutomatedSurfaceAdapter
  beforeDriveVersion: string
  sleep: (delayMs: number) => Promise<void>
}): Promise<{
  cleanRows: number
  summaryRows: number
  summaryCount: number
  afterDriveVersion: string
}> {
  let lastError = "RPS automated surfaces did not settle."
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) await input.sleep(2_000)
    try {
      const metadataBefore = await input.adapter.readDriveMetadata()
      const stableVersion = requiredAdvancedDriveVersion(
        metadataBefore,
        input.beforeDriveVersion
      )
      const spreadsheet = await input.adapter.readSpreadsheet()
      assertTargetSpreadsheet(spreadsheet)
      const state = inspectRpsAutomatedSurfaceState(spreadsheet)
      if (state.status !== "present") {
        throw new Error("RPS automated surfaces are not both present.")
      }
      const reconciled = await verifyRpsAutomatedSurfaces(input.adapter)
      requiredStableDriveVersion(
        await input.adapter.readDriveMetadata(),
        stableVersion
      )
      return { ...reconciled, afterDriveVersion: stableVersion }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(lastError)
}

async function verifyRpsAutomatedSurfaces(
  adapter: RpsAutomatedSurfaceAdapter
): Promise<{ cleanRows: number; summaryRows: number; summaryCount: number }> {
  const [formulas, values] = await Promise.all([
    adapter.readFormulaAnchors(),
    adapter.readValueRanges(),
  ])
  if (
    formulas.clean !== RPS_AUTOMATED_CLEAN_FORMULA ||
    formulas.summary !== RPS_AUTOMATED_SUMMARY_FORMULA
  ) {
    throw new Error("RPS automated formula anchors drifted.")
  }
  return reconcileRpsAutomatedSurfaceValues(values)
}

export function reconcileRpsAutomatedSurfaceValues(
  input: RpsAutomatedSurfaceValueRanges
): { cleanRows: number; summaryRows: number; summaryCount: number } {
  const dataDump = normalizedRows(input.dataDump)
  const clean = normalizedRows(input.clean)
  const summary = normalizedRows(input.summary)
  if (
    dataDump.length === 0 ||
    stableRows([dataDump[0]]) !== stableRows([RPS_DATA_DUMP_HEADERS])
  ) {
    throw new Error("RPS Data Dump headers drifted during automated-surface verification.")
  }
  const expectedClean = dataDump.filter(
    (row) => row[0] !== undefined && row[0] !== ""
  )

  if (expectedClean.length < 2 || stableRows(clean) !== stableRows(expectedClean)) {
    throw new Error("Automated RPS Clean does not match the filtered Data Dump source.")
  }
  const expectedSummaryHeader = [
    "Week Order",
    "Week",
    "Submitter",
    "Team",
    "RPS Count",
  ]
  if (
    summary.length < 2 ||
    stableRows([summary[0]]) !== stableRows([expectedSummaryHeader])
  ) {
    throw new Error("Automated RPS Summary header or rows did not settle.")
  }

  const expectedCounts = new Map(
    groupedRpsSummaryRows(expectedClean.slice(1)).map((row) => [
      stableRows([row.slice(0, 4)]),
      Number(row[4]),
    ])
  )
  const actualKeys = new Set<string>()
  for (const row of summary.slice(1)) {
    const key = stableRows([row.slice(0, 4)])
    const count = Number(row[4])
    if (actualKeys.has(key) || !Number.isSafeInteger(count) || count < 1) {
      throw new Error("Automated RPS Summary contains a duplicate or invalid group.")
    }
    actualKeys.add(key)
    if (expectedCounts.get(key) !== count) {
      throw new Error("Automated RPS Summary values do not reconcile to Clean.")
    }
    expectedCounts.delete(key)
  }
  if (expectedCounts.size !== 0) {
    throw new Error("Automated RPS Summary values do not reconcile to Clean.")
  }
  const summaryCount = summary
    .slice(1)
    .reduce((total, row) => total + Number(row[4]), 0)
  if (summaryCount !== expectedClean.length - 1) {
    throw new Error("Automated RPS Summary count does not equal Clean data rows.")
  }
  return {
    cleanRows: expectedClean.length - 1,
    summaryRows: summary.length - 1,
    summaryCount,
  }
}

async function rollbackRpsAutomatedSurfaces(
  adapter: RpsAutomatedSurfaceAdapter,
  beforeDriveVersion: string
): Promise<"deleted_new_tabs" | "nothing_applied"> {
  const metadataBefore = await adapter.readDriveMetadata()
  const before = await adapter.readSpreadsheet()
  assertTargetSpreadsheet(before)
  const deletable = rollbackSheetIds(before.sheets)
  if (deletable.length === 0) return "nothing_applied"
  const ownedVersion = requiredAdvancedDriveVersion(
    metadataBefore,
    beforeDriveVersion
  )
  const formulas = await adapter.readFormulaAnchors()
  if (
    formulas.clean !== RPS_AUTOMATED_CLEAN_FORMULA ||
    formulas.summary !== RPS_AUTOMATED_SUMMARY_FORMULA
  ) {
    throw new Error("RPS rollback cannot prove ownership of the automated tabs.")
  }
  requiredStableDriveVersion(await adapter.readDriveMetadata(), ownedVersion)
  await adapter.deleteSurfaces(deletable)
  const after = await adapter.readSpreadsheet()
  assertTargetSpreadsheet(after)
  if (rollbackSheetIds(after.sheets).length > 0) {
    throw new Error("RPS automated-surface rollback did not remove the exact new tabs.")
  }
  return "deleted_new_tabs"
}

function rollbackSheetIds(sheets: readonly RpsAutomatedSurfaceSheet[]): number[] {
  const expected = new Map([
    [RPS_AUTOMATED_CLEAN_SHEET_ID, RPS_AUTOMATED_CLEAN_TITLE],
    [RPS_AUTOMATED_SUMMARY_SHEET_ID, RPS_AUTOMATED_SUMMARY_TITLE],
  ])
  const deletable: number[] = []
  for (const sheet of sheets) {
    const sheetId = sheet.sheetId
    const title = sheet.title
    const expectedTitle = sheetId === null || sheetId === undefined
      ? undefined
      : expected.get(sheetId)
    if (expectedTitle !== undefined) {
      if (title !== expectedTitle) {
        throw new Error("Reserved RPS rollback identity drifted.")
      }
      deletable.push(sheetId as number)
    } else if (
      title === RPS_AUTOMATED_CLEAN_TITLE ||
      title === RPS_AUTOMATED_SUMMARY_TITLE
    ) {
      throw new Error("RPS rollback title is bound to an unexpected sheet identity.")
    }
  }
  if (deletable.length === 1) {
    throw new Error("RPS rollback refuses a partial reserved-tab state.")
  }
  return deletable
}

function exactSheet(
  sheets: readonly RpsAutomatedSurfaceSheet[],
  title: string,
  sheetId: number
): RpsAutomatedSurfaceSheet {
  const sheet = optionalExactSheet(sheets, title, sheetId)
  if (!sheet) throw new Error(`RPS setup requires the exact ${title} tab.`)
  return sheet
}

function optionalExactSheet(
  sheets: readonly RpsAutomatedSurfaceSheet[],
  title: string,
  sheetId: number
): RpsAutomatedSurfaceSheet | null {
  const byTitle = sheets.filter((sheet) => sheet.title === title)
  const byId = sheets.filter((sheet) => sheet.sheetId === sheetId)
  if (byTitle.length > 1 || byId.length > 1) {
    throw new Error(`RPS ${title} tab identity is ambiguous.`)
  }
  if (byTitle.length === 0 && byId.length === 0) return null
  if (
    byTitle.length !== 1 ||
    byId.length !== 1 ||
    byTitle[0] !== byId[0]
  ) {
    throw new Error(`RPS ${title} tab identity drifted.`)
  }
  return byTitle[0]
}

function assertOutputSheet(
  sheet: RpsAutomatedSurfaceSheet,
  columnCount: number,
  minimumRowCount: number
): void {
  if (
    positiveInteger(sheet.rowCount, "RPS automated output row count") <
      minimumRowCount ||
    positiveInteger(sheet.columnCount, "RPS automated output column count") !==
      columnCount ||
    sheet.frozenRowCount !== 1
  ) {
    throw new Error("RPS automated output grid structure drifted.")
  }
}

function assertTargetAndDriveMetadata(
  metadata: RpsAutomatedSurfaceDriveMetadata,
  spreadsheet: RpsAutomatedSurfaceSpreadsheet
): string {
  assertTargetSpreadsheet(spreadsheet)
  return requiredDriveVersion(metadata)
}

function assertTargetSpreadsheet(
  spreadsheet: RpsAutomatedSurfaceSpreadsheet
): void {
  if (spreadsheet.spreadsheetId !== RPS_AUTOMATED_SURFACE_SPREADSHEET_ID) {
    throw new Error("Google Sheets returned an unapproved RPS workbook.")
  }
}

function requiredDriveVersion(
  metadata: RpsAutomatedSurfaceDriveMetadata
): string {
  if (
    metadata.id !== RPS_AUTOMATED_SURFACE_SPREADSHEET_ID ||
    metadata.mimeType !== "application/vnd.google-apps.spreadsheet"
  ) {
    throw new Error("Google Drive returned an unapproved RPS workbook.")
  }
  if (metadata.trashed === true) throw new Error("The exact RPS workbook is trashed.")
  if (
    metadata.capabilities?.canEdit !== true ||
    metadata.capabilities.canModifyContent !== true
  ) {
    throw new Error("The approved RPS writer cannot edit the exact target workbook.")
  }
  const version = String(metadata.version ?? "").trim()
  if (!/^\d+$/.test(version)) {
    throw new Error("RPS workbook Drive version is unavailable or invalid.")
  }
  return version.replace(/^0+(?=\d)/, "")
}

function requiredStableDriveVersion(
  metadata: RpsAutomatedSurfaceDriveMetadata,
  expected: string
): string {
  const observed = requiredDriveVersion(metadata)
  if (observed !== expected) {
    throw new Error("RPS workbook Drive version changed during setup preflight.")
  }
  return observed
}

function requiredAdvancedDriveVersion(
  metadata: RpsAutomatedSurfaceDriveMetadata,
  baseline: string
): string {
  const observed = requiredDriveVersion(metadata)
  if (compareDecimalVersions(observed, baseline) <= 0) {
    throw new Error("RPS workbook Drive version did not advance after setup.")
  }
  return observed
}

function compareDecimalVersions(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length
  return left < right ? -1 : left > right ? 1 : 0
}

function requiredExpectedDriveVersion(value: string | undefined): string {
  const version = value?.trim() ?? ""
  if (!/^\d+$/.test(version)) {
    throw new Error("Apply mode requires an exact decimal expected Drive version.")
  }
  return version.replace(/^0+(?=\d)/, "")
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value as number
}

function groupedRpsSummaryRows(
  rows: readonly (readonly NormalizedCell[])[]
): NormalizedCell[][] {
  const groups = new Map<
    string,
    {
      cells: [NormalizedCell, NormalizedCell, NormalizedCell, NormalizedCell]
      count: number
    }
  >()
  for (const row of rows) {
    if (row[0] === "") continue
    const cells: [NormalizedCell, NormalizedCell, NormalizedCell, NormalizedCell] = [
      row[15] ?? "",
      row[14] ?? "",
      row[10] ?? "",
      row[13] ?? "",
    ]
    const key = stableRows([cells])
    const group = groups.get(key)
    if (group) group.count += 1
    else groups.set(key, { cells, count: 1 })
  }
  return [...groups.values()].map((group) => [...group.cells, group.count])
}

type NormalizedCell = string | number | boolean

function normalizedRows(
  rows: readonly (readonly unknown[])[]
): NormalizedCell[][] {
  const normalized = rows.map((row) => row.map(normalizeCell))
  while (
    normalized.length > 0 &&
    normalized.at(-1)?.every((value) => value === "")
  ) {
    normalized.pop()
  }
  return normalized.map((row) => {
    const result = [...row]
    while (result.length > 0 && result.at(-1) === "") result.pop()
    return result
  })
}

function normalizeCell(value: unknown): NormalizedCell {
  if (value === null || value === undefined) return ""
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }
  return String(value)
}

function stableRows(value: unknown): string {
  return JSON.stringify(value)
}

function formulaRequest(
  sheetId: number,
  formulaValue: string
): GoogleSheetsRequestData {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: 0,
        endRowIndex: 1,
        startColumnIndex: 0,
        endColumnIndex: 1,
      },
      rows: [{ values: [{ userEnteredValue: { formulaValue } }] }],
      fields: "userEnteredValue",
    },
  }
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

function safeMessage(message: string): string {
  return message.replace(/[\r\n]+/g, " ").slice(0, 500)
}
