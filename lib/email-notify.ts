import { readEnv } from "./env"

// P5 email transport — the escalation send path. Resend via its REST API (fetch, no SDK dep —
// consistent with how this repo calls Slack). Mirrors the sibling ats-ops-control-plane's Resend
// integration (RESEND_API_KEY, an @example.com verified sender), reduced to the one call the drain
// needs. Activation env (set in Vercel when ready; the Resend ACCOUNT + domain already exist):
//   NOTIFY_EMAIL_SEND=true        (the gate — default off, like the Slack channel gates)
//   RESEND_API_KEY=...            (account-level; the same key the sibling project uses)
//   NOTIFY_EMAIL_FROM=...         (a verified sender, e.g. "TA Ops Alerts <ta-ops@example.com>")
//   RECOPS_ESCALATION_EMAIL=...   (the rec-ops destination — read at drain time, drainOne)

const RESEND_API = "https://api.resend.com/emails"
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024

function classifyHttpFailure(status: number): EmailTransportFailureKind {
  return status >= 500 || status === 408 || status === 409
    ? "ambiguous"
    : "provider_rejected"
}

export interface EmailAttachment {
  filename: string
  content: string | Uint8Array
  contentType?: string
}

export interface SendEmailOptions {
  attachment?: EmailAttachment
  idempotencyKey?: string
  timeoutMs?: number
}

export type EmailTransportFailureKind =
  | "configuration"
  | "provider_rejected"
  | "ambiguous"

/** Safe transport error: it never contains a provider response body, address, or email content. */
export class EmailTransportError extends Error {
  readonly code: string
  readonly kind: EmailTransportFailureKind
  readonly status: number | null

  constructor(input: {
    code: string
    kind: EmailTransportFailureKind
    message: string
    status?: number | null
  }) {
    super(input.message)
    this.name = "EmailTransportError"
    this.code = input.code
    this.kind = input.kind
    this.status = input.status ?? null
  }

  get dispatchMayHaveOccurred(): boolean {
    return this.kind === "ambiguous"
  }
}

export class EmailStatusLookupError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "EmailStatusLookupError"
    this.code = code
  }
}

/** True only when NOTIFY_EMAIL_SEND is explicitly "true" (default off). Same conservative gate
 *  contract as isChannelSendEnabled — unset/blank/anything-else suppresses. */
export function isEmailSendEnabled(): boolean {
  return readEnv("NOTIFY_EMAIL_SEND")?.toLowerCase() === "true"
}

/** Send one email via Resend. Returns the provider message id. THROWS on any failure (mirrors
 *  postSlackDm) so drainOne's try/catch records a 'failed' attempt and retries — Resend can fail
 *  on an unverified domain / suspended account / rate limit, and a swallowed failure would stamp
 *  an escalation 'sent' that never actually left. The caller gates on isEmailSendEnabled() first;
 *  this function performs the send unconditionally when called. */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  options: SendEmailOptions = {}
): Promise<string> {
  const apiKey = readEnv("RESEND_API_KEY")
  const from = readEnv("NOTIFY_EMAIL_FROM")
  if (!apiKey) {
    throw new EmailTransportError({
      code: "resend_api_key_missing",
      kind: "configuration",
      message: "RESEND_API_KEY must be set",
    })
  }
  if (!from) {
    throw new EmailTransportError({
      code: "notify_email_from_missing",
      kind: "configuration",
      message: "NOTIFY_EMAIL_FROM must be set",
    })
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new EmailTransportError({
      code: "invalid_timeout",
      kind: "configuration",
      message: "Email timeout must be an integer between 1 and 60000 milliseconds",
    })
  }
  if (
    options.idempotencyKey !== undefined &&
    (!options.idempotencyKey.trim() || options.idempotencyKey.length > 256)
  ) {
    throw new EmailTransportError({
      code: "invalid_idempotency_key",
      kind: "configuration",
      message: "Email idempotency key must be between 1 and 256 characters",
    })
  }
  if (options.attachment && !isSafeAttachmentFilename(options.attachment.filename)) {
    throw new EmailTransportError({
      code: "invalid_attachment_filename",
      kind: "configuration",
      message: "Email attachment filename is invalid",
    })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let res: Response
    try {
      res = await fetch(RESEND_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from,
          to,
          subject,
          html,
          ...(options.attachment
            ? {
                attachments: [
                  {
                    filename: options.attachment.filename,
                    content: Buffer.from(options.attachment.content).toString("base64"),
                    ...(options.attachment.contentType
                      ? { content_type: options.attachment.contentType }
                      : {}),
                  },
                ],
              }
            : {}),
        }),
        signal: controller.signal,
      })
    } catch {
      throw new EmailTransportError({
        code: controller.signal.aborted ? "resend_timeout" : "resend_network_failure",
        kind: "ambiguous",
        message: controller.signal.aborted
          ? "Resend request timed out; dispatch status is ambiguous"
          : "Resend request failed; dispatch status is ambiguous",
      })
    }

    const contentLength = Number(res.headers.get("content-length") ?? "0")
    if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new EmailTransportError({
        code: "resend_response_too_large",
        kind: res.ok ? "ambiguous" : classifyHttpFailure(res.status),
        message: `Resend response exceeded the safe size limit (status ${res.status})`,
        status: res.status,
      })
    }
    let responseText: string
    try {
      responseText = await readBoundedResponseText(res)
    } catch {
      throw new EmailTransportError({
        code: controller.signal.aborted ? "resend_timeout" : "resend_response_too_large",
        kind: controller.signal.aborted
          ? "ambiguous"
          : res.ok
            ? "ambiguous"
            : classifyHttpFailure(res.status),
        message: controller.signal.aborted
          ? "Resend request timed out; dispatch status is ambiguous"
          : `Resend response could not be read safely (status ${res.status})`,
        status: res.status,
      })
    }
    if (!res.ok) {
      throw new EmailTransportError({
        code: `resend_http_${res.status}`,
        kind: classifyHttpFailure(res.status),
        message:
          classifyHttpFailure(res.status) === "ambiguous"
            ? `Resend returned HTTP ${res.status}; dispatch status is ambiguous`
            : `Resend rejected the request with HTTP ${res.status}`,
        status: res.status,
      })
    }
    let data: { id?: unknown }
    try {
      data = JSON.parse(responseText) as { id?: unknown }
    } catch {
      throw new EmailTransportError({
        code: "resend_success_body_malformed",
        kind: "ambiguous",
        message: "Resend returned a malformed success response; dispatch status is ambiguous",
        status: res.status,
      })
    }
    if (typeof data.id !== "string" || !data.id.trim()) {
      throw new EmailTransportError({
        code: "resend_provider_id_missing",
        kind: "ambiguous",
        message: "Resend returned success without a provider message ID; dispatch status is ambiguous",
        status: res.status,
      })
    }
    return data.id
  } finally {
    clearTimeout(timeout)
  }
}

function isSafeAttachmentFilename(filename: string): boolean {
  return (
    filename.length >= 1 &&
    filename.length <= 180 &&
    !/[\r\n\/\\]/.test(filename) &&
    filename !== "." &&
    filename !== ".."
  )
}

/** Retrieve only Resend's technical event marker; addresses and content are discarded in-memory. */
export async function retrieveEmailStatus(
  providerMessageId: string,
  options: { timeoutMs?: number } = {}
): Promise<string> {
  const apiKey = readEnv("RESEND_API_KEY")
  if (!apiKey) throw new EmailStatusLookupError("resend_api_key_missing", "RESEND_API_KEY must be set")
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(providerMessageId)) {
    throw new EmailStatusLookupError("invalid_provider_message_id", "Provider message ID is invalid")
  }
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new EmailStatusLookupError("invalid_timeout", "Status timeout is invalid")
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: Response
    try {
      response = await fetch(`${RESEND_API}/${encodeURIComponent(providerMessageId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: controller.signal,
      })
    } catch {
      throw new EmailStatusLookupError(
        controller.signal.aborted ? "resend_status_timeout" : "resend_status_network_failure",
        "Resend status lookup failed"
      )
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0")
    if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new EmailStatusLookupError(
        "resend_status_response_too_large",
        "Resend status response is too large"
      )
    }
    let text: string
    try {
      text = await readBoundedResponseText(response)
    } catch {
      throw new EmailStatusLookupError(
        controller.signal.aborted
          ? "resend_status_timeout"
          : "resend_status_response_too_large",
        "Resend status response could not be read safely"
      )
    }
    if (!response.ok) {
      throw new EmailStatusLookupError(
        `resend_status_http_${response.status}`,
        `Resend status lookup returned HTTP ${response.status}`
      )
    }
    let parsed: { last_event?: unknown }
    try {
      parsed = JSON.parse(text) as { last_event?: unknown }
    } catch {
      throw new EmailStatusLookupError("resend_status_body_malformed", "Resend status response is malformed")
    }
    if (typeof parsed.last_event !== "string" || !/^[a-z_]{1,64}$/.test(parsed.last_event)) {
      throw new EmailStatusLookupError("resend_status_event_invalid", "Resend status event is invalid")
    }
    return parsed.last_event
  } finally {
    clearTimeout(timeout)
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error("provider_response_limit_exceeded")
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    reader.releaseLock()
  }
}
