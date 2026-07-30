import { once } from 'node:events'
import { statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  assertServerBuilt,
  cleanEnv,
  contractValidator,
  freePort,
  sessionStoreEnv,
  spawnServer,
  stopServer,
  waitUntilReady,
  type SpawnedServer,
} from './helpers.js'

// Process-level smoke tests: the real compiled server, spawned as a child process,
// spoken to over real HTTP — no inject(), no fetch stubbing. This is the automated
// version of the manual "boot it and curl /v1/health" verification, and it pins down
// the one file no unit test executes: main.ts. The shared harness lives in helpers.ts.

// An ABS that refuses the connection: a network error is tolerated at startup (the server degrades
// and /health reports it), so this boots a server without needing a fake upstream — what the tests
// using it are about happens after the ABS probe.
const UNREACHABLE_ABS = {
  ABS_URL: 'http://127.0.0.1:1',
  ABS_ALLOW_PLAIN_HTTP: 'true',
  ABS_STREAMER_API_KEY: 'streamer-key',
  ALLOW_PLAIN_HTTP: 'true',
}

// Poll /v1/health until Sonos is no longer reported as probing (its `detail` moves on from
// "probing, retry shortly"), so the test can assert the eventual, settled state rather than
// only the immediate post-boot one.
async function pollUntilSettled(port: number, deadlineMs = 15_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`)
    const body = (await res.json()) as { sonos?: { detail?: string } }
    if (body.sonos?.detail !== 'probing, retry shortly') return body as Record<string, unknown>
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Sonos health check did not settle within ${deadlineMs}ms`)
}

describe('server process smoke test', () => {
  let running: SpawnedServer | undefined
  let fakeAbs: Server | undefined

  beforeAll(() => {
    assertServerBuilt()
  })

  afterEach(async () => {
    if (running) await stopServer(running)
    running = undefined
    if (fakeAbs) {
      // The child's undici fetch holds keep-alive connections; close() alone would hang.
      fakeAbs.closeAllConnections()
      await new Promise((resolve) => fakeAbs?.close(resolve))
      fakeAbs = undefined
    }
  })

  it('boots, serves /health on both majors over real HTTP, and conforms to each contract', async () => {
    // A real HTTP upstream standing in for Audiobookshelf: answer /ping like ABS so the startup
    // probe and the health check treat it as a genuine, reachable ABS. No streamer login happens at
    // startup anymore — the media path uses a static API key — so only /ping needs answering.
    fakeAbs = createServer((_req, res) => res.end(JSON.stringify({ success: true })))
    await new Promise<void>((resolve) => fakeAbs?.listen(0, '127.0.0.1', resolve))
    const absPort = (fakeAbs.address() as AddressInfo).port

    const port = await freePort()
    running = spawnServer(
      cleanEnv({
        ABS_URL: `http://127.0.0.1:${absPort}`,
        ABS_STREAMER_API_KEY: 'streamer-key',
        ALLOW_PLAIN_HTTP: 'true',
        ABS_ALLOW_PLAIN_HTTP: 'true',
        PORT: String(port),
        ...sessionStoreEnv(),
      }),
    )
    await waitUntilReady(running, port)

    const res = await fetch(`http://127.0.0.1:${port}/v1/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    // The startup probe (main.ts) is kicked off before the listener opens, but SSDP discovery's
    // timeout (a few seconds) dwarfs the time it takes waitUntilReady to succeed, so this first
    // call lands while Sonos is still probing. That must not read as an outage: a still-probing
    // Sonos does not drag the overall status to degraded (SPEC section 14), only abs does here.
    expect(body.status).toBe('ok')
    expect(body.abs).toEqual({ reachable: true })
    expect(body.sonos).toEqual({ reachable: false, detail: 'probing, retry shortly' })
    // SPEC section 14: /health must not leak the server version to unauthenticated callers.
    expect(body.version).toBeUndefined()

    // Independent contract conformance (see helpers.contractValidator).
    const validate = contractValidator('Health', '/v1')
    const valid = validate(body)
    expect(validate.errors).toBeNull()
    expect(valid).toBe(true)

    // The second mount, on the same process, graded against its own document (SPEC section 6). This
    // is the one check that the real compiled server — not an injected Fastify instance — actually
    // serves both majors: the frozen /v1 document has to have reached the build, which for the
    // container means through `COPY contract ./contract` and the generate step, with no git history
    // in the build context.
    const v2 = await fetch(`http://127.0.0.1:${port}/v2/health`)
    expect(v2.status).toBe(200)
    const v2Body = (await v2.json()) as Record<string, unknown>
    expect(v2Body.abs).toEqual({ reachable: true })
    const validateV2 = contractValidator('Health', '/v2')
    const v2Valid = validateV2(v2Body)
    expect(validateV2.errors).toBeNull()
    expect(v2Valid).toBe(true)

    // Once the first probe actually settles - no real Sonos on the CI/test network, so discovery
    // finds nothing - the now-confirmed-unreachable Sonos does drag the overall status down.
    const settled = await pollUntilSettled(port)
    expect(settled.status).toBe('degraded')
    expect(settled.sonos).toMatchObject({ reachable: false, detail: 'Sonos did not respond' })
  })

  it('refuses to start when the streamer API key is rejected by a reachable Audiobookshelf', async () => {
    // /ping is fine (probe ok) but the key check (GET /api/me) is rejected: a reachable ABS with a
    // wrong/inactive/revoked streamer key is a real misconfiguration, so startup must fail loud
    // rather than defer to a silent playback failure.
    fakeAbs = createServer((req, res) => {
      if (req.url === '/api/me') {
        res.statusCode = 401
        res.end('unauthorized')
        return
      }
      res.end(JSON.stringify({ success: true }))
    })
    await new Promise<void>((resolve) => fakeAbs?.listen(0, '127.0.0.1', resolve))
    const absPort = (fakeAbs.address() as AddressInfo).port

    running = spawnServer(
      cleanEnv({
        ABS_URL: `http://127.0.0.1:${absPort}`,
        ABS_STREAMER_API_KEY: 'bad-key',
        ALLOW_PLAIN_HTTP: 'true',
        ABS_ALLOW_PLAIN_HTTP: 'true',
        PORT: String(await freePort()),
        ...sessionStoreEnv(),
      }),
    )
    const [code] = (await once(running.child, 'exit')) as [number | null]

    expect(code).toBe(1)
    expect(running.stderr()).toContain('ABS_STREAMER_API_KEY was rejected')
  })

  it('refuses to start when ABS_URL responds but is not Audiobookshelf', async () => {
    // A host that is up but does not answer /ping like ABS is almost always a misconfiguration —
    // the startup probe should fail loud rather than let it leak into runtime.
    fakeAbs = createServer((_req, res) => res.end('not audiobookshelf'))
    await new Promise<void>((resolve) => fakeAbs?.listen(0, '127.0.0.1', resolve))
    const absPort = (fakeAbs.address() as AddressInfo).port

    running = spawnServer(
      cleanEnv({
        ABS_URL: `http://127.0.0.1:${absPort}`,
        ABS_STREAMER_API_KEY: 'streamer-key',
        ALLOW_PLAIN_HTTP: 'true',
        ABS_ALLOW_PLAIN_HTTP: 'true',
        PORT: String(await freePort()),
        ...sessionStoreEnv(),
      }),
    )
    const [code] = (await once(running.child, 'exit')) as [number | null]

    expect(code).toBe(1)
    expect(running.stderr()).toContain('does not look like an Audiobookshelf server')
  })

  it('refuses to start with missing config, reporting all problems at once', async () => {
    running = spawnServer(cleanEnv())
    const [code] = (await once(running.child, 'exit')) as [number | null]

    expect(code).toBe(1)
    const stderr = running.stderr()
    expect(stderr).toContain('ABS_URL is required')
    expect(stderr).toContain('ABS_STREAMER_API_KEY is required')
    expect(stderr).toContain('no TLS configured')
    // Without the store there is nowhere to keep who is signed in, so it is required too
    // (SPEC section 8) — and unset is reported at boot, not at the first sign-in.
    expect(stderr).toContain('SESSION_STORE_KEY (or SESSION_STORE_KEY_FILE) is required')
    expect(stderr).toContain('SESSION_STORE_PATH is required')
  })

  // The three store failures below all happen at boot rather than at a user's first sign-in, which
  // is the point of opening it during startup (SPEC section 8). ABS is deliberately unreachable
  // here — a network error is tolerated at startup, so the store check is what the server gets to.
  it('refuses to start when the session store file cannot be written', async () => {
    running = spawnServer(
      cleanEnv({
        ...UNREACHABLE_ABS,
        PORT: String(await freePort()),
        ...sessionStoreEnv(),
        SESSION_STORE_PATH: join(tmpdir(), 'rtk-smoke-absent-dir', 'sessions.enc'),
      }),
    )
    const [code] = (await once(running.child, 'exit')) as [number | null]

    expect(code).toBe(1)
    expect(running.stderr()).toContain('could not be written')
  })

  it('refuses to start on a store it cannot decrypt, rather than starting from an empty one', async () => {
    // A store this server itself wrote at boot, then a restart under a different key — an operator
    // who rotated or lost SESSION_STORE_KEY. Starting empty would sign every device out silently,
    // so the only safe answer is to refuse and keep the file.
    const store = sessionStoreEnv()
    const port = await freePort()
    running = spawnServer(cleanEnv({ ...UNREACHABLE_ABS, PORT: String(port), ...store }))
    await waitUntilReady(running, port)
    await stopServer(running)

    running = spawnServer(
      cleanEnv({
        ...UNREACHABLE_ABS,
        PORT: String(await freePort()),
        ...store,
        SESSION_STORE_KEY: Buffer.alloc(32, 0x07).toString('base64'),
      }),
    )
    const [code] = (await once(running.child, 'exit')) as [number | null]

    expect(code).toBe(1)
    const stderr = running.stderr()
    expect(stderr).toContain('cannot be decrypted with the configured SESSION_STORE_KEY')
    expect(stderr).toContain('Refusing to continue')
  })

  it('creates the store file at boot, so an unwritable volume cannot go unnoticed', async () => {
    const store = sessionStoreEnv()
    const port = await freePort()
    running = spawnServer(cleanEnv({ ...UNREACHABLE_ABS, PORT: String(port), ...store }))
    await waitUntilReady(running, port)

    // Present before any request has been served — the store's own write path is what proves the
    // configured directory is real and writable.
    expect(statSync(store.SESSION_STORE_PATH).isFile()).toBe(true)
  })
})
