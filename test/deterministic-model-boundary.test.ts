import { execFileSync } from "node:child_process"
import { extname } from "node:path"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".json"])
const MODEL_PROVIDER_PATTERNS = [
  /\bfrom\s+["'](?:openai|@openai\/[^"']+|@anthropic-ai\/[^"']+|@google\/generative-ai|@ai-sdk\/[^"']+|ai|langchain)["']/i,
  /\bimport\s*\(\s*["'](?:openai|@openai\/[^"']+|@anthropic-ai\/[^"']+|@google\/generative-ai|@ai-sdk\/[^"']+|ai|langchain)["']\s*\)/i,
  /https:\/\/api\.openai\.com\/v1/i,
  /https:\/\/api\.anthropic\.com\/v1\/messages/i,
  /\bgenerateText\s*\(/,
  /\bstreamText\s*\(/,
  /\bchat\.completions\s*\(/,
  /\bresponses\.create\s*\(/,
]
const MODEL_PROVIDER_DEPENDENCY_RE =
  /^(openai|@openai\/.+|@anthropic-ai\/.+|@google\/generative-ai|@ai-sdk\/.+|ai|langchain)$/i

function trackedRuntimeFiles() {
  return execFileSync("git", ["ls-files", "app", "lib", "scripts", "package.json", "package-lock.json"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => SOURCE_EXTENSIONS.has(extname(file)) || file === "package.json" || file === "package-lock.json")
}

function modelProviderOffenders(files: string[]) {
  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    for (const pattern of MODEL_PROVIDER_PATTERNS) {
      if (pattern.test(source)) offenders.push(`${file}: ${pattern}`)
    }
  }
  return offenders
}

function modelProviderStringOffenders(values: string[]) {
  const offenders: string[] = []
  for (const value of values) {
    if (MODEL_PROVIDER_DEPENDENCY_RE.test(value)) offenders.push(value)
  }
  return offenders
}

describe("deterministic recruiting ops boundary", () => {
  test("tracked runtime source has no model-provider imports or calls", () => {
    expect(modelProviderOffenders(trackedRuntimeFiles())).toEqual([])
  })

  test("production dependencies do not include model-provider SDKs", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>
    }
    const dependencyNames = Object.keys(pkg.dependencies ?? {})

    expect(modelProviderStringOffenders(dependencyNames)).toEqual([])
  })
})
