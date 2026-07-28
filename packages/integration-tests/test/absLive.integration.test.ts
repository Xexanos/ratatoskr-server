import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  assertServerBuilt,
  cleanEnv,
  contractValidator,
  freePort,
  spawnServer,
  stopServer,
  waitUntilReady,
  type SpawnedServer,
} from './helpers.js'
import { absAccessToken, createAbsUser, createStreamerApiKey } from './absSeed.js'

// Live-Audiobookshelf integration (SPEC section 15). The abs/ client is otherwise only exercised
// against fetch stubs, which verify our own parsing but not that our request/response shapes match
// a real ABS. The shared container is booted + seeded once per run in globalSetup; here we create
// this file's own users, spawn the compiled server against the live ABS, and drive the ABS-backed
// /v2 endpoints end to end. Complements smoke.integration.test.ts (no Docker); does not replace it.
//
// Version coverage lives in CI: two parallel jobs pass ABS_IT_IMAGE (pinned 2.26.0 minimum and the
// unpinned :latest drift canary); locally the default is the pinned current digest (absSeed.ts).

const abs = inject('absLive')

// This file's own ABS users (created in beforeAll). Root is seeding-only; per-file users keep the
// progress assertions below isolated from whatever other files do on the shared container.
const LIVE_USER = 'it-abslive-user'
const LIVE_PASS = 'it-abslive-pass'
const LIVE_STREAMER = 'it-abslive-streamer'
const LIVE_STREAMER_PASS = 'it-abslive-streamer-pass'

// Skips only when there is no runtime and it is not required — globalSetup already threw otherwise.
describe.skipIf(abs === null)(`live Audiobookshelf integration [${abs?.imageLabel ?? 'skipped: no Docker'}]`, () => {
  let server: SpawnedServer | undefined
  let serverBase = ''
  let seededItemId = ''
  // The bearer for the authenticated tests, taken straight from ABS: the server's /auth/login is
  // declared by contract 2.0.0 but not implemented yet (see ApiService), and its token guard accepts
  // any bearer ABS accepts. It doubles as a live ABS bearer further down for the same reason.
  let userToken = ''

  beforeAll(async () => {
    assertServerBuilt()
    const { absBase, itemId, adminToken } = abs!
    seededItemId = itemId

    await createAbsUser(absBase, adminToken, LIVE_USER, LIVE_PASS)
    const streamerApiKey = await createStreamerApiKey(absBase, adminToken, LIVE_STREAMER, LIVE_STREAMER_PASS)

    // Spawn the compiled server against the live ABS. (Sonos stays unreachable on the test network,
    // so /health is degraded — irrelevant here, the server still boots.)
    const port = await freePort()
    serverBase = `http://127.0.0.1:${port}`
    server = spawnServer(
      cleanEnv({
        ABS_URL: absBase,
        ABS_ALLOW_PLAIN_HTTP: 'true',
        ABS_STREAMER_API_KEY: streamerApiKey,
        ALLOW_PLAIN_HTTP: 'true',
        PORT: String(port),
      }),
    )
    await waitUntilReady(server, port)

    userToken = await absAccessToken(absBase, LIVE_USER, LIVE_PASS)
  })

  afterAll(async () => {
    // The shared ABS container is stopped by globalSetup, not here.
    if (server) await stopServer(server)
  })

  // No /auth/login test: contract 2.0.0 declares it, but nothing is wired behind it yet (#134), so no
  // ABS-facing code runs on that route. AbsClient.login therefore has no live coverage in this window
  // — it returns with the endpoint, and this is the file where the drift it once caught (SPEC §15, the
  // ABS 2.26 token nesting) would surface again.

  it('GET /v2/library/items lists the seeded book', async () => {
    const res = await fetch(`${serverBase}/v2/library/items`, {
      headers: { authorization: `Bearer ${userToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { id: string; title: string; durationSeconds: number }[] }

    const validate = contractValidator('LibraryItemPage')
    expect(validate(body)).toBe(true)
    expect(validate.errors).toBeNull()

    const seeded = body.items.find((item) => item.id === seededItemId)
    expect(seeded).toBeDefined()
    expect(typeof seeded?.title).toBe('string')
    expect(seeded?.title.length).toBeGreaterThan(0)
    // Duration comes from ABS's scan of the fixture audio (a real, non-zero-length file).
    expect(seeded?.durationSeconds).toBeGreaterThan(0)
  })

  it('GET /v2/library/items/{itemId} returns detail with zero stored progress', async () => {
    const res = await fetch(`${serverBase}/v2/library/items/${encodeURIComponent(seededItemId)}`, {
      headers: { authorization: `Bearer ${userToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; progress: { positionSeconds: number; isFinished: boolean } }

    const validate = contractValidator('LibraryItem')
    expect(validate(body)).toBe(true)
    expect(validate.errors).toBeNull()

    expect(body.id).toBe(seededItemId)
    // This file's user has never listened to anything: getProgress maps ABS's 404 to a zeroed
    // Progress. Holds on the shared container BECAUSE the user is exclusive to this file.
    expect(body.progress).toEqual({ positionSeconds: 0, isFinished: false })
  })

  // Ordered after the zero-progress detail test: this one records progress for the file's user,
  // so it must run last. Verifies the list join's upstream shape dependency (GET /api/me →
  // mediaProgress) against a real ABS, not just the unit tests' fetch stubs (issue #108).
  it('GET /v2/library/items joins the stored progress into the list once the user has listened', async () => {
    // Record progress directly in ABS with the same token.
    const patchRes = await fetch(`${abs!.absBase}/api/me/progress/${encodeURIComponent(seededItemId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ currentTime: 12.5, duration: 60, progress: 12.5 / 60, isFinished: false }),
    })
    expect(patchRes.ok).toBe(true)

    const res = await fetch(`${serverBase}/v2/library/items`, {
      headers: { authorization: `Bearer ${userToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: { id: string; progress?: { positionSeconds: number; isFinished: boolean } }[]
    }

    const validate = contractValidator('LibraryItemPage')
    expect(validate(body)).toBe(true)
    expect(validate.errors).toBeNull()

    const seeded = body.items.find((item) => item.id === seededItemId)
    expect(seeded?.progress).toEqual({ positionSeconds: 12.5, isFinished: false })
  })
})
