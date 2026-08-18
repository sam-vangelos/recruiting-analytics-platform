import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import {
  EmailStatusLookupError,
  EmailTransportError,
  retrieveEmailStatus,
  sendEmail,
} from "../lib/email-notify"

describe("email transport", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "test-key")
    vi.stubEnv("NOTIFY_EMAIL_FROM", "TA Ops <ta-ops@example.com>")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  test("preserves the existing call shape and requires a provider message ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "email_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(sendEmail("recipient@example.com", "Subject", "<p>Body</p>")).resolves.toBe(
      "email_123"
    )
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toEqual({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    })
    expect(JSON.parse(String(init.body))).toEqual({
      from: "TA Ops <ta-ops@example.com>",
      to: "recipient@example.com",
      subject: "Subject",
      html: "<p>Body</p>",
    })
  })

  test("adds one CSV attachment and a stable provider idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "email_456" }), { status: 200 })
    )
    vi.stubGlobal("fetch", fetchMock)
    await sendEmail("recipient@example.com", "Subject", "<p>Body</p>", {
      idempotencyKey: "employee-referral:period:1:ta_lead",
      attachment: {
        filename: "employee-referrals.csv",
        content: "a,b\r\n1,2\r\n",
        contentType: "text/csv; charset=utf-8",
      },
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({
      "Idempotency-Key": "employee-referral:period:1:ta_lead",
    })
    expect(JSON.parse(String(init.body)).attachments).toEqual([
      {
        filename: "employee-referrals.csv",
        content: Buffer.from("a,b\r\n1,2\r\n").toString("base64"),
        content_type: "text/csv; charset=utf-8",
      },
    ])
  })

  test("turns provider rejection into a typed safe error without leaking its body", async () => {
    const canary = "recipient@example.com SECRET_REPORT_BODY"
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ name: "bad", message: canary }), { status: 422 })
      )
    )
    const error = await sendEmail("recipient@example.com", "Subject", "<p>Body</p>").catch(
      (caught) => caught
    )
    expect(error).toBeInstanceOf(EmailTransportError)
    expect(error).toMatchObject({
      code: "resend_http_422",
      kind: "provider_rejected",
      status: 422,
      dispatchMayHaveOccurred: false,
    })
    expect(String(error)).not.toContain(canary)
    expect(JSON.stringify(error)).not.toContain(canary)
  })

  test.each([408, 409, 500, 503])(
    "treats HTTP %s as ambiguous because dispatch may have occurred",
    async (status) => {
      const canary = "recipient@example.com SECRET_REPORT_BODY"
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(canary, { status }))
      )

      const error = await sendEmail(
        "recipient@example.com",
        "Subject",
        "<p>Body</p>"
      ).catch((caught) => caught)

      expect(error).toMatchObject({
        code: `resend_http_${status}`,
        kind: "ambiguous",
        status,
        dispatchMayHaveOccurred: true,
      })
      expect(String(error)).not.toContain(canary)
      expect(JSON.stringify(error)).not.toContain(canary)
    }
  )

  test("classifies network loss and a 2xx response without an ID as ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("recipient@example.com CANARY")))
    const network = await sendEmail("recipient@example.com", "Subject", "body").catch(
      (caught) => caught
    )
    expect(network).toMatchObject({
      code: "resend_network_failure",
      kind: "ambiguous",
      dispatchMayHaveOccurred: true,
    })
    expect(String(network)).not.toContain("CANARY")

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    )
    const noId = await sendEmail("recipient@example.com", "Subject", "body").catch(
      (caught) => caught
    )
    expect(noId).toMatchObject({
      code: "resend_provider_id_missing",
      kind: "ambiguous",
      dispatchMayHaveOccurred: true,
    })
  })

  test("keeps the send deadline active while reading a stalled provider body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal
        const body = new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(new Error("aborted")), {
              once: true,
            })
          },
        })
        return Promise.resolve(new Response(body, { status: 200 }))
      })
    )

    await expect(
      sendEmail("recipient@example.com", "Subject", "body", { timeoutMs: 10 })
    ).rejects.toMatchObject({
      code: "resend_timeout",
      kind: "ambiguous",
      dispatchMayHaveOccurred: true,
    })
  })

  test("rejects unsafe configuration before dispatch", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    vi.stubEnv("RESEND_API_KEY", "")
    await expect(sendEmail("recipient@example.com", "Subject", "body")).rejects.toMatchObject({
      code: "resend_api_key_missing",
      kind: "configuration",
    })
    vi.stubEnv("RESEND_API_KEY", "test-key")
    await expect(
      sendEmail("recipient@example.com", "Subject", "body", {
        attachment: { filename: "../report.csv", content: "x" },
      })
    ).rejects.toMatchObject({ code: "invalid_attachment_filename" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("retrieves only the bounded provider event and discards content fields", async () => {
    const canary = "recipient@example.com SECRET_REPORT_BODY"
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "email_123",
          to: ["recipient@example.com"],
          html: canary,
          last_event: "delivered",
        }),
        { status: 200 }
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    await expect(retrieveEmailStatus("email_123")).resolves.toBe("delivered")
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails/email_123",
      expect.objectContaining({ method: "GET" })
    )

    fetchMock.mockResolvedValueOnce(new Response(canary, { status: 500 }))
    const error = await retrieveEmailStatus("email_123").catch((caught) => caught)
    expect(error).toBeInstanceOf(EmailStatusLookupError)
    expect(String(error)).not.toContain(canary)
    expect(JSON.stringify(error)).not.toContain(canary)
  })

  test("keeps the status deadline active while reading a stalled provider body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal
        const body = new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(new Error("aborted")), {
              once: true,
            })
          },
        })
        return Promise.resolve(new Response(body, { status: 200 }))
      })
    )

    await expect(retrieveEmailStatus("email_123", { timeoutMs: 10 })).rejects.toMatchObject({
      code: "resend_status_timeout",
    })
  })
})
