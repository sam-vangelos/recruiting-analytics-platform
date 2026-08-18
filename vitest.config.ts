import { configDefaults, defineConfig } from "vitest/config"

// The root green suite excludes the separately-run MCP packages and quarantined
// red specs. Both retain their own verification commands.
export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" path so route files (which import via the app
    // alias) are testable directly.
    alias: { "@": new URL(".", import.meta.url).pathname },
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/red/**", "mcp/**"],
    // Seven suites verify real behaviour by SPAWNING the checkers as subprocesses
    // (execFileSync over the real repo): the architecture check, the api-route auth and
    // error-sanitization boundaries, the greenhouse-write and supabase-server boundaries,
    // and the deterministic-model boundary. Vitest's 10s default is the wrong bar for
    // those — they run several node processes each, and the suite runs files in parallel
    // so they contend for CPU. On a developer laptop
    // recruiting-ops-architecture-check.behavioral took 13.4s and FAILED the 10s default
    // while passing in CI, which makes `npm test` a gate that flips on machine speed
    // rather than on correctness. 30s keeps genuine hangs failing (a hung spawn never
    // returns) while removing the speed sensitivity.
    testTimeout: 30_000,
  },
})
