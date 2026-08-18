// Anti-regression for the agency-sweep advisory-lock soft-fail (lib/sweep-agency.ts
// isMissingFunctionError / tryAcquireSweepLock).
//
// The agency sweep takes a session-scoped advisory lock (try_advisory_lock RPC) BEFORE any work,
// every 4h on the cron (vercel.json). That RPC is defined by migration 007. Pre-007 the function
// does not exist, so the rpc errors — and a blanket throw would silently kill the agency sweep on
// every tick while referral/YTD keep running (cross-plane skew). The fix soft-fails ONLY the
// "function does not exist" case (Postgres SQLSTATE 42883 / PostgREST PGRST202 / matching message
// text): the caller returns false and exits cleanly as skipped, staying dormant pre-007. Every
// OTHER error still throws. This pins the predicate that decides which errors are soft.

import { describe, expect, test } from "vitest"
import { isMissingFunctionError } from "../lib/sweep-agency"

describe("agency-sweep advisory lock — isMissingFunctionError", () => {
  test("true for Postgres SQLSTATE 42883 (undefined_function)", () => {
    expect(
      isMissingFunctionError({
        code: "42883",
        message: "function try_advisory_lock(integer, integer) does not exist",
        details: "",
        hint: "",
      })
    ).toBe(true)
  })

  test("true for PostgREST PGRST202 (missing RPC in schema cache)", () => {
    expect(
      isMissingFunctionError({
        code: "PGRST202",
        message:
          "Could not find the function public.try_advisory_lock in the schema cache",
      })
    ).toBe(true)
  })

  test("true on message text alone when the code is absent (function + does not exist)", () => {
    expect(
      isMissingFunctionError({
        message: "ERROR: function advisory_unlock does not exist",
      })
    ).toBe(true)
  })

  test("true on 'Could not find the function' message text alone", () => {
    expect(
      isMissingFunctionError({
        message: "Could not find the function try_advisory_lock",
      })
    ).toBe(true)
  })

  test("matches the message text case-insensitively", () => {
    expect(
      isMissingFunctionError({
        message: "FUNCTION try_advisory_lock DOES NOT EXIST",
      })
    ).toBe(true)
  })

  test("false for a generic DB error (permission denied, 42501)", () => {
    expect(
      isMissingFunctionError({
        code: "42501",
        message: "permission denied for function try_advisory_lock",
      })
    ).toBe(false)
  })

  test("false for a deadlock / other transient error", () => {
    expect(
      isMissingFunctionError({
        code: "40P01",
        message: "deadlock detected",
      })
    ).toBe(false)
  })

  test("false when 'does not exist' refers to something other than a function (e.g. relation)", () => {
    expect(
      isMissingFunctionError({
        code: "42P01",
        message: 'relation "agency_submissions" does not exist',
      })
    ).toBe(false)
  })

  test("false for null / undefined / non-object inputs", () => {
    expect(isMissingFunctionError(null)).toBe(false)
    expect(isMissingFunctionError(undefined)).toBe(false)
    expect(isMissingFunctionError("function does not exist")).toBe(false)
  })

  test("false for an error object with a non-string message and no matching code", () => {
    expect(isMissingFunctionError({ message: 42 })).toBe(false)
    expect(isMissingFunctionError({})).toBe(false)
  })
})
