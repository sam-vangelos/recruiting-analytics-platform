import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const GREENHOUSE_READ_EXPORTS = [
  "greenhouseGet",
  "greenhouseGetAll",
  "greenhouseGetOne",
  "greenhouseGetWithCursor",
]

const NON_GET_METHOD_RE = /\bmethod\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/gi

function trackedSourceFiles() {
  return execFileSync("git", ["ls-files", "app", "lib", "scripts"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => /\.(?:ts|tsx|mjs|js)$/.test(file))
}

function methodWindows(source: string) {
  return [...source.matchAll(NON_GET_METHOD_RE)].map((match) => {
    const index = match.index ?? 0
    return {
      method: match[1].toUpperCase(),
      context: source.slice(Math.max(0, index - 450), index + 450),
    }
  })
}

describe("Greenhouse write boundary", () => {
  test("Greenhouse client exposes read helpers only", () => {
    const source = readFileSync("lib/greenhouse-client.ts", "utf8")
    const exported = [...source.matchAll(/export\s+async\s+function\s+(greenhouse[A-Za-z0-9_]*)/g)]
      .map((match) => match[1])
      .sort()

    expect(exported).toEqual([...GREENHOUSE_READ_EXPORTS].sort())
  })

  test("tracked analytics source does not send direct non-GET Harvest requests", () => {
    const offenders: string[] = []

    for (const file of trackedSourceFiles()) {
      const source = readFileSync(file, "utf8")
      for (const { method, context } of methodWindows(source)) {
        if (file === "lib/greenhouse-client.ts" && /fetch\(\s*TOKEN_URL/.test(context)) {
          continue
        }
        if (file === "lib/greenhouse-client.ts" || /greenhouse|harvest\.greenhouse\.io/i.test(context)) {
          offenders.push(`${file}: ${method}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  // The third test here covered the retired modernization scaffold's write-shell files
  // (deleted with the scaffold); tests 1-2 lock the real invariant — the Greenhouse
  // client is read-only and nothing sends non-GET Harvest requests.
})
