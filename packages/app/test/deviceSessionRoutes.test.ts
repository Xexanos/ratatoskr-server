import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { AbsUpstreamError } from '../src/abs/errors.js'
import { SessionStore } from '../src/auth/sessionStore.js'
import type { SonosClient } from '../src/sonos/client.js'
import { ABS_CHAIN, buildTestApp, DEVICE_TOKEN, DEVICE_USER, V2_AUTH } from './helpers/testApp.js'

// The device session list (issue #138) through real routes: what a signed-in user sees of their own
// sign-ins, and what ending one does.

const UPSTREAM = {
  accessToken: 'abs-access-token',
  refreshToken: 'abs-refresh-token',
  user: { id: 'usr-1', username: 'listener' },
}
const CREDENTIALS = { username: 'listener', password: 's3cret' }
const OTHER_USER = { absUserId: 'usr-2', absUsername: 'other', chain: { accessToken: 'o-a', refreshToken: 'o-r' } }
const SIBLING_TOKEN = 'rtk-sibling-token'

function appWith(abs: Partial<AbsClient> = {}, { store, signedIn }: { signedIn?: boolean; store?: SessionStore } = {}) {
  return buildTestApp(
    {
      absClient: { login: vi.fn().mockResolvedValue(UPSTREAM), logout: vi.fn().mockResolvedValue(undefined), ...abs } as AbsClient,
      sonosClient: {} as SonosClient,
      ...(store !== undefined ? { sessionStore: store } : {}),
    },
    signedIn === undefined ? {} : { signedIn },
  )
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

interface Listed {
  id: string
  deviceName?: string
  createdAt: string
  lastUsedAt?: string
  current: boolean
}

describe('POST /v2/auth/login with a deviceName', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows the name on the new device session and nowhere else', async () => {
    const { app, store } = await appWith({}, { signedIn: false })
    const res = await app.inject({
      method: 'POST',
      url: '/v2/auth/login',
      payload: { ...CREDENTIALS, deviceName: 'Pixel 8' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ token: expect.any(String), user: UPSTREAM.user })
    expect(store.find(res.json().token as string)?.deviceName).toBe('Pixel 8')
    await app.close()
  })

  it('does not inherit the name of the session it replaces', async () => {
    const { app, store } = await appWith()
    const first = await app.inject({
      method: 'POST',
      url: '/v2/auth/login',
      payload: { ...CREDENTIALS, deviceName: 'Pixel 8' },
    })
    const second = await app.inject({
      method: 'POST',
      url: '/v2/auth/login',
      headers: bearer(first.json().token as string),
      payload: CREDENTIALS,
    })

    expect(store.find(second.json().token as string)?.deviceName).toBeUndefined()
    await app.close()
  })

  it.each([
    ['empty', ''],
    ['longer than 64 characters', 'x'.repeat(65)],
  ])('rejects a deviceName that is %s as 400, before reaching ABS', async (_case, deviceName) => {
    const login = vi.fn()
    const { app } = await appWith({ login }, { signedIn: false })
    const res = await app.inject({ method: 'POST', url: '/v2/auth/login', payload: { ...CREDENTIALS, deviceName } })

    expect(res.statusCode).toBe(400)
    expect(login).not.toHaveBeenCalled()
    await app.close()
  })

  it('accepts a 64-character deviceName', async () => {
    const { app } = await appWith({}, { signedIn: false })
    const res = await app.inject({
      method: 'POST',
      url: '/v2/auth/login',
      payload: { ...CREDENTIALS, deviceName: 'x'.repeat(64) },
    })

    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

describe('GET /v2/auth/device-sessions', () => {
  afterEach(() => vi.restoreAllMocks())

  it('lists the caller own device sessions, flagging the caller', async () => {
    const { app, store } = await appWith()
    await store.create(SIBLING_TOKEN, { ...DEVICE_USER, chain: ABS_CHAIN, deviceName: 'Old tablet' })
    await store.create('foreign', OTHER_USER)

    const res = await app.inject({ method: 'GET', url: '/v2/auth/device-sessions', headers: V2_AUTH })

    expect(res.statusCode).toBe(200)
    const items = res.json().items as Listed[]
    expect(items).toHaveLength(2)
    expect(items.filter((item) => item.current)).toEqual([expect.objectContaining({ id: store.find(DEVICE_TOKEN)?.id })])
    expect(items.find((item) => !item.current)).toMatchObject({
      id: store.find(SIBLING_TOKEN)?.id,
      deviceName: 'Old tablet',
      createdAt: expect.any(String),
    })
    // Nothing of the other user, and no credential material of anyone.
    expect(res.body).not.toContain(store.find('foreign')?.id)
    expect(res.body).not.toContain(store.find(DEVICE_TOKEN)?.tokenHash)
    expect(res.body).not.toContain(DEVICE_TOKEN)
    expect(res.body).not.toContain(ABS_CHAIN.accessToken)
    await app.close()
  })

  it('omits the name and last used of a device that has neither', async () => {
    const { app, store } = await appWith()
    await store.create(SIBLING_TOKEN, { ...DEVICE_USER, chain: ABS_CHAIN })

    const res = await app.inject({ method: 'GET', url: '/v2/auth/device-sessions', headers: V2_AUTH })

    const sibling = (res.json().items as Listed[]).find((item) => !item.current)
    expect(sibling).toBeDefined()
    expect(sibling).not.toHaveProperty('deviceName')
    expect(sibling).not.toHaveProperty('lastUsedAt')
    await app.close()
  })

  it('reports last used from the device own requests, fresh, and not for its idle siblings', async () => {
    const { app, store } = await appWith()
    await store.create(SIBLING_TOKEN, { ...DEVICE_USER, chain: ABS_CHAIN })

    const before = Date.now()
    const res = await app.inject({ method: 'GET', url: '/v2/auth/device-sessions', headers: V2_AUTH })

    const items = res.json().items as Listed[]
    const mine = items.find((item) => item.current)
    expect(Date.parse(mine?.lastUsedAt ?? '')).toBeGreaterThanOrEqual(before)
    expect(items.find((item) => !item.current)?.lastUsedAt).toBeUndefined()
    await app.close()
  })

  it('lists the most recently signed in device first', async () => {
    const { app, store } = await appWith()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.create(SIBLING_TOKEN, { ...DEVICE_USER, chain: ABS_CHAIN })

    const res = await app.inject({ method: 'GET', url: '/v2/auth/device-sessions', headers: V2_AUTH })

    expect((res.json().items as Listed[]).map((item) => item.current)).toEqual([false, true])
    await app.close()
  })

  it('rejects a missing bearer and an unknown one as 401', async () => {
    const { app } = await appWith()

    expect((await app.inject({ method: 'GET', url: '/v2/auth/device-sessions' })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url: '/v2/auth/device-sessions', headers: bearer('never-issued') })).statusCode,
    ).toBe(401)
    await app.close()
  })
})

describe('DELETE /v2/auth/device-sessions/{id}', () => {
  afterEach(() => vi.restoreAllMocks())

  it('ends another of the caller devices: token dead at once, shared chain kept', async () => {
    const logout = vi.fn().mockResolvedValue(undefined)
    const { app, store } = await appWith({ logout })
    const sibling = await store.create(SIBLING_TOKEN, { ...DEVICE_USER, chain: ABS_CHAIN })

    const res = await app.inject({ method: 'DELETE', url: `/v2/auth/device-sessions/${sibling.id}`, headers: V2_AUTH })

    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    expect(store.find(SIBLING_TOKEN)).toBeUndefined()
    expect(store.find(DEVICE_TOKEN)).toBeDefined()
    expect(logout).not.toHaveBeenCalled()
    await app.close()
  })

  it('may end the caller own entry, with exactly logout effect: last device releases the chain upstream', async () => {
    const logout = vi.fn().mockResolvedValue(undefined)
    const { app, store } = await appWith({ logout })
    const own = store.find(DEVICE_TOKEN)

    const res = await app.inject({ method: 'DELETE', url: `/v2/auth/device-sessions/${own?.id}`, headers: V2_AUTH })

    expect(res.statusCode).toBe(204)
    expect(store.find(DEVICE_TOKEN)).toBeUndefined()
    expect(logout).toHaveBeenCalledWith(ABS_CHAIN)
    await app.close()
  })

  it('still answers 204 when releasing the chain upstream fails', async () => {
    const logout = vi.fn().mockRejectedValue(new AbsUpstreamError('ABS is down'))
    const { app, store } = await appWith({ logout })
    const own = store.find(DEVICE_TOKEN)

    const res = await app.inject({ method: 'DELETE', url: `/v2/auth/device-sessions/${own?.id}`, headers: V2_AUTH })

    expect(res.statusCode).toBe(204)
    expect(store.find(DEVICE_TOKEN)).toBeUndefined()
    await app.close()
  })

  it('answers 404 for an unknown id, and for another user id in exactly the same way', async () => {
    const { app, store } = await appWith()
    const foreign = await store.create('foreign', OTHER_USER)

    const unknown = await app.inject({ method: 'DELETE', url: '/v2/auth/device-sessions/no-such-id', headers: V2_AUTH })
    const other = await app.inject({ method: 'DELETE', url: `/v2/auth/device-sessions/${foreign.id}`, headers: V2_AUTH })

    expect(unknown.statusCode).toBe(404)
    expect(other.statusCode).toBe(404)
    expect(other.json()).toEqual(unknown.json())
    expect(unknown.json().code).toBe('not_found')
    // The other user is untouched.
    expect(store.find('foreign')).toBeDefined()
    await app.close()
  })

  it('is not idempotent: a second delete of the same id is a 404', async () => {
    const { app, store } = await appWith()
    const sibling = await store.create(SIBLING_TOKEN, { ...DEVICE_USER, chain: ABS_CHAIN })
    const url = `/v2/auth/device-sessions/${sibling.id}`

    expect((await app.inject({ method: 'DELETE', url, headers: V2_AUTH })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url, headers: V2_AUTH })).statusCode).toBe(404)
    await app.close()
  })

  it('rejects a missing bearer as 401 and ends nothing', async () => {
    const { app, store } = await appWith()
    const sibling = await store.create(SIBLING_TOKEN, { ...DEVICE_USER, chain: ABS_CHAIN })

    const res = await app.inject({ method: 'DELETE', url: `/v2/auth/device-sessions/${sibling.id}` })

    expect(res.statusCode).toBe(401)
    expect(store.find(SIBLING_TOKEN)).toBeDefined()
    await app.close()
  })

  it('does not let a device that was just ended list or end anything', async () => {
    const { app, store } = await appWith()
    const sibling = await store.create(SIBLING_TOKEN, { ...DEVICE_USER, chain: ABS_CHAIN })
    await app.inject({ method: 'DELETE', url: `/v2/auth/device-sessions/${sibling.id}`, headers: V2_AUTH })

    const res = await app.inject({ method: 'GET', url: '/v2/auth/device-sessions', headers: bearer(SIBLING_TOKEN) })

    expect(res.statusCode).toBe(401)
    await app.close()
  })
})

describe('last used across a graceful shutdown', () => {
  afterEach(() => vi.restoreAllMocks())

  it('is flushed once on close, so a restart still shows it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rtk-lastused-'))
    onTestFinished(async () => {
      await rm(dir, { recursive: true, force: true })
    })
    const storeOptions = { path: join(dir, 'sessions.enc'), key: Buffer.alloc(32, 0x33) }

    const { app: first } = await appWith({}, { store: await SessionStore.open(storeOptions), signedIn: false })
    const login = await first.inject({ method: 'POST', url: '/v2/auth/login', payload: CREDENTIALS })
    const token = login.json().token as string
    // The first use is persisted; a later one within the hour is only in memory until shutdown.
    await first.inject({ method: 'GET', url: '/v2/auth/device-sessions', headers: bearer(token) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await first.inject({ method: 'GET', url: '/v2/auth/device-sessions', headers: bearer(token) })
    const lastUsed = (second.json().items as Listed[])[0]?.lastUsedAt
    await first.close()

    const reopened = await SessionStore.open(storeOptions)
    expect(reopened.find(token)?.lastUsedAt).toBe(lastUsed)
  })
})
