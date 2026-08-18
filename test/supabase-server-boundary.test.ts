import { execFileSync } from "node:child_process"
import { dirname, extname, join, normalize } from "node:path"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"]
const SERVICE_ROLE_ENV_RE = /\bSUPABASE_SERVICE_ROLE_KEY\b/
const USE_CLIENT_RE = /^\s*["']use client["'];?/m
const IMPORT_RE =
  /import\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["'];?/g

function trackedSourceFiles() {
  return execFileSync("git", ["ls-files", "app", "lib"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => SOURCE_EXTENSIONS.includes(extname(file)))
}

const trackedSources = new Map(
  trackedSourceFiles().map((file) => [file, readFileSync(file, "utf8")])
)

function runtimeImportSpecifiers(source: string) {
  return [...source.matchAll(IMPORT_RE)]
    .filter((match) => match[1]?.trim() !== "type")
    .map((match) => match[2])
}

function resolveLocalImport(fromFile: string, specifier: string) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null

  const withoutAlias = specifier.startsWith("@/")
    ? specifier.slice(2)
    : normalize(join(dirname(fromFile), specifier))
  const base = withoutAlias.replace(/\\/g, "/")
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ]

  return candidates.find((candidate) => trackedSources.has(candidate)) ?? null
}

function reachableRuntimeFiles(entry: string) {
  const seen = new Set<string>()
  const stack = [entry]

  while (stack.length > 0) {
    const file = stack.pop()
    if (!file || seen.has(file)) continue
    seen.add(file)

    const source = trackedSources.get(file)
    if (!source) continue

    for (const specifier of runtimeImportSpecifiers(source)) {
      const resolved = resolveLocalImport(file, specifier)
      if (resolved && !seen.has(resolved)) stack.push(resolved)
    }
  }

  return seen
}

describe("Supabase service-role server boundary", () => {
  test("service-role client uses server-only environment names", () => {
    const source = trackedSources.get("lib/supabase.ts") ?? ""

    expect(source).toContain("SUPABASE_SERVICE_ROLE_KEY")
    expect(source).toContain("SUPABASE_URL")
    expect(source).not.toContain("NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY")
  })

  test("tracked client component runtime graphs cannot reach the service-role client", () => {
    const clientEntries = [...trackedSources.entries()]
      .filter(([, source]) => USE_CLIENT_RE.test(source))
      .map(([file]) => file)
    const offenders: string[] = []

    for (const entry of clientEntries) {
      for (const file of reachableRuntimeFiles(entry)) {
        const source = trackedSources.get(file) ?? ""
        if (file === "lib/supabase.ts" || SERVICE_ROLE_ENV_RE.test(source)) {
          offenders.push(`${entry} -> ${file}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
