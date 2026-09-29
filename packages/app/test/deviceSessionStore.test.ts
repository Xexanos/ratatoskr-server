import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeStoreFile, encodeStoreFile } from '../src/auth/sessionFile.js'
import { SessionStore } from '../src/auth/sessionStore.js'

// The store half of the device session list (issue #138): the public id, the device name, and the
// two-tier "last used" (exact in memory, persisted throttled, flushed at shutdown).

const KEY = Buffer.alloc(32, 0xa1)
const RECORD = {
  absUserId: 'usr-1',
  absUsername: 'listener',
  chain: { accessToken: 'abs-access', refreshToken: 'abs-refresh' },
}
const HOUR = 60 * 60 * 1000

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rtk-devsess-'))
  path = join(dir, 'sessions.enc')
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

const open = (onWarning?: (m: string) => void) =>
  SessionStore.open({ path, key: KEY, ...(onWarning !== undefined ? { onWarning } : {}) })

async function stored(): Promise<{ devices: Array<Record<string, unknown>> }> {
  return JSON.parse(decodeStoreFile(KEY, await readFile(path), path).toString('utf8'))
}

describe('device session id and name', () => {
  it('gives every device a random public id that is not derived from the token', async () => {
    const store = await open()
    const a = await store.create('token-a', RECORD)
    const b = await store.create('token-b', RECORD)

    expect(a.id).toBeTruthy()
    expect(a.id).not.toBe(b.id)
    expect(a.id).not.toBe(a.tokenHash)
    expect(a.id).not.toContain('token-a')
  })

  it('keeps the device name given at sign-in, and none when the device sent none', async () => {
    const store = await open()
    const named = await store.create('token-a', { ...RECORD, deviceName: 'Pixel 8' })
    const anonymous = await store.create('token-b', RECORD)

    expect(named.deviceName).toBe('Pixel 8')
    expect(anonymous.deviceName).toBeUndefined()
    expect('deviceName' in anonymous).toBe(false)
  })

  it('persists id and name so they survive a restart', async () => {
    const store = await open()
    const created = await store.create('token-a', { ...RECORD, deviceName: 'Pixel 8' })

    const reopened = await open()
    const found = reopened.find('token-a')
    expect(found?.id).toBe(created.id)
    expect(found?.deviceName).toBe('Pixel 8')
  })

  it('does not carry the name over when a re-authentication replaces the device', async () => {
    const store = await open()
    await store.create('old-token', { ...RECORD, deviceName: 'Pixel 8' })
    const next = await store.create('new-token', RECORD)

    expect(next.deviceName).toBeUndefined()
  })
})

describe('deleteDeviceSession', () => {
  it('kills the token at once and keeps the chain while another device rides it', async () => {
    const store = await open()
    const phone = await store.create('phone', RECORD)
    await store.create('tablet', RECORD)

    const result = await store.deleteDeviceSession(RECORD.absUserId, phone.id)

    expect(result).toEqual({ removed: true })
    expect(store.find('phone')).toBeUndefined()
    expect(store.find('tablet')).toBeDefined()
  })

  it('returns the chain to end upstream when it was the last device', async () => {
    const store = await open()
    const phone = await store.create('phone', RECORD)

    const result = await store.deleteDeviceSession(RECORD.absUserId, phone.id)

    expect(result).toEqual({ removed: true, endedChain: RECORD.chain })
    expect(store.listChains()).toHaveLength(0)
  })

  it('does not reveal or touch a device session of another user', async () => {
    const store = await open()
    const theirs = await store.create('theirs', { ...RECORD, absUserId: 'usr-2', absUsername: 'other' })
    await store.create('mine', RECORD)

    const result = await store.deleteDeviceSession(RECORD.absUserId, theirs.id)

    expect(result).toEqual({ removed: false })
    expect(store.find('theirs')).toBeDefined()
  })

  it('reports an unknown id as not removed', async () => {
    const store = await open()
    await store.create('mine', RECORD)

    expect(await store.deleteDeviceSession(RECORD.absUserId, 'no-such-id')).toEqual({ removed: false })
  })
})

describe('touch (last used)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-29T10:00:00.000Z'))
  })

  it('starts empty and is exact in memory after every touch', async () => {
    const store = await open()
    await store.create('phone', RECORD)
    expect(store.find('phone')?.lastUsedAt).toBeUndefined()

    store.touch('phone')
    expect(store.find('phone')?.lastUsedAt).toBe('2026-09-29T10:00:00.000Z')

    vi.setSystemTime(new Date('2026-09-29T10:05:00.000Z'))
    store.touch('phone')
    expect(store.find('phone')?.lastUsedAt).toBe('2026-09-29T10:05:00.000Z')
    await store.flushLastUsed() // settle the background write before the directory goes
  })

  it('ignores a token that names no device', async () => {
    const store = await open()
    expect(() => store.touch('nobody')).not.toThrow()
  })

  it('persists the first use, then only when the stored value is older than an hour', async () => {
    const store = await open()
    await store.create('phone', RECORD)

    store.touch('phone')
    await vi.waitFor(async () => {
      expect((await stored()).devices[0]?.['lastUsedAt']).toBe('2026-09-29T10:00:00.000Z')
    })

    // Within the hour: memory moves on, the file does not.
    vi.setSystemTime(new Date('2026-09-29T10:30:00.000Z'))
    store.touch('phone')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await stored()).devices[0]?.['lastUsedAt']).toBe('2026-09-29T10:00:00.000Z')
    expect(store.find('phone')?.lastUsedAt).toBe('2026-09-29T10:30:00.000Z')

    // Past the hour: written through, without waiting for shutdown.
    vi.setSystemTime(new Date(Date.parse('2026-09-29T10:00:00.000Z') + HOUR + 1000))
    store.touch('phone')
    await vi.waitFor(async () => {
      expect((await stored()).devices[0]?.['lastUsedAt']).toBe('2026-09-29T11:00:01.000Z')
    })
  })

  it('flushes a dirty in-memory value on shutdown', async () => {
    const store = await open()
    await store.create('phone', RECORD)
    store.touch('phone')
    await store.flushLastUsed()

    vi.setSystemTime(new Date('2026-09-29T10:20:00.000Z'))
    store.touch('phone')
    expect((await stored()).devices[0]?.['lastUsedAt']).toBe('2026-09-29T10:00:00.000Z')

    await store.flushLastUsed()
    expect((await stored()).devices[0]?.['lastUsedAt']).toBe('2026-09-29T10:20:00.000Z')
    // A restart sees the flushed value.
    expect((await open()).find('phone')?.lastUsedAt).toBe('2026-09-29T10:20:00.000Z')
  })

  it('warns instead of throwing when the flush cannot be written', async () => {
    const warnings: string[] = []
    const store = await open((m) => warnings.push(m))
    await store.create('phone', RECORD)
    store.touch('phone')
    await store.flushLastUsed()
    vi.setSystemTime(new Date('2026-09-29T10:20:00.000Z'))
    store.touch('phone')
    await rm(dir, { recursive: true, force: true })

    await expect(store.flushLastUsed()).resolves.toBeUndefined()
    expect(warnings.join('\n')).toMatch(/last used/i)
  })

  it('does not retry a failed write-through on every later request', async () => {
    const warnings: string[] = []
    const store = await open((m) => warnings.push(m))
    await store.create('phone', RECORD)
    store.touch('phone')
    await store.flushLastUsed()
    // Stale again, and the volume goes away: the write-through fails once ...
    vi.setSystemTime(new Date(Date.parse('2026-09-29T10:00:00.000Z') + 2 * HOUR))
    await rm(dir, { recursive: true, force: true })
    store.touch('phone')
    await vi.waitFor(() => expect(warnings).toHaveLength(1), { timeout: 2000 })

    // ... and the requests after it do not each start another write.
    store.touch('phone')
    store.touch('phone')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(warnings).toHaveLength(1)
    // Memory stays exact regardless of the failed write.
    expect(Date.parse(store.find('phone')?.lastUsedAt ?? '')).toBeGreaterThanOrEqual(Date.parse('2026-09-29T12:00:00.000Z'))
  })

  it('has nothing to flush for a device that signed out meanwhile', async () => {
    const store = await open()
    const { id } = await store.create('phone', RECORD)
    store.touch('phone')
    await store.flushLastUsed()
    vi.setSystemTime(new Date('2026-09-29T10:20:00.000Z'))
    store.touch('phone')
    await store.deleteDeviceSession(RECORD.absUserId, id)

    await expect(store.flushLastUsed()).resolves.toBeUndefined()
    expect((await stored()).devices).toHaveLength(0)
  })
})

describe('migration on load', () => {
  // A store written before this feature: device rows carry neither id, name nor lastUsedAt.
  async function writePreFeatureStore(): Promise<void> {
    const payload = {
      revision: 3,
      devices: [{ tokenHash: 'hash-1', absUserId: 'usr-1', createdAt: '2026-01-01T00:00:00.000Z' }],
      chains: [
        {
          absUserId: 'usr-1',
          absUsername: 'listener',
          chain: RECORD.chain,
          chainRefreshedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }
    await writeFile(path, encodeStoreFile(KEY, Buffer.from(JSON.stringify(payload))))
  }

  it('generates ids for existing rows, leaves name and last used empty, and keeps them signed in', async () => {
    await writePreFeatureStore()
    const store = await open()

    const [entry] = store.list()
    expect(entry?.id).toBeTruthy()
    expect(entry?.deviceName).toBeUndefined()
    expect(entry?.lastUsedAt).toBeUndefined()
    expect(entry?.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('persists the generated ids at once, so an id listed before a restart still works after it', async () => {
    await writePreFeatureStore()
    const first = await open()
    const id = first.list()[0]?.id

    const second = await open()
    expect(second.list()[0]?.id).toBe(id)
  })
})
