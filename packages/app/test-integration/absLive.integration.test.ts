import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StartedTestContainer } from 'testcontainers'
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
import {
  ABS_CURRENT,
  ABS_MIN,
  DOCKER_READY,
  REQUIRE_LIVE,
  ROOT_PASS,
  ROOT_USER,
  STREAMER_PASS,
  STREAMER_USER,
  seedFetch,
  startSeededAbs,
} from './absSeed.js'

// Live-Audiobookshelf integration (SPEC section 15). The abs/ client is otherwise only exercised
// against fetch stubs, which verify our own parsing but not that our request/response shapes match
// a real ABS. Here we boot a real, pinned Audiobookshelf in a container, seed it (via the shared
// startSeededAbs harness), spawn the compiled server against it, and drive the ABS-backed /v1
// endpoints end to end. Complements smoke.integration.test.ts (no Docker); does not replace it.

// Run against both ends of the supported range (README: >= 2.26) so a request/response-shape drift
// is caught at either boundary. Override with ABS_IT_IMAGE to run a single image.
const ABS_VERSIONS = process.env.ABS_IT_IMAGE
  ? [{ label: process.env.ABS_IT_IMAGE, image: process.env.ABS_IT_IMAGE }]
  : [ABS_MIN, ABS_CURRENT]

// Skip cleanly when there is no runtime and it is not required; otherwise run once per version.
const liveSuite = DOCKER_READY || REQUIRE_LIVE ? describe.each(ABS_VERSIONS) : describe.skip.each(ABS_VERSIONS)

liveSuite('live Audiobookshelf integration [$label]', ({ image }) => {
  let container: StartedTestContainer | undefined
  let server: SpawnedServer | undefined
  let serverBase = ''
  let seededItemId = ''
  // A valid token pair from the server's /v1/auth/login, reused by the authenticated tests.
  let auth: { accessToken: string; refreshToken: string } = { accessToken: '', refreshToken: '' }

  beforeAll(async () => {
    assertServerBuilt()
    // Reached only when the suite was not skipped; if we're here without a runtime, REQUIRE_LIVE
    // forced the run — fail loud rather than let live coverage vanish.
    if (!DOCKER_READY) {
      throw new Error('Docker is required for the live-ABS integration test (CI or ABS_IT_REQUIRE=1).')
    }

    const seeded = await startSeededAbs(image)
    container = seeded.container
    seededItemId = seeded.itemId

    // Spawn the compiled server against the live ABS. (Sonos stays unreachable on the test network,
    // so /health is degraded — irrelevant here, the server still boots.)
    const port = await freePort()
    serverBase = `http://127.0.0.1:${port}`
    server = spawnServer(
      cleanEnv({
        ABS_URL: seeded.absBase,
        ABS_ALLOW_PLAIN_HTTP: 'true',
        ABS_STREAMER_USER: STREAMER_USER,
        ABS_STREAMER_PASSWORD: STREAMER_PASS,
        ALLOW_PLAIN_HTTP: 'true',
        PORT: String(port),
      }),
    )
    await waitUntilReady(server, port)

    // A valid pair for the authenticated tests below. Retried through the server's upstream path,
    // which returns 502 while ABS is still settling right after boot.
    const loginRes = await seedFetch('server /v1/auth/login', `${serverBase}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ROOT_USER, password: ROOT_PASS }),
    })
    if (!loginRes.ok) throw new Error(`server login failed: ${loginRes.status} ${await loginRes.text()}`)
    const tokens = (await loginRes.json()) as { accessToken: string; refreshToken: string }
    auth = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
  })

  afterAll(async () => {
    if (server) await stopServer(server)
    await container?.stop()
  })

  it('POST /v1/auth/login returns a contract-valid token pair from the real ABS', async () => {
    const res = await fetch(`${serverBase}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ROOT_USER, password: ROOT_PASS }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    expect(typeof body.accessToken).toBe('string')
    expect(typeof body.refreshToken).toBe('string')
    expect(body.user).toMatchObject({ username: ROOT_USER })

    const validate = contractValidator('AuthTokens')
    expect(validate(body)).toBe(true)
    expect(validate.errors).toBeNull()
  })

  it('POST /v1/auth/refresh exchanges the refresh token for a fresh contract-valid pair', async () => {
    const res = await fetch(`${serverBase}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    const validate = contractValidator('AuthTokens')
    expect(validate(body)).toBe(true)
    expect(validate.errors).toBeNull()
    expect(typeof body.accessToken).toBe('string')
    expect(typeof body.refreshToken).toBe('string')
    expect(body.user).toMatchObject({ username: ROOT_USER })
    // Note: whether ABS *rotates* the refresh token on use is version-dependent (2.26.0 returns the
    // same token; newer versions rotate), so we assert the contract shape — a usable pair — rather
    // than rotation. The rotation-handover in SPEC section 8 degrades safely either way.
  })

  it('GET /v1/library/items lists the seeded book', async () => {
    const res = await fetch(`${serverBase}/v1/library/items`, {
      headers: { authorization: `Bearer ${auth.accessToken}` },
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

  it('GET /v1/library/items/{itemId} returns detail with zero stored progress', async () => {
    const res = await fetch(`${serverBase}/v1/library/items/${encodeURIComponent(seededItemId)}`, {
      headers: { authorization: `Bearer ${auth.accessToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; progress: { positionSeconds: number; isFinished: boolean } }

    const validate = contractValidator('LibraryItem')
    expect(validate(body)).toBe(true)
    expect(validate.errors).toBeNull()

    expect(body.id).toBe(seededItemId)
    // Nothing has been listened to yet: getProgress maps ABS's 404 to a zeroed Progress.
    expect(body.progress).toEqual({ positionSeconds: 0, isFinished: false })
  })
})
