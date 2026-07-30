import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStoreWriteError } from '../src/auth/errors.js'
import { SessionStore } from '../src/auth/sessionStore.js'

// A controllable stand-in for the atomic write: it fails the next `failuresLeft` calls with the
// transient error the real code wraps IO faults in, then delegates to the real writer. This is what
// lets a test stage a disk hiccup that clears — the rm-the-directory trick used elsewhere cannot,
// because a missing directory breaks the pre-write revision read (a conflict), never the write.
const io = vi.hoisted(() => ({ failuresLeft: 0, calls: 0 }))

vi.mock('../src/auth/sessionFile.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/auth/sessionFile.js')>()
  return {
    ...real,
    writeFileAtomic: vi.fn(async (path: string, bytes: Buffer) => {
      io.calls++
      if (io.failuresLeft > 0) {
        io.failuresLeft--
        throw new SessionStoreWriteError(path, { cause: new Error('injected transient EIO') })
      }
      return real.writeFileAtomic(path, bytes)
    }),
  }
})

const KEY = Buffer.alloc(32, 0xa1)
const PHONE = {
  absUserId: 'usr-1',
  absUsername: 'listener',
  chain: { accessToken: 'abs-access-phone', refreshToken: 'abs-refresh-phone' },
}
// The pair Audiobookshelf rotates to on a successful refresh — the one that is lost if the write
// after it is not retried.
const ROTATED = { accessToken: 'abs-access-2', refreshToken: 'abs-refresh-2' }

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rtk-sessions-retry-'))
  path = join(dir, 'sessions.enc')
  io.failuresLeft = 0
  io.calls = 0
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function open(): Promise<SessionStore> {
  return SessionStore.open({ path, key: KEY })
}

describe('SessionStore write retry', () => {
  it('rides out a transient write failure and still persists the rotated pair, so one disk blip does not doom the chain', async () => {
    const store = await open()
    await store.create('token-phone', PHONE)

    // The store is up and the chain rotated; the next two writes hiccup, the third lands.
    io.calls = 0
    io.failuresLeft = 2

    expect(await store.updateChain(store.find('token-phone')!, ROTATED)).toBe(true)
    expect(io.calls).toBe(3) // two failures ridden out, one success
    expect(store.find('token-phone')!.chain).toEqual(ROTATED)

    // It reached disk, not just memory: a fresh open reads the rotated pair back.
    expect((await open()).find('token-phone')!.chain).toEqual(ROTATED)
  })

  it('gives up after the bounded number of attempts and rolls memory back, so a sustained outage still fails loudly', async () => {
    const store = await open()
    await store.create('token-phone', PHONE)

    io.calls = 0
    io.failuresLeft = Number.MAX_SAFE_INTEGER // never recovers

    await expect(store.updateChain(store.find('token-phone')!, ROTATED)).rejects.toBeInstanceOf(SessionStoreWriteError)
    expect(io.calls).toBe(3) // bounded, not an unbounded spin
    // Rolled back to the pair that is actually on disk — memory never claims an unpersisted session.
    expect(store.find('token-phone')!.chain).toEqual(PHONE.chain)
    expect((await open()).find('token-phone')!.chain).toEqual(PHONE.chain)
  })
})
