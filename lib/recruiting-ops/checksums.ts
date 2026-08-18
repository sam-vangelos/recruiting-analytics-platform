import { createHash, createHmac } from "node:crypto"

type Jsonish =
  | null
  | boolean
  | number
  | string
  | readonly Jsonish[]
  | { readonly [key: string]: Jsonish | undefined }

export function stableSerialize(value: unknown): string {
  return JSON.stringify(normalizeForHash(value))
}

export function createStableChecksum(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex")
}

export function createPayloadFingerprint(value: unknown): string {
  return `sha256:${createStableChecksum(value)}`
}

export interface PseudonymousFingerprintOptions {
  /**
   * Required for PII-derived fingerprints. The local helper below is fixture/test-only;
   * real PII integrations must inject an approved secret through a later boundary.
   */
  key: string
  context: string
}

export const LOCAL_ONLY_PII_FINGERPRINT_KEY = "recops-local-pre-integration-fixture-key"

export const PII_FINGERPRINT_SALT_ENV = "RECOPS_PII_FINGERPRINT_SALT"

export type PiiFingerprintProvenance = "fixture" | "live"

export interface PiiFingerprintInputOptions {
  context: string
  /**
   * "fixture" = synthetic/fixture data only; uses the committed local key, which is
   * acceptable because nothing it fingerprints is real. "live" = real person data;
   * REQUIRES the env-injected salt and fails closed without it (SAFETY-GATES-4:
   * a committed key makes pseudonyms reversible over any committed roster).
   */
  dataProvenance: PiiFingerprintProvenance
}

export function createPseudonymousFingerprint(
  value: unknown,
  options: PseudonymousFingerprintOptions
): string {
  if (!options.key.trim()) throw new Error("PII fingerprint key is required")
  if (!options.context.trim()) throw new Error("PII fingerprint context is required")
  const payload = stableSerialize({ context: options.context, value })
  return `hmac-sha256:${createHmac("sha256", options.key).update(payload).digest("hex")}`
}

export function createPiiFingerprint(value: unknown, options: PiiFingerprintInputOptions): string {
  if (options.dataProvenance === "live") {
    const salt = process.env[PII_FINGERPRINT_SALT_ENV]?.trim()
    if (!salt) {
      throw new Error(
        `Live PII fingerprints require the ${PII_FINGERPRINT_SALT_ENV} environment secret; ` +
          "refusing to fall back to the committed fixture key"
      )
    }
    return createPseudonymousFingerprint(value, { key: salt, context: options.context })
  }
  return createPseudonymousFingerprint(value, {
    key: LOCAL_ONLY_PII_FINGERPRINT_KEY,
    context: options.context,
  })
}

export function createLocalPiiFingerprint(value: unknown, context: string): string {
  return createPiiFingerprint(value, { context, dataProvenance: "fixture" })
}

export function isSupportedFingerprint(value: string): boolean {
  return value.startsWith("sha256:") || value.startsWith("hmac-sha256:")
}

function normalizeForHash(value: unknown): Jsonish {
  if (value === null) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => normalizeForHash(item))

  const valueType = typeof value
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return value as string | number | boolean
  }
  if (valueType === "undefined") return null

  if (valueType === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeForHash(record[key])])
    )
  }

  return String(value)
}
