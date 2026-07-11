import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

// Live-Audiobookshelf integration (SPEC section 15, first next step). The abs/ client is
// otherwise only exercised against fetch stubs, which verify our own parsing but not that
// our request/response shapes match a real ABS. Here we boot a real, pinned Audiobookshelf
// in a container, seed it, spawn the compiled server against it, and drive the ABS-backed
// /v1 endpoints end to end — closing the "no live-ABS smoke test before phase 4" gap.
//
// Complements smoke.integration.test.ts (which pins /health + the startup fail-loud paths
// with a trivial fake ABS and needs no Docker); it does not replace it.

// ABS 2.35.1, pinned by multi-arch manifest digest so the test is reproducible and cannot
// drift onto a moving tag. Must stay >= 2.26 for the refresh-token model the client uses
// (x-return-tokens on login, x-refresh-token on refresh).
const ABS_IMAGE = 'ghcr.io/advplyr/audiobookshelf@sha256:1eef6716183c52abafe5405e7d6be8390248ecd59c7488c44af871757ac8fc4d'
const ABS_PORT = 13378
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/audiobooks', import.meta.url))

// The user we log in as (the "listening user"). Root is guaranteed to see every library.
const ROOT_USER = 'root'
const ROOT_PASS = 'rootpassword'
// The dedicated streamer identity (SPEC section 14). Seeded for phase-4 forward-compatibility;
// the endpoints under test use the listening user's token, not this one.
const STREAMER_USER = 'streamer'
const STREAMER_PASS = 'streampassword'

// Probe for a reachable container runtime. On any throw — missing CLI, daemon down, or a slow
// daemon that exceeds the timeout — log *why* and return false: a bare `false` would make a
// skipped-because-Docker-is-genuinely-absent run indistinguishable from a skipped-because-the-
// probe-flaked run. The timeout is generous so a slow-but-present daemon is not misread as absent.
function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 60_000 })
    return true
  } catch (error) {
    console.warn(`[absLive] Docker probe failed; live-ABS test cannot run against a real container: ${String(error)}`)
    return false
  }
}

const DOCKER_READY = dockerAvailable()
// In CI (or when explicitly demanded) a missing runtime must FAIL rather than silently skip —
// otherwise the whole point of the live-ABS test could vanish while CI still goes green. Locally,
// with no runtime, it skips cleanly so `pnpm test:integration` still passes.
const REQUIRE_LIVE = process.env.CI === 'true' || process.env.ABS_IT_REQUIRE === '1'

async function poll(label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms${lastError ? ` (last error: ${String(lastError)})` : ''}`)
}

// First-contact seeding calls race Audiobookshelf's warm-up: the wait strategy proves the HTTP
// layer answers, but /init and the seeding API may still be coming up, so a transient network
// error or 5xx is expected on the first attempt. Retry those; return any <500 response to the
// caller so a real 4xx (our bug) surfaces immediately instead of being retried into a timeout.
async function seedFetch(label: string, url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, init)
      if (res.status < 500) return res
      last = `HTTP ${res.status}`
      await res.body?.cancel()
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${label} did not succeed within ${timeoutMs}ms (last: ${String(last)})`)
}

describe.skipIf(!DOCKER_READY && !REQUIRE_LIVE)('live Audiobookshelf integration', () => {
  let container: StartedTestContainer | undefined
  let server: SpawnedServer | undefined
  let serverBase = ''
  let seededItemId = ''
  // A valid token pair from the server's /v1/auth/login, reused by the authenticated tests.
  let auth: { accessToken: string; refreshToken: string } = { accessToken: '', refreshToken: '' }

  // Log in against ABS directly (seeding only), tolerant of small shape differences across
  // versions, to obtain the admin access token used for the seeding API calls.
  async function absAdminToken(absBase: string): Promise<string> {
    const res = await seedFetch('ABS admin login', `${absBase}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-return-tokens': 'true' },
      body: JSON.stringify({ username: ROOT_USER, password: ROOT_PASS }),
    })
    if (!res.ok) throw new Error(`ABS admin login failed: ${res.status} ${await res.text()}`)
    const body = (await res.json()) as {
      accessToken?: unknown
      user?: { accessToken?: unknown; token?: unknown }
    }
    const token = [body.accessToken, body.user?.accessToken, body.user?.token].find((t) => typeof t === 'string')
    if (typeof token !== 'string') throw new Error('ABS admin login returned no access token')
    return token
  }

  beforeAll(async () => {
    assertServerBuilt()
    // Reached only when the suite was not skipped. If we got here without a runtime, it is
    // because REQUIRE_LIVE forced the run — fail loud rather than let live coverage vanish.
    if (!DOCKER_READY) {
      throw new Error(
        'Docker is required for the live-ABS integration test (CI or ABS_IT_REQUIRE=1) but ' +
          '`docker info` did not succeed. Refusing to skip silently — see the probe warning above.',
      )
    }

    // 1. Boot a real Audiobookshelf with the fixture audiobook copied in.
    container = await new GenericContainer(ABS_IMAGE)
      // The image binds port 80 by default; pin it to a known port explicitly instead.
      .withEnvironment({ PORT: String(ABS_PORT) })
      .withExposedPorts(ABS_PORT)
      .withCopyDirectoriesToContainer([{ source: FIXTURE_DIR, target: '/audiobooks' }])
      .withWaitStrategy(Wait.forHttp('/status', ABS_PORT).forStatusCode(200))
      .withStartupTimeout(120_000)
      .start()
    const absBase = `http://${container.getHost()}:${container.getMappedPort(ABS_PORT)}`

    // 2. Create the root user on the fresh install. Retried: /init may not be serving the
    //    instant the wait strategy's HTTP probe first succeeds.
    const initRes = await seedFetch('ABS /init', `${absBase}/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newRoot: { username: ROOT_USER, password: ROOT_PASS } }),
    })
    if (!initRes.ok) throw new Error(`ABS /init failed: ${initRes.status} ${await initRes.text()}`)

    // 3. Admin token for the remaining seeding calls.
    const adminToken = await absAdminToken(absBase)
    const authHeader = { authorization: `Bearer ${adminToken}` }

    // 4. Create a book library pointing at the copied-in audiobook folder.
    const libRes = await seedFetch('ABS create library', `${absBase}/api/libraries`, {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Books', folders: [{ fullPath: '/audiobooks' }], mediaType: 'book' }),
    })
    if (!libRes.ok) throw new Error(`ABS create library failed: ${libRes.status} ${await libRes.text()}`)
    const lib = (await libRes.json()) as { id?: string; library?: { id?: string } }
    const libraryId = lib.id ?? lib.library?.id
    if (!libraryId) throw new Error('ABS create library returned no id')

    // 5. Force a scan of the new library (the scan auto-queued on creation does not reliably
    //    pick up the freshly-copied files), then wait for the book to be fully scanned.
    const scanRes = await seedFetch('ABS library scan', `${absBase}/api/libraries/${libraryId}/scan`, {
      method: 'POST',
      headers: authHeader,
    })
    if (!scanRes.ok) throw new Error(`ABS library scan failed: ${scanRes.status} ${await scanRes.text()}`)

    await poll(
      'the seeded book to be scanned with a probed duration',
      async () => {
        const res = await fetch(`${absBase}/api/libraries/${libraryId}/items`, { headers: authHeader })
        if (!res.ok) return false
        const data = (await res.json()) as { results?: { id?: string; media?: { duration?: number } }[] }
        const first = data.results?.[0]
        // ABS inserts the item row before ffprobe fills in the duration — gate on both so the
        // library tests can assert durationSeconds > 0 without racing the probe on a slow runner.
        if (first?.id && typeof first.media?.duration === 'number' && first.media.duration > 0) {
          seededItemId = first.id
          return true
        }
        return false
      },
      90_000,
    )

    // 6. Seed the streamer identity (forward-compat; not exercised by these endpoints).
    const userRes = await seedFetch('ABS create streamer user', `${absBase}/api/users`, {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ username: STREAMER_USER, password: STREAMER_PASS, type: 'user' }),
    })
    if (!userRes.ok) throw new Error(`ABS create streamer user failed: ${userRes.status} ${await userRes.text()}`)

    // 7. Spawn the compiled server against the live ABS. (Sonos stays unreachable on the test
    //    network, so /health is degraded — irrelevant here, the server still boots.)
    const port = await freePort()
    serverBase = `http://127.0.0.1:${port}`
    server = spawnServer(
      cleanEnv({
        ABS_URL: absBase,
        ABS_ALLOW_PLAIN_HTTP: 'true',
        ABS_STREAMER_USER: STREAMER_USER,
        ABS_STREAMER_PASSWORD: STREAMER_PASS,
        ALLOW_PLAIN_HTTP: 'true',
        PORT: String(port),
      }),
    )
    await waitUntilReady(server, port)

    // A valid pair for the authenticated tests below. Retried through the server's upstream
    // path, which returns 502 while ABS is still settling right after boot.
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

  it('POST /v1/auth/refresh exchanges the refresh token for a rotated pair', async () => {
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
    // ABS rotates the refresh token on every use (SPEC section 8): the new one must differ.
    expect(body.refreshToken).not.toBe(auth.refreshToken)
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
