import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
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
import { createAbsUser } from './absSeed.js'

// End-to-end playback slice-1 flow (SPEC §4/§5): the compiled server against the shared live
// Audiobookshelf (globalSetup) and the REAL fake-Sonos UPnP/SOAP double, driving PUT/GET/DELETE
// /v1/sessions/current — start resumes from the ABS position, and stop writes progress back.
//
// Isolation: this file has its own ABS users (progress is per-user, so nothing here can leak into
// other files on the shared container), and each test is order-independent — beforeEach clears any
// session, re-seeds the user's progress to 1s, and resets the fake speaker.

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
  let absBase = ''
  let itemId = ''
  let userToken = ''
  let durationSeconds = 0

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

  // Start playback of the seeded book — each test that needs a running session calls this itself
  // instead of relying on an earlier test having started one.
  async function startSession(): Promise<void> {
    const res = await api('PUT', '/v1/sessions/current', { itemId, speakerId: SPEAKER_UUID })
    if (res.status !== 200) throw new Error(`startSession failed: ${res.status} ${await res.text()}`)
  }

  beforeAll(async () => {
    assertServerBuilt()
    absBase = abs!.absBase
    itemId = abs!.itemId

    await createAbsUser(absBase, abs!.adminToken, SESSION_USER, SESSION_PASS)
    await createAbsUser(absBase, abs!.adminToken, SESSION_STREAMER, SESSION_STREAMER_PASS)

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
        PORT: String(port),
      }),
    )
    await waitUntilReady(server, port)

    const loginRes = await api('POST', '/v1/auth/login', { username: SESSION_USER, password: SESSION_PASS }, '')
    if (!loginRes.ok) throw new Error(`server login failed: ${loginRes.status} ${await loginRes.text()}`)
    // The server proxies ABS's own tokens, so this accessToken is also a valid ABS bearer — used
    // by the beforeEach progress reset directly against ABS.
    userToken = ((await loginRes.json()) as { accessToken: string }).accessToken

    const itemRes = await api('GET', `/v1/library/items/${itemId}`)
    if (!itemRes.ok) throw new Error(`item detail failed: ${itemRes.status} ${await itemRes.text()}`)
    durationSeconds = ((await itemRes.json()) as { durationSeconds: number }).durationSeconds
  })

  // Order-independence: every test starts from the same state — no active session, this user's
  // progress at 1s (a non-zero resume position), a pristine speaker.
  beforeEach(async () => {
    // 1) Clear any leftover session FIRST — its stop handler writes progress on teardown.
    await api('DELETE', '/v1/sessions/current') // 204 or (no session) 404, both fine
    // 2) DELETE this user's progress record, then seed a fresh one. A PATCH cannot do this reset:
    //    verified against a live ABS, a finished record refuses isFinished:false and instead
    //    rewinds currentTime to 0 (the tiny-fixture end-tolerance in test 4 marks the book
    //    finished, so later tests would resume from 0). A freshly created record stores exactly
    //    what it is given.
    const authHeader = { authorization: `Bearer ${userToken}` }
    const meRes = await fetch(`${absBase}/api/me`, { headers: authHeader })
    if (!meRes.ok) throw new Error(`GET /api/me failed: ${meRes.status} ${await meRes.text()}`)
    const me = (await meRes.json()) as { mediaProgress?: { id?: string; libraryItemId?: string }[] }
    const record = me.mediaProgress?.find((p) => p.libraryItemId === itemId)
    if (record?.id) {
      const delRes = await fetch(`${absBase}/api/me/progress/${record.id}`, { method: 'DELETE', headers: authHeader })
      if (!delRes.ok) throw new Error(`progress record delete failed: ${delRes.status} ${await delRes.text()}`)
    }
    // Full field set on purpose: ABS stores only what it is given (see abs/client.ts writeProgress).
    const patchRes = await fetch(`${absBase}/api/me/progress/${itemId}`, {
      method: 'PATCH',
      headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({
        currentTime: 1,
        duration: durationSeconds,
        progress: 1 / durationSeconds,
        isFinished: false,
      }),
    })
    if (!patchRes.ok) throw new Error(`progress reset failed: ${patchRes.status} ${await patchRes.text()}`)
    // 3) Pristine speaker state.
    fake!.reset()
  })

  afterAll(async () => {
    // Best effort: don't leave a dangling playback session behind on the shared container.
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
    await startSession()
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
    await startSession()
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
