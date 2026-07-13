import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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

// Process-level smoke tests: the real compiled server, spawned as a child process,
// spoken to over real HTTP — no inject(), no fetch stubbing. This is the automated
// version of the manual "boot it and curl /v1/health" verification, and it pins down
// the one file no unit test executes: main.ts. The shared harness lives in helpers.ts.

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

  it('boots, serves /v1/health over real HTTP, and conforms to the contract', async () => {
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
      }),
    )
    await waitUntilReady(running, port)

    const res = await fetch(`http://127.0.0.1:${port}/v1/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    // No real Sonos on the CI/test network, so discovery finds nothing: sonos is unreachable
    // and the overall status is therefore degraded (abs itself is reachable via the fake).
    expect(body.status).toBe('degraded')
    expect(body.abs).toEqual({ reachable: true })
    // sonos also carries a `detail` string when unreachable, so match only the flag we assert.
    expect(body.sonos).toMatchObject({ reachable: false })
    // SPEC section 14: /health must not leak the server version to unauthenticated callers.
    expect(body.version).toBeUndefined()

    // Independent contract conformance (see helpers.contractValidator).
    const validate = contractValidator('Health')
    const valid = validate(body)
    expect(validate.errors).toBeNull()
    expect(valid).toBe(true)
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
  })
})
