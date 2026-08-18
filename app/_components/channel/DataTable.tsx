// app/_components/channel/DataTable.tsx (GREENFIELD, 'use client')
//
// U0 semantic-table primitive (W0 frozen spec, "IA & surface architecture":87,
// identity-handoff:374 "semantic table required"). One column-config-driven
// <table>/<thead>/<tbody> that replaces the four hand-rolled CSS-grid pseudo-tables
// (ytd/agency client.tsx:512/551/607 + the referral live grid). Every styling token
// is lifted from the existing grids so the migration is pixel-stable: the
// secondary/mono/[10px]/tracking header, the hairline-soft row rules, the
// min-h row heights, the inset-ink selection rule.
//
// Canon enforced by this file (NOT by the cells):
//   - isRowSelected => NEUTRAL emphasis only. The left ink rule + card tint, never a
//     risk color (agency canon, DataTableProps:56 / frozen-spec:179).
//   - rowAccent => a LEFT RULE only (box-shadow inset), never a row fill
//     (DataTableProps:58 / frozen-spec:180). Selection and accent compose by stacking
//     two inset shadows so a selected danger row still shows both signals honestly.
//   - This component never renders 'Unknown' / 'Unknown Agency' / 'UNASSIGNED'. That
//     contract lives one layer down in cells.tsx (ActorCell); a ColumnDef.cell is the
//     only place row data becomes UI.
//
// The ColumnDef<Row> generic is guarded both by `npm run typecheck` in CI and by
// the pure-logic unit test test/channel-datatable.test.ts (nextSortState), which
// predates typechecking being (re)enabled for this repo.

'use client';

import type { ReactElement } from 'react';
import type { ColumnDef, DataTableProps } from './types';

// ---------------------------------------------------------------------------
// Pure sort-state derivation (unit-tested in test/channel-datatable.test.ts).
// ---------------------------------------------------------------------------

/**
 * Compute the next (sortBy, sortDir) when a sortable header is clicked.
 *
 * - Clicking a column that is NOT the active sort selects it descending — numeric
 *   columns (the common case) read "worst/biggest first", matching the existing
 *   `sort_dir` default of "desc" in the agency client.
 * - Clicking the ALREADY-active column toggles its direction.
 *
 * Pure: takes the clicked key + current state, returns the next state. The component
 * forwards the result to onSortChange, which writes sort_by/sort_dir to the query.
 */
export function nextSortState(
  clickedKey: string,
  current?: { sortBy?: string; sortDir?: 'asc' | 'desc' },
): { sortBy: string; sortDir: 'asc' | 'desc' } {
  if (current?.sortBy === clickedKey) {
    // Toggle only when the active column already carries a direction. An active
    // column with no direction yet resolves to the default (desc) rather than
    // jumping straight to asc, so the first user click is always "biggest first".
    if (current.sortDir == null) return { sortBy: clickedKey, sortDir: 'desc' };
    return { sortBy: clickedKey, sortDir: current.sortDir === 'asc' ? 'desc' : 'asc' };
  }
  return { sortBy: clickedKey, sortDir: 'desc' };
}

// rowAccent / selection both render as LEFT RULES via stacked inset box-shadows so
// the two signals never clobber each other and neither becomes a row fill.
const ACCENT_RULE_VAR: Record<NonNullable<ReturnType<NonNullable<DataTableProps<unknown>['rowAccent']>>>, string> = {
  danger: 'var(--danger-rule)',
  warning: 'var(--warning-rule)',
  success: 'var(--success-rule)',
  info: 'var(--info)',
};

/**
 * Compose the row's left-rule box-shadow from its (neutral) selection state and its
 * (typed) accent. Selection is the ink rule; accent is its tone rule. When both apply
 * the selection ink sits at 3px and the accent sits behind it at 6px so both read.
 * Returns undefined when neither applies (no shadow => no fill, ever).
 */
export function rowRuleShadow(
  selected: boolean,
  accent: 'danger' | 'warning' | 'success' | 'info' | null | undefined,
): string | undefined {
  const rules: string[] = [];
  if (selected) rules.push('inset 3px 0 0 var(--ink)');
  if (accent) rules.push(`inset ${selected ? 6 : 3}px 0 0 ${ACCENT_RULE_VAR[accent]}`);
  return rules.length ? rules.join(', ') : undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function colWidth(width: ColumnDef<unknown>['width']): string | undefined {
  if (width === 'flex' || width == null) return undefined; // flex/unspecified => auto-distribute
  return `${width}px`;
}

export function DataTable<Row>(props: DataTableProps<Row>): ReactElement {
  const {
    columns,
    rows,
    getRowKey,
    onRowClick,
    isRowSelected,
    rowAccent,
    sort,
    onSortChange,
    emptyLabel,
    minWidthPx,
    pagination,
  } = props;

  const interactive = typeof onRowClick === 'function';
  const colCount = columns.length;

  return (
    <div className="overflow-hidden rounded border border-border">
      {/* overflow-x wrapper + minWidthPx guard: dense tables scroll horizontally
          rather than crushing columns (frozen-spec:87, :183). */}
      <div className="overflow-x-auto">
        <table
          className="w-full border-collapse text-left text-[13px]"
          style={minWidthPx ? { minWidth: `${minWidthPx}px` } : undefined}
        >
          <colgroup>
            {columns.map((column) => (
              <col key={column.id} style={{ width: colWidth(column.width) }} />
            ))}
          </colgroup>

          {/* sticky header: the secondary mono eyebrow lifted verbatim from the grids
              (bg-secondary, [10px], tracking-[1.3px], ink-tertiary). */}
          <thead className="sticky top-0 z-10">
            <tr className="bg-secondary">
              {columns.map((column) => {
                const sortable = typeof column.sortKey === 'string' && typeof onSortChange === 'function';
                const active = sortable && sort?.sortBy === column.sortKey;
                const alignClass = column.align === 'right' ? 'text-right' : 'text-left';
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={
                      active ? (sort?.sortDir === 'asc' ? 'ascending' : 'descending') : sortable ? 'none' : undefined
                    }
                    className={`px-4 py-2.5 font-mono text-[10px] font-semibold tracking-[1.3px] text-ink-tertiary ${alignClass}`}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => {
                          const next = nextSortState(column.sortKey as string, sort);
                          onSortChange?.(next.sortBy, next.sortDir);
                        }}
                        className={`inline-flex items-center gap-1 font-mono text-[10px] font-semibold tracking-[1.3px] uppercase ${
                          column.align === 'right' ? 'flex-row-reverse' : ''
                        } ${active ? 'text-ink' : 'text-ink-tertiary hover:text-ink-secondary'}`}
                      >
                        <span>{column.header}</span>
                        <span aria-hidden="true" className="text-[8px] leading-none">
                          {active ? (sort?.sortDir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {rows.length ? (
              rows.map((row) => {
                const selected = isRowSelected?.(row) ?? false;
                const accent = rowAccent?.(row) ?? null;
                const shadow = rowRuleShadow(selected, accent);
                return (
                  <tr
                    key={getRowKey(row)}
                    onClick={interactive ? () => onRowClick?.(row) : undefined}
                    aria-selected={isRowSelected ? selected : undefined}
                    tabIndex={interactive ? 0 : undefined}
                    role={interactive ? 'button' : undefined}
                    onKeyDown={
                      interactive
                        ? (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              onRowClick?.(row);
                            }
                          }
                        : undefined
                    }
                    // selection = NEUTRAL emphasis: a faint card tint + the ink left rule.
                    // No risk-tinted backgrounds, ever (agency canon, frozen-spec:179).
                    className={`border-t border-hairline-soft ${selected ? 'bg-card' : ''} ${
                      interactive ? 'cursor-pointer hover:bg-card focus:bg-card focus:outline-none' : ''
                    }`}
                    style={shadow ? { boxShadow: shadow } : undefined}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={`px-4 py-3 align-middle ${column.align === 'right' ? 'text-right' : 'text-left'} ${
                          column.mono ? 'font-mono' : ''
                        }`}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={colCount} className="px-4 py-8 text-center text-sm text-ink-tertiary">
                  {emptyLabel}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* pagination footer lifted from ytd/agency client.tsx:657-678 (bg-card, mono
          PREVIOUS/NEXT, disabled at the edges). */}
      {pagination ? (
        <PaginationFooter
          page={pagination.page}
          pageSize={pagination.pageSize}
          total={pagination.total}
          onPage={pagination.onPage}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Pure page-window math: the 1-indexed start/end and edge guards for a page. */
export function paginationWindow(page: number, pageSize: number, total: number): {
  start: number;
  end: number;
  canBack: boolean;
  canForward: boolean;
} {
  if (total <= 0) return { start: 0, end: 0, canBack: false, canForward: false };
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return { start, end, canBack: page > 1, canForward: end < total };
}

function PaginationFooter(props: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}): ReactElement {
  const { page, pageSize, total, onPage } = props;
  const { start, end, canBack, canForward } = paginationWindow(page, pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-4 py-3 text-[12px] text-ink-secondary">
      <span>
        Showing {start}-{end} of {total}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!canBack}
          onClick={() => onPage(page - 1)}
          className="rounded border border-border px-3 py-1.5 font-mono text-[10px] font-semibold tracking-[1.2px] text-ink-secondary disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:border-ink-tertiary enabled:hover:text-ink"
        >
          PREVIOUS
        </button>
        <button
          type="button"
          disabled={!canForward}
          onClick={() => onPage(page + 1)}
          className="rounded border border-border px-3 py-1.5 font-mono text-[10px] font-semibold tracking-[1.2px] text-ink-secondary disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:border-ink-tertiary enabled:hover:text-ink"
        >
          NEXT
        </button>
      </div>
    </div>
  );
}
