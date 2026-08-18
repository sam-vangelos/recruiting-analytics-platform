// app/_components/channel/types.ts (GREENFIELD)
//
// Shared channel + table types for the U0 component system (W0 frozen spec,
// "IA & surface architecture" — Key interfaces). Pure type module: no runtime
// values, no React import beyond the `type`-only ReactNode used in cell renderers.
//
// Canon: ColumnDef.cell handles unresolved identity as a defect treatment in the
// cell renderer (ActorCell). A cell NEVER returns the literal 'Unknown' /
// 'Unknown Agency' / 'UNASSIGNED' — that contract is enforced in cells.tsx, but
// the type surface here is what every channel table is built against.

import type { ReactNode } from 'react';

/** The two analytics channels. */
export type ChannelKey = 'referrals' | 'agency';

/** Live vs. year-to-date mode within a channel. */
export type ChannelMode = 'live' | 'ytd';

/** Route base for a channel's Live segment; YTD is `${ChannelBase}/ytd`. */
export type ChannelBase = '/referrals' | '/agency';

/**
 * Column descriptor for the shared <DataTable> primitive.
 *
 * `cell` is the single point where row data becomes UI — unresolved identity is
 * rendered as a defect chip here (via ActorCell), never as a raw 'Unknown'.
 */
export interface ColumnDef<Row> {
  /** Stable column id (used as the React key for header/cell pairing). */
  id: string;
  /** Header label. */
  header: string;
  /** Fixed pixel width, or 'flex' to consume remaining space. */
  width?: number | 'flex';
  /** Text alignment; right for numerics. */
  align?: 'left' | 'right';
  /** Render the cell value in the monospace face. */
  mono?: boolean;
  /** If set, the header becomes a sort button writing this key to sort_by/sort_dir. */
  sortKey?: string;
  /** Render the cell for a given row. Unknown-as-defect lives in here, never a raw 'Unknown'. */
  cell: (row: Row) => ReactNode;
}

/** Props for the shared <DataTable> semantic-table primitive. */
export interface DataTableProps<Row> {
  /** Column descriptors, in render order. */
  columns: ColumnDef<Row>[];
  /** Row data. */
  rows: Row[];
  /** Stable React key per row. */
  getRowKey: (row: Row) => string | number;
  /** Row click handler (e.g. open a detail drawer). */
  onRowClick?: (row: Row) => void;
  /** Selected-row predicate — NEUTRAL emphasis only, never risk color (agency canon). */
  isRowSelected?: (row: Row) => boolean;
  /** Per-row accent — rendered as a LEFT RULE only, never a row fill. */
  rowAccent?: (row: Row) => 'danger' | 'warning' | 'success' | 'info' | null;
  /** Current sort state, driven by the page's query params. */
  sort?: { sortBy?: string; sortDir?: 'asc' | 'desc' };
  /** Emitted when a sortable header is clicked. */
  onSortChange?: (sortBy: string, sortDir: 'asc' | 'desc') => void;
  /** Empty-state label rendered when `rows` is empty. */
  emptyLabel: string;
  /** Minimum table width in px; enables the horizontal-scroll guard for dense tables. */
  minWidthPx?: number;
  /** Optional pagination controls. */
  pagination?: { page: number; pageSize: number; total: number; onPage: (p: number) => void };
}
