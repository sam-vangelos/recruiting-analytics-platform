// Display-side resolution helpers for the OPERATIONAL plane (live trackers) and the notification
// path. The resolution itself happens upstream (the sweeps run the W1 resolvers and persist the
// status); this module only maps a (name, status) pair to what an operator sees. The single rule:
// a name is shown ONLY when the resolution is 'resolved'; every other status yields null and the
// surface renders a defect — never a sentinel string (resolution-types.ts:8-11).
//
// resolvedOrNull is lifted from the (correct) referral gate at notification-delivery.ts:586-589 so
// the loader, the live clients, and the notification path share ONE mapping — and so the agency
// notification gate's fallthrough bug (:653-656, which showed the raw name when NOT resolved) can
// adopt the same gate instead of re-deriving it wrongly.

import type {
  AgencyResolutionStatus,
  ResolutionStatus,
} from "./resolution-types"

/** The single resolved-vs-defect gate. Returns the trimmed name iff status === 'resolved', else
 *  null. The status param is widened to `string` because it is purely a literal check against
 *  'resolved' — it accepts both resolution-union domains (ResolutionStatus / AgencyResolutionStatus)
 *  and the loosely-typed `string` status columns the notification Row types carry. */
export function resolvedOrNull(
  name: string | null | undefined,
  status: ResolutionStatus | AgencyResolutionStatus | string | null | undefined
): string | null {
  if (status !== "resolved") return null
  return name?.trim() || null
}

/** Operator-facing defect copy for an unresolved OWNERSHIP (recruiter) resolution — "we couldn't
 *  pin the owner", never "Unknown". Mirrors the YTD ActorCell vocabulary
 *  (app/_components/channel/cells.tsx ACTOR_DEFECT_LABELS) so the two planes read consistently. */
export function ownershipDefectLabel(
  status: ResolutionStatus | null | undefined
): string {
  switch (status) {
    case "ambiguous":
      return "Ambiguous — verifying"
    case "permission_blocked":
      return "Access blocked"
    default:
      return "Owner unresolved"
  }
}

/** Defect copy for an unresolved agency SOURCE (the narrower agency domain has no
 *  permission_blocked rung — resolution-types.ts:50-59). */
export function agencySourceDefectLabel(
  status: AgencyResolutionStatus | null | undefined
): string {
  return status === "ambiguous" ? "Ambiguous source" : "Unresolved source"
}
