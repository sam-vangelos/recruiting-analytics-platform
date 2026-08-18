// Unit tests for the PURE decision helpers behind app/_components/channel/cells.tsx
// (w0-frozen-spec:192-200). Pure-logic only — no jsdom / react-testing-library; the cells'
// full render is verified in the pixel audit. These tests pin the decision logic the React
// components are thin projections of: the Unknown-as-defect contract (ActorCell), the
// duplicate-evidence pill map, the risk-color decision, and the approximate-action marker.
//
// The load-bearing assertion is the string-sentinel ban (resolution-types.ts:9-11): for an
// unresolved or null actor, actorDecision must return a DEFECT and must NEVER surface the
// literal "Unknown" / "Unknown Agency" / "UNASSIGNED" as a name or label.

import { describe, expect, test } from 'vitest';
import {
  actorDecision,
  duplicateEvidencePills,
  riskTone,
  riskLabel,
  actionTimeDecision,
  formatActionHours,
} from '../app/_components/channel/cells';
import type {
  DuplicateConfidence,
  DuplicateEvidenceType,
  FeeRiskState,
  ActionTimeQuality,
} from '../lib/ytd-types';

const SENTINELS = ['Unknown', 'Unknown Agency', 'UNASSIGNED'];

function assertNoSentinel(value: string | null | undefined): void {
  if (value == null) return;
  for (const sentinel of SENTINELS) {
    expect(value).not.toBe(sentinel);
  }
}

// ---------------------------------------------------------------------------
// ActorCell — Unknown-as-defect
// ---------------------------------------------------------------------------

describe('actorDecision — the single home for Unknown-as-defect', () => {
  test('a null name is a defect, never a sentinel string', () => {
    const decision = actorDecision({ name: null });
    expect(decision.kind).toBe('defect');
    expect(decision.name).toBeNull();
    expect(decision.defectLabel).toBe('NOT RESOLVED');
    assertNoSentinel(decision.name);
    assertNoSentinel(decision.defectLabel);
  });

  test('an empty / whitespace name is a defect', () => {
    for (const name of ['', '   ', undefined]) {
      const decision = actorDecision({ name });
      expect(decision.kind).toBe('defect');
      expect(decision.name).toBeNull();
      assertNoSentinel(decision.name);
      assertNoSentinel(decision.defectLabel);
    }
  });

  test('the literal sentinel strings are never returned for any unresolved status', () => {
    for (const status of ['unresolved', 'ambiguous', 'permission_blocked', 'failed', null]) {
      const decision = actorDecision({ name: null, resolutionStatus: status });
      expect(decision.kind).toBe('defect');
      assertNoSentinel(decision.name);
      assertNoSentinel(decision.defectLabel);
      expect(decision.defectLabel).toBeTruthy();
    }
  });

  test('each known unresolved status maps to its operator-vocabulary defect label', () => {
    expect(actorDecision({ name: null, resolutionStatus: 'unresolved' }).defectLabel).toBe(
      'NOT RESOLVED'
    );
    expect(actorDecision({ name: null, resolutionStatus: 'ambiguous' }).defectLabel).toBe(
      'OWNER AMBIGUOUS'
    );
    expect(
      actorDecision({ name: null, resolutionStatus: 'permission_blocked' }).defectLabel
    ).toBe('ACCESS BLOCKED');
  });

  test('an unrecognized status degrades to the generic NOT RESOLVED label, not a sentinel', () => {
    const decision = actorDecision({ name: null, resolutionStatus: 'weird_value' });
    expect(decision.kind).toBe('defect');
    expect(decision.defectLabel).toBe('NOT RESOLVED');
    assertNoSentinel(decision.defectLabel);
  });

  test('a real name with no status is resolved', () => {
    const decision = actorDecision({ name: 'Dana Recruiter' });
    expect(decision.kind).toBe('resolved');
    expect(decision.name).toBe('Dana Recruiter');
    expect(decision.defectLabel).toBeNull();
    expect(decision.inferred).toBe(false);
  });

  test('a real name with status resolved is resolved', () => {
    const decision = actorDecision({ name: 'Dana Recruiter', resolutionStatus: 'resolved' });
    expect(decision.kind).toBe('resolved');
    expect(decision.name).toBe('Dana Recruiter');
  });

  test('a stale name paired with a non-resolved status is treated as a defect', () => {
    // The resolver writes name=null whenever status!=='resolved'; a name surviving alongside
    // a bad status is stale and must not be trusted.
    const decision = actorDecision({ name: 'Stale Name', resolutionStatus: 'ambiguous' });
    expect(decision.kind).toBe('defect');
    expect(decision.name).toBeNull();
    assertNoSentinel(decision.name);
  });

  test('inferred-only evidence downgrades a resolved name to the confidence-dot treatment', () => {
    const decision = actorDecision({
      name: 'Dana Recruiter',
      resolutionStatus: 'resolved',
      evidence: ['scorecard', 'note_activity'],
    });
    expect(decision.kind).toBe('resolved');
    expect(decision.inferred).toBe(true);
  });

  test('a confirmed rung in the evidence keeps the name un-downgraded', () => {
    const decision = actorDecision({
      name: 'Dana Recruiter',
      resolutionStatus: 'resolved',
      evidence: ['owner_match', 'scorecard'],
    });
    expect(decision.inferred).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DuplicateEvidenceCell — the pill map
// ---------------------------------------------------------------------------

describe('duplicateEvidencePills — the evidence pill map', () => {
  test('insufficient_data short-circuits before any evidence type', () => {
    const pills = duplicateEvidencePills({
      confidence: 'insufficient_data',
      // even with evidence types present, insufficient_data wins
      evidenceTypes: ['email_exact'],
    });
    expect(pills).toEqual(['Insufficient identity data']);
  });

  test('each evidence type maps to its human label', () => {
    const cases: Array<[DuplicateEvidenceType, string]> = [
      ['email_exact', 'Email'],
      ['phone_exact', 'Phone'],
      ['profile_url_exact', 'Profile URL'],
      ['candidate_id', 'Same GH candidate'],
      ['name_company_title', 'Name + company + title'],
    ];
    for (const [type, label] of cases) {
      expect(duplicateEvidencePills({ confidence: 'high', evidenceTypes: [type] })).toEqual([
        label,
      ]);
    }
  });

  test('multiple evidence types map in order', () => {
    const pills = duplicateEvidencePills({
      confidence: 'confirmed',
      evidenceTypes: ['email_exact', 'phone_exact'],
    });
    expect(pills).toEqual(['Email', 'Phone']);
  });

  test('confidence none with no evidence reads as no matching signals', () => {
    expect(duplicateEvidencePills({ confidence: 'none', evidenceTypes: [] })).toEqual([
      'No matching signals',
    ]);
  });

  test('a confidence with no evidence falls back to the confidence label', () => {
    expect(duplicateEvidencePills({ confidence: 'possible', evidenceTypes: [] })).toEqual([
      'Possible',
    ]);
  });
});

// ---------------------------------------------------------------------------
// RiskCell — the color decision
// ---------------------------------------------------------------------------

describe('riskTone — risk color decision', () => {
  test('red (danger) ONLY for exposed', () => {
    expect(riskTone('exposed')).toBe('danger');
  });

  test('yellow (warning) for at_risk and pending_in_window', () => {
    expect(riskTone('at_risk')).toBe('warning');
    expect(riskTone('pending_in_window')).toBe('warning');
  });

  test('every non-exposed state is neutral, never danger', () => {
    const nonDanger: FeeRiskState[] = [
      'not_duplicate',
      'cleared_in_window',
      'insufficient_data',
    ];
    for (const state of nonDanger) {
      expect(riskTone(state)).toBe('neutral');
    }
  });

  test('null / undefined state is neutral', () => {
    expect(riskTone(null)).toBe('neutral');
    expect(riskTone(undefined)).toBe('neutral');
  });

  test('the full FeeRiskState domain only ever produces danger for exposed', () => {
    const all: FeeRiskState[] = [
      'not_duplicate',
      'cleared_in_window',
      'pending_in_window',
      'at_risk',
      'exposed',
      'insufficient_data',
    ];
    const dangerStates = all.filter((state) => riskTone(state) === 'danger');
    expect(dangerStates).toEqual(['exposed']);
  });

  test('riskLabel maps known states and degrades unknown to a non-sentinel string', () => {
    expect(riskLabel('exposed')).toBe('Exposed');
    expect(riskLabel('at_risk')).toBe('At risk');
    expect(riskLabel(null)).toBe('Unknown risk');
  });
});

// ---------------------------------------------------------------------------
// ActionTimeCell — approximate marker + formatting
// ---------------------------------------------------------------------------

describe('actionTimeDecision — marks approximate', () => {
  test('approximate quality with a finite value sets the approximate marker', () => {
    const decision = actionTimeDecision({ hours: 12, quality: 'approximate' });
    expect(decision.approximate).toBe(true);
    expect(decision.empty).toBe(false);
    expect(decision.text).toBe('12h');
  });

  test('exact quality is not marked approximate', () => {
    const decision = actionTimeDecision({ hours: 12, quality: 'exact' });
    expect(decision.approximate).toBe(false);
  });

  test('a null/non-finite value is empty and never marked approximate', () => {
    for (const hours of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = actionTimeDecision({
        hours: hours as number | null | undefined,
        quality: 'approximate',
      });
      expect(decision.empty).toBe(true);
      expect(decision.approximate).toBe(false);
      expect(decision.text).toBe('—');
    }
  });

  test('formatActionHours: hours under a day, days above', () => {
    expect(formatActionHours(0)).toBe('0h');
    expect(formatActionHours(23.4)).toBe('23h');
    expect(formatActionHours(24)).toBe('1d');
    expect(formatActionHours(36)).toBe('1.5d');
    expect(formatActionHours(null)).toBe('—');
  });
});
