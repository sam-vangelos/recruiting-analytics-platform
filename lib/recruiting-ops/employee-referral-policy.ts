import { createStableChecksum } from "./checksums"
import { SWEEP_CONFIG } from "../sweep-config"

export type ReferralPolicyFunctionBand = "delivery_r_and_d" | "other"

export type ReferralPolicyCountry =
  | "United States"
  | "United Kingdom"
  | "India"
  | "Brazil"
  | "Columbia"
  | "Other"

export interface ReferralPolicyRate {
  amount: number
  currency: "USD" | "GBP" | "INR" | "BRL"
}

export interface ReferralPolicyResolution {
  functionBand: ReferralPolicyFunctionBand | null
  functionBandLabel: string | null
  country: ReferralPolicyCountry | null
  amount: number | null
  currency: ReferralPolicyRate["currency"] | null
  bonusResolutionStatus:
    | "PAYROLL_CONVERSION_REQUIRED - Payroll"
    | "POLICY_MAPPING_REQUIRED - Policy DRI/People Ops"
  reviewReasons: string[]
}

/**
 * Immutable transcription of the approved Employee Referral Program.
 * The source document is never read at report runtime.
 *
 * Source text export: Google Docs text/plain, fetched 2026-07-22.
 * SHA-256 covers the exact UTF-8 export bytes, including its BOM and CRLFs.
 */
export const EMPLOYEE_REFERRAL_POLICY = {
  version: "2026-04-14",
  effectiveOn: "2026-04-14",
  sourceDocumentId: "1ExampleDriveId00000000000000000000000000012",
  sourceDocumentExportSha256:
    "0000000000000000000000000000000000000000000000000000000000000000",
  hiringLocationNameKey: "hiring_location",
  governedSourceIds: SWEEP_CONFIG.referral.sourceIds,
  governedSource: {
    id: "4000194004",
    name: "Referral",
    typeId: "4000002004",
    typeName: "Referral",
  },
  /** Manager-confirmed executive/ELT exclusions, keyed by immutable Greenhouse user ID. */
  ineligibleExecutiveOrEltReferrerUserIds: ["5000000004"],
  /** Stable offer-job department IDs. Unknown IDs deliberately remain unmapped. */
  departmentFunctionBands: {
    "4069524004": "delivery_r_and_d",
    "4118226004": "delivery_r_and_d",
    "4118227004": "delivery_r_and_d",
    "4120779004": "delivery_r_and_d",
    "4094661004": "delivery_r_and_d", // Marketplace (Fulfillment)
    "4069528004": "other", // People
    "4069529004": "other",
    "4120775004": "other",
  } satisfies Readonly<Record<string, ReferralPolicyFunctionBand>>,
  /** Exact normalized values from the structured offer field. */
  hiringLocationCountries: {
    usa: "United States",
    "united states": "United States",
    uk: "United Kingdom",
    "united kingdom": "United Kingdom",
    india: "India",
    brazil: "Brazil",
    columbia: "Columbia",
    "row/eor": "Other",
    other: "Other",
  } satisfies Readonly<Record<string, ReferralPolicyCountry>>,
  rates: {
    "United States": {
      delivery_r_and_d: { amount: 3000, currency: "USD" },
      other: { amount: 1000, currency: "USD" },
    },
    "United Kingdom": {
      delivery_r_and_d: { amount: 2250, currency: "GBP" },
      other: { amount: 750, currency: "GBP" },
    },
    India: {
      delivery_r_and_d: { amount: 70000, currency: "INR" },
      other: { amount: 25000, currency: "INR" },
    },
    Brazil: {
      delivery_r_and_d: { amount: 1200, currency: "BRL" },
      other: { amount: 400, currency: "BRL" },
    },
  } satisfies Readonly<
    Record<
      "United States" | "United Kingdom" | "India" | "Brazil",
      Readonly<Record<ReferralPolicyFunctionBand, ReferralPolicyRate>>
    >
  >,
} as const

export const EMPLOYEE_REFERRAL_POLICY_CONFIG_SHA256 = createStableChecksum(
  EMPLOYEE_REFERRAL_POLICY
)

export function resolveEmployeeReferralPolicy(input: {
  acceptedDate: string | null
  hiringLocation: string | null
  departmentId: string | null
}): ReferralPolicyResolution {
  const reviewReasons: string[] = []
  const acceptedDate = acceptedDateInLosAngeles(input.acceptedDate)
  if (!acceptedDate) {
    reviewReasons.push("POLICY_ACCEPTED_DATE_MISSING")
  } else if (acceptedDate < EMPLOYEE_REFERRAL_POLICY.effectiveOn) {
    reviewReasons.push(
      `POLICY_PREDATES_EFFECTIVE_DATE:${EMPLOYEE_REFERRAL_POLICY.effectiveOn}`
    )
  }

  const functionBand = input.departmentId
    ? EMPLOYEE_REFERRAL_POLICY.departmentFunctionBands[
        input.departmentId as keyof typeof EMPLOYEE_REFERRAL_POLICY.departmentFunctionBands
      ] ?? null
    : null
  if (!input.departmentId) {
    reviewReasons.push("OFFER_JOB_DEPARTMENT_MISSING")
  } else if (!functionBand) {
    reviewReasons.push(`POLICY_FUNCTION_UNMAPPED:${input.departmentId}`)
  }

  const normalizedLocation = input.hiringLocation?.trim().toLocaleLowerCase("en-US") ?? ""
  const country = normalizedLocation
    ? EMPLOYEE_REFERRAL_POLICY.hiringLocationCountries[
        normalizedLocation as keyof typeof EMPLOYEE_REFERRAL_POLICY.hiringLocationCountries
      ] ?? null
    : null
  if (!normalizedLocation) {
    reviewReasons.push("HIRING_LOCATION_MISSING")
  } else if (!country) {
    reviewReasons.push(`POLICY_COUNTRY_UNMAPPED:${input.hiringLocation?.trim()}`)
  } else if (country === "Columbia") {
    reviewReasons.push("POLICY_COUNTRY_COLUMBIA_REQUIRES_DRI_CONFIRMATION")
  } else if (country === "Other") {
    reviewReasons.push("POLICY_COUNTRY_OTHER_REQUIRES_LOCAL_PAY_RATIO")
  }

  const rate =
    acceptedDate &&
    functionBand &&
    country &&
    country !== "Columbia" &&
    country !== "Other"
      ? EMPLOYEE_REFERRAL_POLICY.rates[country][functionBand]
      : null

  return {
    functionBand,
    functionBandLabel:
      functionBand === "delivery_r_and_d"
        ? "Delivery and R&D"
        : functionBand === "other"
          ? "Other"
          : null,
    country,
    amount: rate?.amount ?? null,
    currency: rate?.currency ?? null,
    bonusResolutionStatus:
      rate && acceptedDate && acceptedDate >= EMPLOYEE_REFERRAL_POLICY.effectiveOn
      ? "PAYROLL_CONVERSION_REQUIRED - Payroll"
      : "POLICY_MAPPING_REQUIRED - Policy DRI/People Ops",
    reviewReasons,
  }
}

function acceptedDateInLosAngeles(value: string | null): string | null {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`)
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
      ? null
      : value
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}
