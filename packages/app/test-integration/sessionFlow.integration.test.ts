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
  DOCKER_READY,
  REQUIRE_LIVE,
  ROOT_PASS,
  ROOT_USER,
  STREAMER_PASS,
  STREAMER_USER,
  startSeededAbs,
} from './absSeed.js'
import { FakeSonos } from '../test-support/fakeSonos.js'

// End-to-end playback slice-1 flow (SPEC §4/§5): the compiled server against a REAL Audiobookshelf
// (Testcontainers) and the REAL fake-Sonos UPnP/SOAP double, driving PUT/GET/DELETE
// /v1/sessions/current — start resumes from the ABS position, and stop writes progress back.

const run = DOCKER_READY || REQUIRE_LIVE ? describe : describe.skip

const SPEAKER_UUID = 'RINCON_FAKE000001400'

run('playback session flow (real ABS + fake Sonos)', () => {
  let container: StartedTestContainer | undefined
  let fake: FakeSonos | undefined
  let server: SpawnedServer | undefined
  let base = ''
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
    if (!DOCKER_READY) throw new Error('Docker is required for the session-flow test (CI/ABS_IT_REQUIRE)')

    const seeded = await startSeededAbs(ABS_CURRENT.image)
    container = seeded.container
    itemId = seeded.itemId

    // Pre-seed the root user's progress so start() has a non-zero position to resume from.
    await fetch(`${seeded.absBase}/api/me/progress/${itemId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${seeded.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ currentTime: 1, isFinished: false }),
    })

    fake = new FakeSonos({ uuid: SPEAKER_UUID, roomName: 'Test Room' })
    const sonosInfo = await fake.start()

    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    server = spawnServer(
      cleanEnv({
        ABS_URL: seeded.absBase,
        ABS_ALLOW_PLAIN_HTTP: 'true',
        ABS_STREAMER_USER: STREAMER_USER,
        ABS_STREAMER_PASSWORD: STREAMER_PASS,
        ALLOW_PLAIN_HTTP: 'true',
        SONOS_SEED_HOST: sonosInfo.seedHost,
        SONOS_DISABLE_EVENTS: '1',
        SEEK_SETTLE_MS: '10',
        PORT: String(port),
      }),
    )
    await waitUntilReady(server, port)

    const loginRes = await api('POST', '/v1/auth/login', { username: ROOT_USER, password: ROOT_PASS }, '')
    if (!loginRes.ok) throw new Error(`server login failed: ${loginRes.status} ${await loginRes.text()}`)
    userToken = ((await loginRes.json()) as { accessToken: string }).accessToken
  })

  afterAll(async () => {
    if (server) await stopServer(server)
    await fake?.stop()
    await container?.stop()
  })

  it('starts playback, resuming from the ABS position, with a DIDL queue on the speaker', async () => {
    const res = await api('PUT', '/v1/sessions/current', { itemId, speakerId: SPEAKER_UUID })
    expect(res.status).toBe(200)
    const session = (await res.json()) as Record<string, unknown>

    const validate = contractValidator('Session')
    expect(validate(session)).toBe(true)
    expect(session).toMatchObject({ itemId, speakerId: SPEAKER_UUID, state: 'playing', positionSeconds: 1 })
    expect(session.durationSeconds as number).toBeGreaterThan(0)

    // The server enqueued the book on the fake with DIDL carrying the mime + the streamer token,
    // and resumed to 1s.
    expect(fake?.queue.length).toBe(1)
    expect(fake?.queue[0]?.uri).toContain(`/api/items/${itemId}/file/`)
    expect(fake?.queue[0]?.uri).toContain('token=')
    expect(fake?.queue[0]?.metadata).toMatch(/protocolInfo="http-get:\*:audio\/[^"]+:\*"/)
    expect(fake?.transportState).toBe('PLAYING')
    expect(fake?.relTimeSeconds).toBe(1)
  })

  it('reports the active session with a live position', async () => {
    const res = await api('GET', '/v1/sessions/current')
    expect(res.status).toBe(200)
    const session = (await res.json()) as Record<string, unknown>
    expect(contractValidator('Session')(session)).toBe(true)
    expect(session).toMatchObject({ itemId, state: 'playing', positionSeconds: 1 })
  })

  it('rejects a non-empty but invalid bearer with 401 (validated upstream, not presence-only)', async () => {
    const res = await api('GET', '/v1/sessions/current', undefined, 'not-a-real-abs-token')
    expect(res.status).toBe(401)
  })

  it('stops with 204 and writes the reached position back to ABS', async () => {
    const res = await api('DELETE', '/v1/sessions/current')
    expect(res.status).toBe(204)

    // Progress was written back: the tiny fixture is within end-tolerance, so it is marked finished.
    const itemRes = await api('GET', `/v1/library/items/${itemId}`)
    const item = (await itemRes.json()) as { progress?: { isFinished?: boolean } }
    expect(item.progress?.isFinished).toBe(true)

    // And the session is gone.
    expect((await api('GET', '/v1/sessions/current')).status).toBe(404)
  })
})
