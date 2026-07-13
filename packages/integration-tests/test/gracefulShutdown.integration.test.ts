import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { FakeSonos } from '@ratatoskr/fake-sonos'
import { assertServerBuilt, cleanEnv, freePort, spawnServer, stopServer, waitUntilReady, type SpawnedServer } from './helpers.js'
import { createAbsUser } from './absSeed.js'

// Graceful shutdown (SPEC §5): on SIGTERM the compiled server must stop the active session — writing
// the reached position back to the real ABS — before exiting cleanly. Skipped on Windows, where Node
// cannot deliver SIGTERM to a child as a catchable signal (the process is hard-terminated); the
// deployment target is a Linux container (`docker stop` → SIGTERM), which CI exercises.

const abs = inject('absLive')

const SPEAKER_UUID = 'RINCON_FAKE000001400'
const USER = 'it-shutdown-user'
const PASS = 'it-shutdown-pass'
const STREAMER = 'it-shutdown-streamer'
const STREAMER_PASS = 'it-shutdown-streamer-pass'

describe.skipIf(abs === null || process.platform === 'win32')('graceful shutdown (real ABS + fake Sonos)', () => {
  let fake: FakeSonos | undefined
  let server: SpawnedServer | undefined
  let base = ''
  let absBase = ''
  let itemId = ''
  let userToken = ''

  async function api(method: string, path: string, body?: unknown, token = userToken): Promise<Response> {
    return fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  beforeAll(async () => {
    assertServerBuilt()
    absBase = abs!.absBase
    itemId = abs!.itemId

    await createAbsUser(absBase, abs!.adminToken, USER, PASS)
    await createAbsUser(absBase, abs!.adminToken, STREAMER, STREAMER_PASS)

    fake = new FakeSonos({ uuid: SPEAKER_UUID, roomName: 'Test Room' })
    const sonosInfo = await fake.start()

    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    server = spawnServer(
      cleanEnv({
        ABS_URL: absBase,
        ABS_ALLOW_PLAIN_HTTP: 'true',
        ABS_STREAMER_USER: STREAMER,
        ABS_STREAMER_PASSWORD: STREAMER_PASS,
        ALLOW_PLAIN_HTTP: 'true',
        SONOS_SEED_HOST: sonosInfo.seedHost,
        SONOS_DISABLE_EVENTS: '1',
        SEEK_SETTLE_MS: '10',
        // A long poll interval so the sync loop cannot itself write during the test — the only write
        // must be the shutdown one, so the assertion pins the shutdown behavior specifically.
        POLL_INTERVAL_SECONDS: '3600',
        PORT: String(port),
      }),
    )
    await waitUntilReady(server, port)

    const loginRes = await api('POST', '/v1/auth/login', { username: USER, password: PASS }, '')
    if (!loginRes.ok) throw new Error(`server login failed: ${loginRes.status} ${await loginRes.text()}`)
    userToken = ((await loginRes.json()) as { accessToken: string }).accessToken

    // Seed a non-zero resume position so start() has somewhere to resume from.
    const patchRes = await fetch(`${absBase}/api/me/progress/${itemId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ currentTime: 1, isFinished: false }),
    })
    if (!patchRes.ok) throw new Error(`progress seed failed: ${patchRes.status} ${await patchRes.text()}`)
  })

  afterAll(async () => {
    if (server) await stopServer(server) // no-op if the SIGTERM test already made it exit
    await fake?.stop()
  })

  it('writes the reached position back to ABS on SIGTERM, then exits cleanly (0)', async () => {
    const startRes = await api('PUT', '/v1/sessions/current', { itemId, speakerId: SPEAKER_UUID })
    expect(startRes.status).toBe(200)

    // The listener has advanced to 25s on the speaker (mid-book on the 60s fixture).
    if (!fake) throw new Error('fake not started')
    fake.relTimeSeconds = 25

    const exited = once(server!.child, 'exit')
    server!.child.kill('SIGTERM')
    const [code] = (await exited) as [number | null]
    expect(code).toBe(0) // clean exit, not SIGKILLed by the drain timeout

    // ABS now holds the reached position written during shutdown — not the seeded 1s.
    const prog = (await (
      await fetch(`${absBase}/api/me/progress/${itemId}`, { headers: { authorization: `Bearer ${userToken}` } })
    ).json()) as { currentTime: number }
    expect(Math.round(prog.currentTime)).toBe(25)
  })
})
