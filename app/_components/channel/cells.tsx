// app/_components/channel/cells.tsx (GREENFIELD)
//
// The four cell renderers from the W0 frozen spec (w0-frozen-spec:192-200), built so that
// every render DECISION lives in a PURE exported helper and the React component is a thin
// projection of that helper's output. The helpers are what test/channel-cells.test.ts
// asserts — full render (jsdom/RTL) is deferred to the pixel audit, so nothing here may
// depend on a DOM.
//
// Canon (resolution-types.ts:9-11, w0-frozen-spec:194-196, identity-handoff:25): a cell NEVER
// emits the literal "Unknown" / "Unknown Agency" / "UNASSIGNED". ActorCell is the SINGLE home
// for Unknown-as-defect — it renders a resolved name, or a defect chip derived from
// resolution_status, but never a sentinel string. The string-sentinel ban is enforced in the
// pure helper (actorDecision) so the test can prove it without rendering.
//
// Logic lifted from app/ytd/agency/client.tsx (READ for reference, NOT edited — it is the serial
// W4-2 wave): RiskPill :191-205, evidencePills :211-218, the label maps :73-96, and formatHours
// :119-123. The lift extracts the branching into helpers; RiskCell, DuplicateEvidenceCell and the
// label/tone thresholds are unchanged, so those agree with the source client. ONE deliberate
// divergence: ActionTimeCell extends the lifted formatHours with an "≈" approximate marker (driven
// by ActionTimeQuality, w0-frozen-spec:200) that the source client never rendered — when the W4-2
// fold moves the client onto this module, that marker is a product addition, not a verbatim carry.

import type { ReactElement } from 'react';
import type {
  DuplicateConfidence,
  DuplicateEvidenceType,
  FeeRiskState,
  ActionTimeQuality,
} from '@/lib/ytd-types';

// ---------------------------------------------------------------------------
// Label maps (lifted verbatim from app/ytd/agency/client.tsx:73-96)
// ---------------------------------------------------------------------------

const confidenceLabels: Record<DuplicateConfidence, string> = {
  confirmed: 'Confirmed',
  high: 'High confidence',
  possible: 'Possible',
  none: 'No duplicate',
  insufficient_data: 'Insufficient data',
};

const riskLabels: Record<FeeRiskState, string> = {
  not_duplicate: 'Not duplicate',
  cleared_in_window: 'Cleared in window',
  pending_in_window: 'Pending in window',
  at_risk: 'At risk',
  exposed: 'Exposed',
  insufficient_data: 'Insufficient data',
};

const evidenceLabels: Record<DuplicateEvidenceType, string> = {
  email_exact: 'Email',
  phone_exact: 'Phone',
  profile_url_exact: 'Profile URL',
  candidate_id: 'Same GH candidate',
  name_company_title: 'Name + company + title',
};

// ---------------------------------------------------------------------------
// ActorCell — the single home for Unknown-as-defect
// ---------------------------------------------------------------------------

// The defect-chip vocabulary. These are operator-facing labels for an UNRESOLVED actor; the
// recruiter mental model is "we couldn't pin who owns this", not "Unknown". One label per
// resolution_status. A null/absent status with a null name is still a defect (the resolver
// hasn't computed a status yet) and falls through to the generic NOT_RESOLVED label — never
// a sentinel name. resolution_status values mirror RESOLUTION_STATUS_VALUES + the agency
// narrower domain (resolution-types.ts:42-59); unrecognized strings degrade to NOT_RESOLVED.
const ACTOR_DEFECT_LABELS: Record<string, string> = {
  unresolved: 'NOT RESOLVED',
  ambiguous: 'OWNER AMBIGUOUS',
  permission_blocked: 'ACCESS BLOCKED',
};

const ACTOR_DEFECT_FALLBACK = 'NOT RESOLVED';

export type ActorRenderKind = 'resolved' | 'defect';

export interface ActorDecision {
  kind: ActorRenderKind;
  /** The resolved display name — present iff kind === 'resolved'. NEVER a sentinel string. */
  name: string | null;
  /** The defect chip label — present iff kind === 'defect'. NEVER "Unknown"/"UNASSIGNED". */
  defectLabel: string | null;
  /** The resolution_status that produced a defect (for the chip's title / provenance). */
  resolutionStatus: string | null;
  /** Whether the resolved name should carry an "inferred" confidence dot. */
  inferred: boolean;
}

// Identity is RESOLVED only when a real name is present AND the status (if supplied) is
// 'resolved'. A non-null name paired with a non-'resolved' status is still treated as a
// defect: per the contract the resolver writes name=null whenever status!=='resolved', so a
// name surviving alongside a bad status is stale and must not be trusted as resolved.
// Everything else is a defect carried as a chip — the function can NEVER return a sentinel
// string as a name.
export function actorDecision(props: {
  name: string | null | undefined;
  resolutionStatus?: string | null;
  evidence?: string[];
}): ActorDecision {
  const name = typeof props.name === 'string' ? props.name.trim() : '';
  const status = props.resolutionStatus ?? null;
  const resolved = name.length > 0 && (status === null || status === 'resolved');

  if (resolved) {
    // "inferred" downgrades a resolved name to a muted confidence dot (w0-frozen-spec:645,
    // :483). Evidence is the resolver's evidence_types; the inferred rungs are scorecard /
    // note_activity / stage_exit_actor (the inferred OWNERSHIP rungs — resolution-types.ts:72-92;
    // 'activity' is the AGENCY-source evidence tag, not an ownership rung, so it must NOT appear here).
    const inferred =
      Array.isArray(props.evidence) &&
      props.evidence.length > 0 &&
      props.evidence.every((rung) =>
        rung === 'scorecard' || rung === 'note_activity' || rung === 'stage_exit_actor'
      );
    return { kind: 'resolved', name, defectLabel: null, resolutionStatus: status, inferred };
  }

  return {
    kind: 'defect',
    name: null,
    defectLabel: (status && ACTOR_DEFECT_LABELS[status]) ?? ACTOR_DEFECT_FALLBACK,
    resolutionStatus: status,
    inferred: false,
  };
}

export function ActorCell(props: {
  name: string | null;
  resolutionStatus?: string | null;
  evidence?: string[];
}): ReactElement {
  const decision = actorDecision(props);

  if (decision.kind === 'resolved') {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="truncate font-medium text-ink">{decision.name}</span>
        {decision.inferred ? (
          <span
            aria-hidden
            title="Inferred ownership"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-tertiary"
          />
        ) : null}
      </span>
    );
  }

  return (
    <span
      title={decision.resolutionStatus ? `Resolution: ${decision.resolutionStatus}` : undefined}
      className="inline-flex items-center rounded border border-warning-rule bg-warning-bg px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-warning-fg"
    >
      {decision.defectLabel}
    </span>
  );
}

// ---------------------------------------------------------------------------
// DuplicateEvidenceCell (lifts evidencePills, client.tsx:211-218)
// ---------------------------------------------------------------------------

// Same branch order as the lifted evidencePills: insufficient_data short-circuits first, then
// the explicit evidence-type pills, then the 'none' bucket, then the confidence label as a
// last resort. Returns the LABEL list (never raw enum tokens) so the renderer is a pure map.
export function duplicateEvidencePills(props: {
  confidence: DuplicateConfidence;
  evidenceTypes: DuplicateEvidenceType[];
}): string[] {
  if (props.confidence === 'insufficient_data') return ['Insufficient identity data'];
  if (Array.isArray(props.evidenceTypes) && props.evidenceTypes.length > 0) {
    return props.evidenceTypes.map((type) => evidenceLabels[type] ?? type);
  }
  if (props.confidence === 'none') return ['No matching signals'];
  return [confidenceLabels[props.confidence] ?? props.confidence];
}

export function DuplicateEvidenceCell(props: {
  confidence: DuplicateConfidence;
  evidenceTypes: DuplicateEvidenceType[];
}): ReactElement {
  const pills = duplicateEvidencePills(props);
  return (
    <span className="flex min-w-0 flex-wrap gap-1.5">
      {pills.map((label) => (
        <span
          key={label}
          className="rounded border border-border bg-secondary px-2 py-0.5 font-mono text-[10px] font-semibold text-ink-secondary"
        >
          {label}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// RiskCell (lifts RiskPill, client.tsx:191-205)
// ---------------------------------------------------------------------------

export type RiskTone = 'danger' | 'warning' | 'neutral';

// red ONLY for 'exposed'; yellow for at_risk / pending_in_window; neutral otherwise
// (w0-frozen-spec:199). Same thresholds as the lifted RiskPill — the ONLY danger state is
// 'exposed', so cleared/not_duplicate/insufficient_data all stay neutral and never borrow the
// red treatment.
export function riskTone(state: FeeRiskState | null | undefined): RiskTone {
  if (state === 'exposed') return 'danger';
  if (state === 'at_risk' || state === 'pending_in_window') return 'warning';
  return 'neutral';
}

const RISK_TONE_CLASS: Record<RiskTone, string> = {
  danger: 'border-danger-rule bg-danger-bg text-danger-fg',
  warning: 'border-warning-rule bg-warning-bg text-warning-fg',
  neutral: 'border-border bg-secondary text-ink-secondary',
};

export function riskLabel(state: FeeRiskState | null | undefined): string {
  return state ? (riskLabels[state] ?? state) : 'Unknown risk';
}

export function RiskCell(props: { state: FeeRiskState }): ReactElement {
  const tone = riskTone(props.state);
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${RISK_TONE_CLASS[tone]}`}
    >
      {riskLabel(props.state)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ActionTimeCell (marks ActionTimeQuality === 'approximate')
// ---------------------------------------------------------------------------

// formatHours lifted verbatim from client.tsx:119-123: <24h in whole hours, else days to one
// decimal; a non-finite value is the em-dash sentinel ("—" is a display blank, not an
// identity sentinel — distinct contract). An 'approximate' quality prefixes "≈" so the
// operator reads the number as derived, not stage-exact (w0-frozen-spec:200; the
// approximate_action_time data-quality flag, ytd-types.ts:44). 'unknown' quality with a
// finite number still renders the number; quality only governs the approximate marker.
export interface ActionTimeDecision {
  /** The formatted hours/days string, or "—" when there is no measurable value. */
  text: string;
  /** True iff the value is finite AND quality is 'approximate' — drives the "≈" marker. */
  approximate: boolean;
  /** True when there is no finite value to show. */
  empty: boolean;
}

export function formatActionHours(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value < 24) return `${Math.round(value)}h`;
  return `${Math.round((value / 24) * 10) / 10}d`;
}

export function actionTimeDecision(props: {
  hours: number | null | undefined;
  quality: ActionTimeQuality;
}): ActionTimeDecision {
  const finite = typeof props.hours === 'number' && Number.isFinite(props.hours);
  return {
    text: formatActionHours(props.hours),
    approximate: finite && props.quality === 'approximate',
    empty: !finite,
  };
}

export function ActionTimeCell(props: {
  hours: number | null;
  quality: ActionTimeQuality;
}): ReactElement {
  const decision = actionTimeDecision(props);
  return (
    <span
      title={decision.approximate ? 'Approximate — derived, not stage-exact' : undefined}
      className={`font-mono ${decision.empty ? 'text-ink-tertiary' : 'text-ink-secondary'}`}
    >
      {decision.approximate ? '≈' : ''}
      {decision.text}
    </span>
  );
}
