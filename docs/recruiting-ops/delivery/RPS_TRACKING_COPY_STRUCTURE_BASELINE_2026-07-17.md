# RPS Tracking copy structural discovery — 2026-07-17

This is a read-only discovery packet for the registered RPS Tracking copy
`1ExampleDriveId00000000000000000000000000014`. It is not an approval to
mutate any downstream surface. The canonical workbook was not read or changed.

Two consecutive Sheets API reads used the approved writer identity with the
`spreadsheets.readonly` scope. Both the bounded workbook metadata and every
tab's formula/pivot projection were identical. The metadata projection
(`sheetId`, title, order, grid size, basic filter, protected ranges,
conditional formats, charts, and named ranges) had fingerprint
`sha256:1eab2e58543bb82282e5b54f8fcb437ceb97545359805269be95cff94302f7fe`
on both reads.

| Tab | Sheet ID | Grid | Formulas | Pivots |
|---|---:|---:|---:|---:|
| Data Dump | 1092300150 | 4612 × 18 | 0 | 0 |
| RPS Table | 855929445 | 998 × 26 | 0 | 1 |
| Query used | 1758439092 | 1002 × 26 | 0 | 0 |
| SOP | 230387172 | 1001 × 26 | 0 | 0 |
| Raw_Daily_RPS | 1118817092 | 2665 × 23 | 0 | 0 |
| RPS Clean | 452231539 | 4516 × 26 | 0 | 0 |
| RB_Control | 1527567736 | 1000 × 26 | 0 | 0 |
| Weekly Pivot | 895841577 | 1000 × 26 | 0 | 1 |
| Week over Week | 970309053 | 1000 × 26 | 0 | 0 |
| Leadership Summary | 1578729444 | 1000 × 26 | 0 | 0 |
| RPS Final | 1306933635 | 2987 × 82 | 0 | 0 |
| RPS Query Builder | 442729218 | 1000 × 26 | 0 | 0 |
| RPS SOP | 68387993 | 995 × 26 | 0 | 0 |
| RPS Final Pivot Source | 80796901 | 2984 × 26 | 1 | 0 |
| RPS Combined Source | 252533312 | 4752 × 26 | 3 | 0 |
| Pivot Table 2 | 1096736790 | 1000 × 26 | 0 | 1 |
| RPS Weekly Summary | 313457059 | 1000 × 25 | 1 | 0 |
| RPS Recruiter Weekly Summary | 890714013 | 1000 × 26 | 1 | 0 |
| RPS Weekly Totals | 949430878 | 1000 × 26 | 1 | 0 |
| RPS Latest Week Leaderboard | 577119363 | 1000 × 26 | 2 | 0 |
| RPS WoW comparison | 747244570 | 1000 × 26 | 67 | 0 |
| RPS Daily Tracker | 1557034869 | 1000 × 25 | 1 | 0 |
| RPS Daily Recruiter | 288135337 | 1000 × 26 | 1 | 0 |

## Finding and stop gate

The observed workbook contradicts the proposed renderer assumption:
`RPS Clean` and `RPS Final` contain no Sheets formulas or pivots. They are
materialized literal-value surfaces. The three observed pivots are on
`RPS Table`, `Weekly Pivot`, and `Pivot Table 2`; additional downstream summary
tabs contain sparse formulas. The existing platform writer owns only
`Data Dump`, and the accepted source clock already supplies the full
`created_at` timestamp with `submitted_at` fallback. The time-only defect is
therefore downstream of the accepted source/value boundary.

Full-workbook automatic mutation remains fail-closed until an approved packet
defines:

1. the deterministic producer and complete value contract for the literal
   `RPS Clean` and `RPS Final` surfaces;
2. the exact full-timestamp transformation and retained/manual columns;
3. formula extension and pivot-source changes for every dependent surface;
4. post-recalculation reconciliations, bounded settlement, retry behavior, and
   exact no-op evidence; and
5. explicit copy-only approval of that before/after contract.

Do not infer this renderer from tab names, documentation, or the canonical.
Until the gate closes, retain the certified `Data Dump`-only path and keep the
RPS write flag out of scheduled write eligibility.
