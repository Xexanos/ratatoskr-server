import { defineConfig } from 'vitest/config'

// Process-level integration tests: spawn the compiled server (dist/main.js) and talk to
// it over real HTTP. Separate from the unit config so the 90% coverage thresholds keep
// applying to the unit suite only (v8 coverage cannot see child-process code anyway).
// Requires a build first: pnpm run build && pnpm run test:integration
export default defineConfig({
  test: {
    include: ['test-integration/**/*.test.ts'],
    // Spawn + listen + poll on a cold CI runner doesn't fit vitest's 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
