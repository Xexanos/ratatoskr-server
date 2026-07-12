import { defineConfig } from 'vitest/config'

// Process-level integration tests: spawn the compiled server (packages/app/dist/main.js)
// and talk to it over real HTTP. Requires a build first: pnpm run build && pnpm run
// test:integration. The live-ABS container is booted + seeded ONCE per run in globalSetup
// (which vitest does not subject to hookTimeout — the cold image pull happens there); the
// per-file hooks still create ABS users and spawn a server process, so keep the hook
// timeout generous.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/globalSetup.ts'],
    hookTimeout: 300_000,
    testTimeout: 60_000,
  },
})
