import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { FakeSonos } from '@ratatoskr/fake-sonos'
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
import { createAbsUser, poll } from './absSeed.js'

// End-to-end playback flow (SPEC §4/§5): the compiled server against the shared live Audiobookshelf
// (globalSetup) and the REAL fake-Sonos UPnP/SOAP double, driving the full session lifecycle —
// start (resume from the ABS position), pause/resume, seek, the background sync loop noticing a
// device-side change, and stop writing the reached position back.
//
// These tests are a deliberate SEQUENCE: they model one session's lifecycle, so each builds on the
// previous test's state (the stop test asserts the position the device-pause test left behind).
// Cross-FILE isolation on the shared container comes from this file's own ABS users (progress in
// ABS is per-user), not from per-test resets.

const abs = inject('absLive')

const SPEAKER_UUID = 'RINCON_FAKE000001400'

// This file's own ABS users (created in beforeAll). Root is seeding-only.
const SESSION_USER = 'it-session-user'
const SESSION_PASS = 'it-session-pass'
const SESSION_STREAMER = 'it-session-streamer'
const SESSION_STREAMER_PASS = 'it-session-streamer-pass'

describe.skipIf(abs === null)('playback session flow (real ABS + fake Sonos)', () => {
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
    const { absBase, itemId: seededItemId, adminToken } = abs!
    itemId = seededItemId

    await createAbsUser(absBase, adminToken, SESSION_USER, SESSION_PASS)
    await createAbsUser(absBase, adminToken, SESSION_STREAMER, SESSION_STREAMER_PASS)

    fake = new FakeSonos({ uuid: SPEAKER_UUID, roomName: 'Test Room' })
    const sonosInfo = await fake.start()

    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    server = spawnServer(
      cleanEnv({
        ABS_URL: absBase,
        ABS_ALLOW_PLAIN_HTTP: 'true',
        ABS_STREAMER_USER: SESSION_STREAMER,
        ABS_STREAMER_PASSWORD: SESSION_STREAMER_PASS,
        ALLOW_PLAIN_HTTP: 'true',
        SONOS_SEED_HOST: sonosInfo.seedHost,
        SONOS_DISABLE_EVENTS: '1',
        SEEK_SETTLE_MS: '10',
        // Tight loop so the continuous sync-loop assertions observe a write within seconds, and a
        // low threshold so even a small position move still crosses it.
        POLL_INTERVAL_SECONDS: '1',
        PROGRESS_WRITE_THRESHOLD_SECONDS: '1',
        PORT: String(port),
      }),
    )
    await waitUntilReady(server, port)

    // The server proxies ABS's own tokens, so this accessToken is also a valid ABS bearer.
    const loginRes = await api('POST', '/v1/auth/login', { username: SESSION_USER, password: SESSION_PASS }, '')
    if (!loginRes.ok) throw new Error(`server login failed: ${loginRes.status} ${await loginRes.text()}`)
    userToken = ((await loginRes.json()) as { accessToken: string }).accessToken

    // Pre-seed this user's progress so start() has a non-zero position to resume from. The user is
    // freshly created, so this creates a fresh record that stores exactly what it is given.
    const patchRes = await fetch(`${absBase}/api/me/progress/${itemId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ currentTime: 1, isFinished: false }),
    })
    if (!patchRes.ok) throw new Error(`progress seed failed: ${patchRes.status} ${await patchRes.text()}`)
  })

  afterAll(async () => {
    // Best effort: don't leave a dangling playback session behind if a test above failed mid-chain.
    if (server) {
      await api('DELETE', '/v1/sessions/current').catch(() => undefined)
      await stopServer(server)
    }
    await fake?.stop()
    // The shared ABS container is stopped by globalSetup, not here.
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

  // The reached position ABS currently has stored for the book (via the read projection).
  async function storedProgress(): Promise<{ positionSeconds: number; isFinished: boolean }> {
    const res = await api('GET', `/v1/library/items/${itemId}`)
    const item = (await res.json()) as { progress?: { positionSeconds?: number; isFinished?: boolean } }
    return { positionSeconds: item.progress?.positionSeconds ?? 0, isFinished: item.progress?.isFinished ?? false }
  }

  it('pauses on the coordinator and reflects the paused state', async () => {
    const res = await api('POST', '/v1/sessions/current/pause')
    expect(res.status).toBe(200)
    const session = (await res.json()) as Record<string, unknown>
    expect(contractValidator('Session')(session)).toBe(true)
    expect(session.state).toBe('paused')
    expect(fake?.transportState).toBe('PAUSED_PLAYBACK')
  })

  it('resumes on the coordinator and reflects the playing state', async () => {
    const res = await api('POST', '/v1/sessions/current/resume')
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).state).toBe('playing')
    expect(fake?.transportState).toBe('PLAYING')
  })

  it('seeks to a mid-book target and writes the (unfinished) position back to ABS', async () => {
    const res = await api('POST', '/v1/sessions/current/seek', { positionSeconds: 30 })
    expect(res.status).toBe(200)
    const session = (await res.json()) as Record<string, unknown>
    expect(session.positionSeconds).toBe(30)
    // The fake moved into the first track at 30s, and ABS now stores 30 / not-finished.
    expect(fake?.currentTrack).toBe(1)
    expect(fake?.relTimeSeconds).toBe(30)
    expect(await storedProgress()).toEqual({ positionSeconds: 30, isFinished: false })
  })

  it('the sync loop notices a device-side pause and writes the frozen position back', async () => {
    // Simulate the listener pressing pause on the speaker itself (Sonos app / hardware button): the
    // transport freezes at 40s. We never called our pause endpoint — the background loop must notice.
    if (!fake) throw new Error('fake not started')
    fake.relTimeSeconds = 40
    fake.transportState = 'PAUSED_PLAYBACK'

    // Within a poll interval the loop writes the moved position (30 -> 40) back to ABS.
    await poll(
      'the sync loop to write the device-side position back',
      async () => (await storedProgress()).positionSeconds === 40,
      8_000,
    )

    // And an explicit GET reflects the device-side pause as paused.
    const res = await api('GET', '/v1/sessions/current')
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).state).toBe('paused')
  })

  it('stops with 204 and writes the reached position back to ABS', async () => {
    const res = await api('DELETE', '/v1/sessions/current')
    expect(res.status).toBe(204)

    // The reached position (40s, mid-book) is persisted, not marked finished.
    expect(await storedProgress()).toEqual({ positionSeconds: 40, isFinished: false })

    // And the session is gone.
    expect((await api('GET', '/v1/sessions/current')).status).toBe(404)
  })
})
