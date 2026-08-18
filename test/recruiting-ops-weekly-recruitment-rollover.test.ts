import { describe, expect, test } from "vitest"

import {
  requireAvailableWeeklyRecruitmentFriday,
  selectWeeklyRecruitmentPredecessorSheet,
  weeklyRecruitmentCycle,
  weeklyRecruitmentEndDate,
  weeklyRecruitmentSheetTitleEndDate,
  weeklyRecruitmentTargetSheetId,
  weeklyRecruitmentTargetSheetTitle,
} from "../lib/recruiting-ops/delivery/weekly-recruitment-rollover"

describe("Weekly Recruitment tab lifecycle", () => {
  test("derives the exact current Fri-Thu target and deterministic reserved id", () => {
    const cycle = weeklyRecruitmentCycle("2026-07-10")

    expect(cycle).toEqual({
      reportingWeekFriday: "2026-07-10",
      reportingWeekThursday: "2026-07-16",
      predecessorWeekFriday: "2026-07-03",
      predecessorWeekThursday: "2026-07-09",
      targetSheetTitle: "Weekly Working Report Sheet 10 Jul to 16 Jul 2026",
      targetSheetId: weeklyRecruitmentTargetSheetId("2026-07-10"),
    })
    expect(weeklyRecruitmentEndDate("2026-07-10")).toBe("2026-07-16")
    expect(weeklyRecruitmentTargetSheetTitle("2026-07-10")).toBe(
      "Weekly Working Report Sheet 10 Jul to 16 Jul 2026"
    )
    expect(weeklyRecruitmentTargetSheetId("2026-07-17")).toBe(cycle.targetSheetId + 1)
    expect(cycle.targetSheetId).toBeGreaterThanOrEqual(1_960_000_000)
    expect(cycle.targetSheetId).toBeLessThanOrEqual(2_147_483_647)
  })

  test("uses the current in-progress Friday rather than the ELT completed-week clock", () => {
    const tuesdayWtd = Date.parse("2026-07-14T16:00:00.000Z")
    expect(requireAvailableWeeklyRecruitmentFriday("2026-07-10", tuesdayWtd)).toBe(
      "2026-07-10"
    )
    expect(() =>
      requireAvailableWeeklyRecruitmentFriday("2026-07-03", tuesdayWtd)
    ).toThrow("expected 2026-07-10")
    expect(() =>
      requireAvailableWeeklyRecruitmentFriday("2026-07-17", tuesdayWtd)
    ).toThrow("not currently available")
  })

  test("keeps the target and predecessor continuous across Dec to Jan", () => {
    const december = weeklyRecruitmentCycle("2026-12-25")
    const january = weeklyRecruitmentCycle("2027-01-01")
    const sheets = [{ sheetId: december.targetSheetId, title: december.targetSheetTitle, index: 0 }]

    expect(december).toMatchObject({
      reportingWeekThursday: "2026-12-31",
      targetSheetTitle: "Weekly Working Report Sheet 25 Dec to 31 Dec 2026",
    })
    expect(january).toMatchObject({
      reportingWeekThursday: "2027-01-07",
      predecessorWeekFriday: "2026-12-25",
      predecessorWeekThursday: "2026-12-31",
      targetSheetTitle: "Weekly Working Report Sheet 01 Jan to 07 Jan 2027",
    })
    expect(january.targetSheetId).toBe(december.targetSheetId + 1)
    expect(selectWeeklyRecruitmentPredecessorSheet(sheets, "2027-01-01")).toEqual(sheets[0])
  })

  test("selects the predecessor by end date despite its inherited 02 Jul start typo", () => {
    const sheets = [
      {
        sheetId: 1994864183,
        title: "Weekly Working Report Sheet 02 Jul to 09 Jul 2026",
        index: 0,
      },
      {
        sheetId: 197029843,
        title: "Weekly Working Report Sheet 26 Jun to 02 Jul 2026",
        index: 1,
      },
    ]

    expect(selectWeeklyRecruitmentPredecessorSheet(sheets, "2026-07-10")).toEqual(
      sheets[0]
    )
    expect(
      weeklyRecruitmentSheetTitleEndDate(
        "Weekly Working Report Sheet 02 Jul to 09 Jul 2026"
      )
    ).toBe("2026-07-09")
    expect(weeklyRecruitmentSheetTitleEndDate("not a weekly tab")).toBeNull()
    expect(() =>
      selectWeeklyRecruitmentPredecessorSheet([...sheets, { ...sheets[0], sheetId: 9 }], "2026-07-10")
    ).toThrow("exactly one predecessor")
  })

  test("falls back to the newest surviving tab when the immediately prior week is missing", () => {
    const sheets = [
      {
        sheetId: 197029843,
        title: "Weekly Working Report Sheet 26 Jun to 02 Jul 2026",
        index: 0,
      },
    ]

    expect(selectWeeklyRecruitmentPredecessorSheet(sheets, "2026-07-17")).toEqual(sheets[0])
  })

  test("ignores unparseable titles instead of crashing", () => {
    const sheets = [
      { sheetId: 1, title: "Copy of Weekly Working Report Sheet 02 Jul to 09 Jul 2026", index: 0 },
      { sheetId: 2, title: "Weekly Working Report Sheet 02 Jul to 09 Jul 2026", index: 1 },
    ]

    expect(selectWeeklyRecruitmentPredecessorSheet(sheets, "2026-07-10")).toEqual(sheets[1])
  })

  test("blocks with a clear reason when no tab ends before the target week", () => {
    const sheets = [
      { sheetId: 1, title: "Weekly Working Report Sheet 10 Jul to 16 Jul 2026", index: 0 },
    ]

    expect(() => selectWeeklyRecruitmentPredecessorSheet(sheets, "2026-07-10")).toThrow(
      "found 0"
    )
    expect(() => selectWeeklyRecruitmentPredecessorSheet([], "2026-07-10")).toThrow(
      "requires at least one predecessor"
    )
  })

  test("blocks as ambiguous when two tabs tie for the newest qualifying end date", () => {
    const sheets = [
      { sheetId: 1, title: "Weekly Working Report Sheet 02 Jul to 09 Jul 2026", index: 0 },
      { sheetId: 2, title: "Weekly Working Report Sheet 03 Jul to 09 Jul 2026", index: 1 },
    ]

    expect(() => selectWeeklyRecruitmentPredecessorSheet(sheets, "2026-07-10")).toThrow(
      "tied for the newest end date"
    )
  })

  test("rejects malformed dates and non-Friday anchors", () => {
    expect(() => weeklyRecruitmentCycle("2026-07-11")).toThrow("valid Friday")
    expect(() => weeklyRecruitmentCycle("2026-02-30")).toThrow("valid Friday")
    expect(() => weeklyRecruitmentCycle("July 10, 2026")).toThrow("ISO date")
  })
})
