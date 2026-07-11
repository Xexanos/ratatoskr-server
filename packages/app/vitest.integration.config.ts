import { defineConfig } from 'vitest/config'

// Process-level integration tests: spawn the compiled server (dist/main.js) and talk to
// it over real HTTP. Separate from the unit config so the 90% coverage thresholds keep
// applying to the unit suite only (v8 coverage cannot see child-process code anyway).
// Requires a build first: pnpm run build && pnpm run test:integration
export default defineConfig({
  test: {
    include: ['test-integration/**/*.test.ts'],
    // The live-ABS test's beforeAll pulls + boots a real Audiobookshelf container and waits
    // for its library scan; a cold image pull alone can take minutes on a fresh CI runner.
    // Generous hook timeout for that setup; per-test work (single HTTP calls) is quick.
    hookTimeout: 300_000,
    testTimeout: 60_000,
  },
})
