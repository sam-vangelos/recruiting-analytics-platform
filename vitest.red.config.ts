import { defineConfig } from "vitest/config"

// Quarantined RED specs. Each test here encodes audited-but-unfixed behavior and is
// EXPECTED TO FAIL on HEAD by AssertionError (not by load/compile error — tsconfig still
// globs **/*.ts, so red specs must be type-valid and fail at runtime). As each population
// is fixed, its spec moves from test/red/ to test/ (now green). CI asserts this suite
// currently fails; a red spec that passes or fails-to-load is a build error. An EMPTY
// test/red/ is the goal state (backlog drained — reached 2026-07-01) and passes cleanly.
export default defineConfig({
  test: {
    include: ["test/red/**/*.test.ts"],
    passWithNoTests: true,
  },
})
