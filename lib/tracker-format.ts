import type { UrgencyTier } from "./sweep-types";

export function referralTierLabel(tier: UrgencyTier): string {
  switch (tier) {
    case "breach":
      return "SLA BREACH";
    case "sla_risk":
      return "SLA RISK";
    case "alerted":
      return "ALERTED";
    case "new":
      return "NEW";
    case "actioned":
      return "ACTIONED";
  }
}
