import { allowedPublicPhrases, operationalWords } from "./dimensions/operational-vocabulary"

export interface PublicSafetyViolation {
  path: string
  reason: string
}

export interface PublicSafetyResult {
  ok: boolean
  violations: readonly PublicSafetyViolation[]
}

export interface PublicSafetyOptions {
  /**
   * Local artifact rows can be internal-review outputs with person identifiers.
   * Public summaries/catalog/ledger surfaces should use the default strict mode.
   */
  allowPersonIdentifyingFields?: boolean
}

const unsafeKeyPatterns = [
  { pattern: /e-?mail|mail_address/i, reason: "direct contact field" },
  { pattern: /phone|mobile/i, reason: "direct contact field" },
  { pattern: /token|api[_-]?key|secret|credential/i, reason: "secret-bearing field" },
  { pattern: /candidate(Row|Rows|Payload|Payloads)/, reason: "broad candidate payload field" },
  {
    pattern:
      /^(owner|actor|recruiter|sourcer|interviewer|hiringManager|hiring_manager|manager|hod|lead|user|person|candidate|assignee|reviewer|employee|contact)(Name|Label|_name|_label)$/i,
    reason: "person-identifying field",
  },
  {
    pattern: /^(displayName|fullName|firstName|lastName|name|assigneeName|reviewerName|employeeName|contactName)$/i,
    reason: "person-identifying field",
  },
]

const personIdentifyingBareKeys = /^(owner|actor|recruiter)$/i

const unsafeStringPatterns = [
  { pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, reason: "direct contact value" },
  { pattern: /(\+\d[\d\s().-]{8,}\d|\b\d{3}[-\s().]\d{3}[-\s().]\d{4}\b)/, reason: "direct contact value" },
  { pattern: /(token|api[_-]?key|secret)\s*[:=]/i, reason: "secret-bearing value" },
]
const labeledPersonNamePattern =
  /\b(owner|recruiter|actor|candidate|manager|reviewer|assignee|employee|contact|submitter|interviewer)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g

// Value-driven person-name detection (P1): capitalized token runs, Unicode-aware so
// accented ("García"), apostrophe ("O'Brien"), initialed ("J. Smith"), particled
// ("Lucas van der Berg"), and hyphenated ("Smith-Jones") names cannot evade the grammar.
// Operational language survives via the vocabulary allowlist (dimensions/operational-vocabulary).
const NAME_PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "di", "da", "la", "le", "bin", "al"])
const personNameRunPattern =
  /\p{Lu}[\p{L}'’-]*\.?(?: +(?:(?:van|von|der|den|de|del|della|di|da|la|le|bin|al) +)*\p{Lu}[\p{L}'’-]*\.?)*/gu
const contractionSuffixPattern = /['’](s|t|re|ll|ve|d|m)$/i
const hyphenatedCapitalizedPairPattern = /^\p{Lu}[\p{L}'’]*-\p{Lu}[\p{L}'’]*$/u

function isPersonNameRun(rawTokens: readonly string[], run: string): boolean {
  if (allowedPublicPhrases.has(run)) return false
  const coreTokens = rawTokens
    .map((token) => token.replace(/\.+$/, ""))
    .filter((token) => token.length > 0 && !NAME_PARTICLES.has(token.toLowerCase()))
  if (coreTokens.length === 0) return false
  if (coreTokens.length === 1) {
    const token = coreTokens[0]
    if (/['’]/.test(token) && !contractionSuffixPattern.test(token)) return true
    if (hyphenatedCapitalizedPairPattern.test(token)) {
      return token.split("-").some((half) => half.length > 0 && !operationalWords.has(half.toLowerCase()))
    }
    return false
  }
  return coreTokens.some((token) => {
    if (token.length === 1) return true // bare initial — never an operational word
    const parts = token.split("-").filter((part) => part.length > 0)
    return parts.some((part) => !operationalWords.has(part.toLowerCase()))
  })
}

function findPersonNameRuns(text: string): string[] {
  if (allowedPublicPhrases.has(text.trim())) return []
  const flagged: string[] = []
  for (const match of text.matchAll(personNameRunPattern)) {
    const run = match[0]
    if (isPersonNameRun(run.split(/ +/), run)) flagged.push(run)
  }
  return flagged
}

function redactPersonNameRuns(text: string): string {
  if (allowedPublicPhrases.has(text.trim())) return text
  return text.replace(personNameRunPattern, (run) =>
    isPersonNameRun(run.split(/ +/), run) ? "[REDACTED]" : run
  )
}

export function inspectPublicValue(
  value: unknown,
  path = "value",
  options: PublicSafetyOptions = {}
): PublicSafetyResult {
  const violations: PublicSafetyViolation[] = []
  visitPublicValue(value, path, violations, options)
  return { ok: violations.length === 0, violations }
}

export function assertPublicSafe(
  value: unknown,
  label = "public value",
  options: PublicSafetyOptions = {}
): void {
  const result = inspectPublicValue(value, label, options)
  if (!result.ok) {
    const details = result.violations.map((violation) => `${violation.path}: ${violation.reason}`).join("; ")
    throw new Error(`${label} is not public-safe: ${details}`)
  }
}

export function redactForPublicValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "string") {
    return unsafeStringPatterns.some(({ pattern }) => pattern.test(value)) ? "[REDACTED]" : redactPublicText(value)
  }
  if (typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => redactForPublicValue(item))

  const record = value as Record<string, unknown>
  let redactedFieldIndex = 0
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      if (isUnsafePersonKeyValue(key, item) || unsafeKeyPatterns.some(({ pattern }) => pattern.test(key))) {
        redactedFieldIndex += 1
        return [`redacted_field_${redactedFieldIndex}`, "[REDACTED]"]
      }
      return [key, redactForPublicValue(item)]
    })
  )
}

export function redactPublicText(value: string): string {
  // Operational labels ("Application Review", registry titles) survive via the
  // vocabulary/phrase allowlist; person-name-shaped runs are redacted wherever they appear.
  const withoutContactsAndLabeledNames = unsafeStringPatterns
    .reduce((text, { pattern }) => text.replace(pattern, "[REDACTED]"), value)
    .replace(labeledPersonNamePattern, "$1 [REDACTED]")
  return redactPersonNameRuns(withoutContactsAndLabeledNames)
}

function visitPublicValue(
  value: unknown,
  path: string,
  violations: PublicSafetyViolation[],
  options: PublicSafetyOptions
): void {
  if (value === null || value === undefined) return

  if (typeof value === "string") {
    for (const { pattern, reason } of unsafeStringPatterns) {
      if (pattern.test(value)) violations.push({ path, reason })
    }
    labeledPersonNamePattern.lastIndex = 0
    if (labeledPersonNamePattern.test(value)) {
      violations.push({ path, reason: "person-identifying value" })
      labeledPersonNamePattern.lastIndex = 0
    } else if (!options.allowPersonIdentifyingFields && findPersonNameRuns(value).length > 0) {
      violations.push({ path, reason: "person-identifying value" })
    }
    return
  }

  if (typeof value !== "object") return

  if (Array.isArray(value)) {
    value.forEach((item, index) => visitPublicValue(item, `${path}[${index}]`, violations, options))
    return
  }

  const record = value as Record<string, unknown>
  for (const [key, item] of Object.entries(record)) {
    if (!options.allowPersonIdentifyingFields && isUnsafePersonKeyValue(key, item)) {
      violations.push({ path: `${path}.${key}`, reason: "person-identifying field" })
    }
    for (const { pattern, reason } of unsafeKeyPatterns) {
      if (pattern.test(key) && (!options.allowPersonIdentifyingFields || reason !== "person-identifying field")) {
        violations.push({ path: `${path}.${key}`, reason })
      }
    }
    visitPublicValue(item, `${path}.${key}`, violations, options)
  }
}

function isUnsafePersonKeyValue(key: string, value: unknown): boolean {
  if (!personIdentifyingBareKeys.test(key)) return false
  if (typeof value !== "string") return false
  return isPersonIdentifyingString(value)
}

function isPersonIdentifyingString(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (unsafeStringPatterns.some(({ pattern }) => pattern.test(trimmed))) return true
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/.test(trimmed)) return true
  return /^[A-Z][a-z]{2,}$/.test(trimmed)
}
