import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  assertServerBuilt,
  cleanEnv,
  contractValidator,
  freePort,
  sessionStoreEnv,
  signIn,
  spawnServer,
  stopServer,
  waitUntilReady,
  type SpawnedServer,
} from './helpers.js'
import { createAbsUser, createStreamerApiKey, seedFetch } from './absSeed.js'

// Live-Audiobookshelf integration (SPEC section 15). The abs/ client is otherwise only exercised
// against fetch stubs, which verify our own parsing but not that our request/response shapes match
// a real ABS. The shared container is booted + seeded once per run in globalSetup; here we create
// this file's own users, spawn the compiled server against the live ABS, and drive the ABS-backed
// /v1 endpoints end to end. Complements smoke.integration.test.ts (no Docker); does not replace it.
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
  // A valid token pair from the server's /v1/auth/login, reused by the authenticated tests.
  let auth: { accessToken: string; refreshToken: string } = { accessToken: '', refreshToken: '' }
  // The /v2 equivalent: an opaque Ratatoskr token, minted by the server against the same live ABS.
  let v2Token = ''

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
        ...sessionStoreEnv(),
      }),
    )
    await waitUntilReady(server, port)

    // A valid pair for the authenticated tests below. Retried through the server's upstream path,
    // which returns 502 while ABS is still settling right after boot.
    const loginRes = await seedFetch('server /v1/auth/login', `${serverBase}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: LIVE_USER, password: LIVE_PASS }),
    })
    if (!loginRes.ok) throw new Error(`server login failed: ${loginRes.status} ${await loginRes.text()}`)
    const tokens = (await loginRes.json()) as { accessToken: string; refreshToken: string }
    auth = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
    // A separate sign-in on /v2, which opens its own private ABS chain for this "device" — the two
    // majors share no session, so each needs its own credential.
    v2Token = await signIn(serverBase, LIVE_USER, LIVE_PASS)
  })

  afterAll(async () => {
    // The shared ABS container is stopped by globalSetup, not here.
    if (server) await stopServer(server)
  })

  it('POST /v1/auth/login returns a contract-valid token pair from the real ABS', async () => {
    const res = await fetch(`${serverBase}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: LIVE_USER, password: LIVE_PASS }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    expect(typeof body.accessToken).toBe('string')
    expect(typeof body.refreshToken).toBe('string')
    expect(body.user).toMatchObject({ username: LIVE_USER })

    const validate = contractValidator('AuthTokens', '/v1')
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

    const validate = contractValidator('AuthTokens', '/v1')
    expect(validate(body)).toBe(true)
    expect(validate.errors).toBeNull()
    expect(typeof body.accessToken).toBe('string')
    expect(typeof body.refreshToken).toBe('string')
    expect(body.user).toMatchObject({ username: LIVE_USER })
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

    const validate = contractValidator('LibraryItemPage', '/v1')
    expect(validate(body)).toBe(true)
    expect(validate.errors).toBeNull()

    const seeded = body.items.find((item) => item.id === seededItemId)
    expect(seeded).toBeDefined()
    expect(typeof seeded?.title).toBe('string')
    expect(seeded?.title.length).toBeGreaterThan(0)
    // Duration comes from ABS's scan of the fixture audio (a real, non-zero-length file).
    expect(seeded?.durationSeconds).toBeGreaterThan(0)
  })

  // The same live data through the other mount, graded against 2.0.0. /v2's library operations are the
  // shared service's, so this is what would catch a mapping that conforms under one major and not the
  // other — /health alone cannot, since its shape is identical in both documents.
  //
  // The bearer here is the Ratatoskr token, and the ABS call behind it runs on the chain the server
  // opened at sign-in — so this also proves that resolution works against a real ABS, not just a stub.
  it('GET /v2/library/items serves the same seeded book, conformant to 2.0.0', async () => {
    const res = await fetch(`${serverBase}/v2/library/items`, {
      headers: { authorization: `Bearer ${v2Token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { id: string; coverUrl: string | null }[] }

    const validate = contractValidator('LibraryItemPage', '/v2')
    expect(validate(body)).toBe(true)
    expect(validate.errors).toBeNull()

    const seeded = body.items.find((item) => item.id === seededItemId)
    expect(seeded).toBeDefined()
    // The seeded fixture is a bare audio file with no cover art, so the honest expectation here is
    // null rather than a URL — ABS reports no coverPath and the mapping turns that into null. The
    // per-mount prefix on a book that *does* have a cover is pinned in the app's majorMounts test,
    // where the projection's input is controlled.
    expect(seeded?.coverUrl).toBeNull()
  })

  it('GET /v1/library/items/{itemId} returns detail with zero stored progress', async () => {
    const res = await fetch(`${serverBase}/v1/library/items/${encodeURIComponent(seededItemId)}`, {
      headers: { authorization: `Bearer ${auth.accessToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; progress: { positionSeconds: number; isFinished: boolean } }

    const validate = contractValidator('LibraryItem', '/v1')
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
  it('GET /v1/library/items joins the stored progress into the list once the user has listened', async () => {
    // Record progress directly in ABS — the server's accessToken IS the user's ABS token.
    const patchRes = await fetch(`${abs!.absBase}/api/me/progress/${encodeURIComponent(seededItemId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.accessToken}` },
      body: JSON.stringify({ currentTime: 12.5, duration: 60, progress: 12.5 / 60, isFinished: false }),
    })
    expect(patchRes.ok).toBe(true)

    const res = await fetch(`${serverBase}/v1/library/items`, {
      headers: { authorization: `Bearer ${auth.accessToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: { id: string; progress?: { positionSeconds: number; isFinished: boolean } }[]
    }

    const validate = contractValidator('LibraryItemPage', '/v1')
    expect(validate(body)).toBe(true)
    expect(validate.errors).toBeNull()

    const seeded = body.items.find((item) => item.id === seededItemId)
    expect(seeded?.progress).toEqual({ positionSeconds: 12.5, isFinished: false })
  })

  // The /v2 auth model against a real ABS. Three things here a fetch stub cannot establish: that
  // AbsClient.login/logout actually match this ABS version's request and response shapes, that an ABS
  // token is genuinely worthless as a /v2 bearer, and that sign-out really ends the chain upstream
  // rather than merely forgetting it locally.
  describe('POST /v2/auth/login and /v2/auth/logout against the live ABS', () => {
    it('returns a contract-valid AuthSession carrying no Audiobookshelf token', async () => {
      const res = await fetch(`${serverBase}/v2/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: LIVE_USER, password: LIVE_PASS }),
      })
      expect(res.status).toBe(200)
      const raw = await res.text()
      const body = JSON.parse(raw) as Record<string, unknown>

      const validate = contractValidator('AuthSession', '/v2')
      expect(validate(body)).toBe(true)
      expect(validate.errors).toBeNull()
      expect(body.user).toMatchObject({ username: LIVE_USER })
      // The /v1 pair for the same ABS user is at hand, so this is a real check rather than a shape one.
      expect(raw).not.toContain(auth.accessToken)
      expect(raw).not.toContain(auth.refreshToken)
      expect(body).not.toHaveProperty('accessToken')
      expect(body).not.toHaveProperty('refreshToken')
    })

    it('rejects the wrong password with 401', async () => {
      const res = await fetch(`${serverBase}/v2/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: LIVE_USER, password: 'not-the-password' }),
      })
      expect(res.status).toBe(401)
      expect(((await res.json()) as { code: string }).code).toBe('unauthorized')
    })

    // A genuine, current Audiobookshelf access token — valid on /v1 right now — must buy nothing here.
    it('does not accept an Audiobookshelf access token as a /v2 bearer', async () => {
      const res = await fetch(`${serverBase}/v2/library/items`, {
        headers: { authorization: `Bearer ${auth.accessToken}` },
      })
      expect(res.status).toBe(401)
      expect(((await res.json()) as { code: string }).code).toBe('unauthorized')
    })

    it('signs out idempotently and kills the token', async () => {
      const token = await signIn(serverBase, LIVE_USER, LIVE_PASS)
      const headers = { authorization: `Bearer ${token}` }

      expect((await fetch(`${serverBase}/v2/library/items`, { headers })).status).toBe(200)
      expect((await fetch(`${serverBase}/v2/auth/logout`, { method: 'POST', headers })).status).toBe(204)
      // Dead immediately, and a second sign-out still answers 204 (the contract's idempotence).
      expect((await fetch(`${serverBase}/v2/library/items`, { headers })).status).toBe(401)
      expect((await fetch(`${serverBase}/v2/auth/logout`, { method: 'POST', headers })).status).toBe(204)
    })

    // Sign-out is full-depth (SPEC section 8): the chain Ratatoskr held is ended at ABS, not merely
    // forgotten locally. Verified on chains this test owns — the server's own chain is deliberately
    // unreachable from out here, so what is under test is the call AbsClient.logout makes and what
    // this ABS version does with it.
    //
    // The doomed chain is never refreshed before it is ended: refreshing rotates the token in place,
    // which would leave the logout naming a session that no longer matches.
    //
    // The *per-device* half of that promise needs ABS >= 2.35.1, which is why it is asserted
    // conditionally below. Before that release ABS built the refresh token from second-precision JWT
    // timestamps with no per-session claim, so two sign-ins of one user inside the same second — which
    // is exactly what this test does — came back with the identical token; the session rows differed,
    // the token naming them at POST /logout did not (advplyr/audiobookshelf#5253). Probed: 2.26.0,
    // 2.29.0, 2.31.0 and 2.35.0 collide, 2.35.1 does not. ADR-0001 carries the amended fact.
    it('ends the Audiobookshelf chain upstream, and only that one where ABS keeps them apart', async () => {
      const v1Login = async () =>
        (await (
          await fetch(`${serverBase}/v1/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: LIVE_USER, password: LIVE_PASS }),
          })
        ).json()) as { accessToken: string; refreshToken: string }
      const absRefresh = (refreshToken: string) =>
        fetch(`${abs!.absBase}/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-refresh-token': refreshToken },
        })

      const control = await v1Login()
      const doomed = await v1Login()

      // Exactly the call AbsClient.logout makes.
      const ended = await fetch(`${abs!.absBase}/logout`, {
        method: 'POST',
        headers: { 'x-refresh-token': doomed.refreshToken, authorization: `Bearer ${doomed.accessToken}` },
      })
      expect(ended.ok).toBe(true)

      // That chain is dead — sign-out was not merely local forgetting. Holds on every version.
      expect((await absRefresh(doomed.refreshToken)).status).toBe(401)

      // Only meaningful where the two logins actually got distinct tokens (see above). Guarded on the
      // upstream property itself rather than on a version string, so this starts asserting the moment
      // the minimum ABS carries the fix, and never asserts something ABS cannot do.
      if (control.refreshToken !== doomed.refreshToken) {
        expect((await absRefresh(control.refreshToken)).ok).toBe(true)
      }
    })
  })
})
