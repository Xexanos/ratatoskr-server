import type { TestProject } from 'vitest/node'
import { dockerAvailable, REQUIRE_LIVE, resolveAbsImage, startSeededAbs } from './absSeed.js'

// One live Audiobookshelf per vitest run: boot + seed (root user, library, scan) happen HERE,
// once, and the connection info crosses to the worker processes via provide()/inject(). Test
// files then only create their own users and spawn their own server — isolation lives in
// per-file ABS users, not per-file containers.
//
// Trade-off, accepted: with Docker present, even a filtered run of only the (Docker-free)
// smoke test boots the container.

export interface AbsLiveContext {
  absBase: string
  itemId: string
  libraryId: string
  adminToken: string
  imageLabel: string
}

declare module 'vitest' {
  export interface ProvidedContext {
    /** null ⇔ no container runtime available (and not required) — live suites skip themselves. */
    absLive: AbsLiveContext | null
  }
}

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  if (!dockerAvailable()) {
    // Same gate semantics as before the shared container: skip cleanly on a dev machine
    // without a runtime, FAIL in CI (or under ABS_IT_REQUIRE=1) so live coverage can't
    // silently vanish while CI stays green.
    if (REQUIRE_LIVE) {
      throw new Error('Docker is required for the live-ABS integration tests (CI or ABS_IT_REQUIRE=1).')
    }
    project.provide('absLive', null)
    return undefined
  }

  const image = resolveAbsImage()
  const seeded = await startSeededAbs(image)
  project.provide('absLive', {
    absBase: seeded.absBase,
    itemId: seeded.itemId,
    libraryId: seeded.libraryId,
    adminToken: seeded.adminToken,
    imageLabel: image,
  })
  return async () => {
    await seeded.container.stop()
  }
}
