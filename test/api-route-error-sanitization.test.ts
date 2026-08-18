import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { describe, expect, test } from "vitest"

const RAW_ERROR_PATTERNS = [
  /err instanceof Error \? err\.message : String\(err\)/,
  /\{\s*error:\s*[a-zA-Z0-9_]+\.error\.message\s*\}/,
  /\{\s*error:\s*[a-zA-Z0-9_]+\.message\s*\}/,
  /error:\s*`[^`]*\$\{[a-zA-Z0-9_]+\.message\}[^`]*`/,
]

function trackedApiRouteFiles() {
  return execFileSync("git", ["ls-files", "app/api/**/route.ts"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
}

describe("API route error sanitization", () => {
  test("tracked API route handlers do not echo raw exception messages", () => {
    const offenders = []

    for (const file of trackedApiRouteFiles()) {
      const source = readFileSync(file, "utf8")
      for (const pattern of RAW_ERROR_PATTERNS) {
        if (pattern.test(source)) offenders.push(`${file}: ${pattern}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
