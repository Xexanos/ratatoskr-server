import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { AbsAuthError, AbsUpstreamError } from '../src/abs/errors.js'
import { UpstreamSessionLostError } from '../src/auth/errors.js'
import { CHAIN_SPACING_MS, ChainKeepAlive } from '../src/auth/keepAlive.js'
import type { SessionEntry, SessionStore } from '../src/auth/sessionStore.js'
import { tempSessionStore } from './helpers/tempSessionStore.js'

// The keep-alive loop (SPEC section 8 / ADR-0001): what makes a stored chain outlive any pause, and
// what happens on the one path where it dies anyway. The store is the real one on a temp file — the
// loop's whole job is to leave the right thing persisted, which a fake store would have to
// re-implement to be worth anything.
//
// Timers: the pacing and boot tests run on the real clock with a spacing measured in milliseconds,
// because the store writes between two refreshes are real file I/O that no timer advance can
// deterministically flush. Only the daily-schedule tests fake timers, and those sweep a single
// chain, so nothing races. The boot tests fake `Date` alone — they need chains stamped days ago
// while the spacing timer keeps ticking for real.

const LISTENER = { absUserId: 'usr-1', absUsername: 'listener' }
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
// Small enough that a paced sweep costs a test nothing, large enough that the gap between two
// refreshes is measurable rather than lost in scheduling noise.
const TEST_SPACING_MS = 20
const OPTIONS = { chainSpacingMs: TEST_SPACING_MS, refreshIntervalMs: DAY_MS, refreshJitterMs: HOUR_MS }

// An access token shaped like the JWT Audiobookshelf issues, expiring `inSeconds` from now. Only
// the `exp` claim is read (unverified), so nothing else has to be real.
let minted = 0
function accessToken(inSeconds: number): string {
  minted += 1
  const exp = Math.floor(Date.now() / 1000) + inSeconds
  // `jti` only makes each minted token distinguishable from the last: two issued in the same second
  // with the same lifetime would otherwise be the identical string, and "the stored access token
  // changed" would assert nothing.
  const payload = Buffer.from(JSON.stringify({ exp, jti: minted })).toString('base64url')
  return `header.${payload}.signature`
}

function chainOf(name: string, expiresInSeconds = 12 * 60 * 60): { accessToken: string; refreshToken: string } {
  return { accessToken: accessToken(expiresInSeconds), refreshToken: `refresh-${name}` }
}

// A client that hands back a fresh pair per refresh, so "the rotated pair was stored" is checkable,
// and records when each call arrived, so the pacing between them is too.
function fakeAbs(overrides: Partial<AbsClient> = {}): AbsClient & { refreshedAt: number[] } {
  let generation = 0
  const refreshedAt: number[] = []
  return {
    refreshedAt,
    refresh: vi.fn(async (refreshToken: string) => {
      refreshedAt.push(performance.now())
      generation += 1
      return {
        accessToken: accessToken(12 * 60 * 60),
        refreshToken: `${refreshToken}-${generation}`,
        user: { id: LISTENER.absUserId, username: LISTENER.absUsername },
      }
    }),
    ...overrides,
  } as unknown as AbsClient & { refreshedAt: number[] }
}

function rejectingAbs(error: Error): AbsClient & { refreshedAt: number[] } {
  return fakeAbs({
    refresh: vi.fn(async () => {
      throw error
    }) as unknown as AbsClient['refresh'],
  })
}

let store: SessionStore

beforeEach(async () => {
  store = await tempSessionStore()
})

afterEach(() => {
  vi.useRealTimers()
})

function build(abs: AbsClient = fakeAbs(), options: Record<string, unknown> = {}, target: SessionStore = store): ChainKeepAlive {
  return new ChainKeepAlive(abs, target, { ...OPTIONS, ...options })
}

// A store that answers from memory. Only the schedule tests use it, and they have to: they run on
// faked timers, and a faked clock never turns the event loop the real store's file writes complete
// on — the write would still be pending when the next sweep is due.
function memoryStore(entries: SessionEntry[]): SessionStore {
  return {
    list: () => entries,
    updateChain: async () => true,
    markDead: async () => true,
  } as unknown as SessionStore
}

function entryOf(name: string): SessionEntry {
  const now = new Date().toISOString()
  return { ...LISTENER, tokenHash: `hash-${name}`, createdAt: now, chainRefreshedAt: now, chain: chainOf(name) }
}

describe('ChainKeepAlive.sweep', () => {
  it('refreshes every stored chain and records the pair it got back', async () => {
    const abs = fakeAbs()
    const phone = await store.create('token-phone', { ...LISTENER, chain: chainOf('phone') })

    await build(abs).sweep()

    expect(abs.refresh).toHaveBeenCalledWith('refresh-phone')
    expect(store.find('token-phone')?.chain.refreshToken).toBe('refresh-phone-1')
    expect(store.find('token-phone')?.chain.accessToken).not.toBe(phone.chain.accessToken)
  })

  // ADR-0001's amendment: below Audiobookshelf 2.35.1, two refreshes of the same user inside one
  // second come back with the identical refresh token, so refreshing the whole store at once would
  // collide the chains it is supposed to be keeping alive.
  it('spaces its refreshes instead of hitting ABS with the whole store at once', async () => {
    const abs = fakeAbs()
    await store.create('token-phone', { ...LISTENER, chain: chainOf('phone') })
    await store.create('token-tablet', { ...LISTENER, chain: chainOf('tablet') })

    await build(abs).sweep()

    expect(abs.refresh).toHaveBeenCalledTimes(2)
    expect(abs.refreshedAt[1]! - abs.refreshedAt[0]!).toBeGreaterThanOrEqual(TEST_SPACING_MS)
  })

  // The gap the shipped default has to clear, kept as its own assertion because the collision it
  // avoids is a property of Audiobookshelf's second-precision timestamps, not of this code.
  it('ships a gap wider than the second ABS below 2.35.1 rounds to', () => {
    expect(CHAIN_SPACING_MS).toBeGreaterThan(1000)
  })

  // The rare-and-loud failure (SPEC section 8): ABS refused the refresh token, so the chain is gone
  // for good — but the device's token is not, and keeping the entry is what lets its next request
  // say so.
  it('marks a chain dead, keeping the entry, when ABS refuses the refresh token', async () => {
    await store.create('token-phone', { ...LISTENER, chain: chainOf('phone') })

    await build(rejectingAbs(new AbsAuthError())).sweep()

    expect(store.find('token-phone')).toBeDefined()
    expect(store.find('token-phone')?.deadSince).toEqual(expect.any(String))
  })

  // The whole point of the refresh window: an unreachable ABS is a transient outage, not a death
  // sentence. Declaring the chain dead here would sign a device out over a rebooting container.
  it('leaves a chain alone when ABS is merely unreachable', async () => {
    const phone = await store.create('token-phone', { ...LISTENER, chain: chainOf('phone') })

    await expect(build(rejectingAbs(new AbsUpstreamError('no answer'))).sweep()).resolves.toBeUndefined()

    expect(store.find('token-phone')?.deadSince).toBeUndefined()
    expect(store.find('token-phone')?.chain).toEqual(phone.chain)
  })

  it('keeps sweeping the rest after one chain fails', async () => {
    let calls = 0
    const abs = fakeAbs({
      refresh: vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new AbsUpstreamError('no answer')
        return { accessToken: accessToken(3600), refreshToken: 'rotated', user: LISTENER }
      }) as unknown as AbsClient['refresh'],
    })
    await store.create('token-phone', { ...LISTENER, chain: chainOf('phone') })
    await store.create('token-tablet', { ...LISTENER, chain: chainOf('tablet') })

    await build(abs).sweep()

    expect(store.find('token-tablet')?.chain.refreshToken).toBe('rotated')
  })

  // Death is terminal (SPEC section 8: no in-place repair). Refreshing a dead chain could only
  // fail, and succeeding would be worse — it would quietly revive a session whose device has
  // already been told to re-authenticate.
  it('skips chains it has already marked dead', async () => {
    const abs = fakeAbs()
    const phone = await store.create('token-phone', { ...LISTENER, chain: chainOf('phone') })
    await store.markDead(phone)

    await build(abs).sweep()

    expect(abs.refresh).not.toHaveBeenCalled()
  })
})

describe('ChainKeepAlive.start', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('sweeps once a day, jittered so the fleet does not land on ABS together', async () => {
    const abs = fakeAbs()
    // Halfway through the jitter window: the sweep is due at a day and half an hour, not at a day.
    const keepAlive = build(abs, { random: () => 0.5 }, memoryStore([entryOf('phone')]))
    keepAlive.start()

    await vi.advanceTimersByTimeAsync(DAY_MS)
    expect(abs.refresh).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(HOUR_MS / 2)
    expect(abs.refresh).toHaveBeenCalledTimes(1)

    keepAlive.stop()
  })

  it('keeps sweeping day after day', async () => {
    const abs = fakeAbs()
    const keepAlive = build(abs, { random: () => 0 }, memoryStore([entryOf('phone')]))
    keepAlive.start()

    await vi.advanceTimersByTimeAsync(DAY_MS)
    await vi.advanceTimersByTimeAsync(DAY_MS)

    expect(abs.refresh).toHaveBeenCalledTimes(2)
    keepAlive.stop()
  })

  it('stops sweeping once it is stopped, so a closed app leaves no loop behind', async () => {
    const abs = fakeAbs()
    const keepAlive = build(abs, { random: () => 0 }, memoryStore([entryOf('phone')]))
    keepAlive.start()
    await vi.advanceTimersByTimeAsync(DAY_MS)

    keepAlive.stop()
    await vi.advanceTimersByTimeAsync(3 * DAY_MS)

    expect(abs.refresh).toHaveBeenCalledTimes(1)
  })

  it('arms the loop once, however often it is started', async () => {
    const abs = fakeAbs()
    const keepAlive = build(abs, { random: () => 0 }, memoryStore([entryOf('phone')]))
    keepAlive.start()
    keepAlive.start()

    await vi.advanceTimersByTimeAsync(DAY_MS)

    expect(abs.refresh).toHaveBeenCalledTimes(1)
    keepAlive.stop()
  })
})

describe('ChainKeepAlive refresh-on-boot', () => {
  // Only the clock is faked here: the chains have to look days old, while the spacing between two
  // refreshes stays a real timer (see the note at the top).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  // The server was down through a scheduled sweep, so the chains that missed it are the ones
  // closest to Audiobookshelf's refresh-window edge (SPEC section 8).
  it('renews the chains that went stale while the server was down, and only those', async () => {
    const abs = fakeAbs()
    const fresh = await store.create('token-fresh', { ...LISTENER, chain: chainOf('fresh') })
    await store.create('token-stale', { ...LISTENER, chain: chainOf('stale') })
    // Two days on, one device's chain was renewed just before the stop and the other's was not.
    vi.setSystemTime(Date.now() + 2 * DAY_MS)
    await store.updateChain(fresh, { ...fresh.chain })

    const keepAlive = build(abs)
    keepAlive.start()
    await vi.waitFor(() => expect(abs.refresh).toHaveBeenCalledTimes(1))

    expect(abs.refresh).toHaveBeenCalledWith('refresh-stale')
    keepAlive.stop()
  })

  // "Nearest the edge first": with several stale chains and an ABS that may go away mid-sweep, the
  // order is what decides which of them survive a sweep that only gets halfway.
  it('renews the stalest chain first', async () => {
    const abs = fakeAbs()
    await store.create('token-older', { ...LISTENER, chain: chainOf('older') })
    vi.setSystemTime(Date.now() + HOUR_MS)
    await store.create('token-newer', { ...LISTENER, chain: chainOf('newer') })
    vi.setSystemTime(Date.now() + 3 * DAY_MS)

    const keepAlive = build(abs)
    keepAlive.start()
    await vi.waitFor(() => expect(abs.refresh).toHaveBeenCalledTimes(2))

    expect(abs.refresh).toHaveBeenNthCalledWith(1, 'refresh-older')
    keepAlive.stop()
  })

  it('never lets a boot refresh failure escape into startup', async () => {
    const abs = rejectingAbs(new AbsUpstreamError('no answer'))
    await store.create('token-stale', { ...LISTENER, chain: chainOf('stale') })
    vi.setSystemTime(Date.now() + 2 * DAY_MS)

    const keepAlive = build(abs)
    expect(() => keepAlive.start()).not.toThrow()
    await vi.waitFor(() => expect(abs.refresh).toHaveBeenCalledTimes(1))

    // The outage left the chain exactly as it was, for the next boot or sweep to retry.
    expect(store.find('token-stale')?.deadSince).toBeUndefined()
    keepAlive.stop()
  })
})

describe('ChainKeepAlive.usableChain', () => {
  it('hands back the stored chain while its access token still has life in it', async () => {
    const abs = fakeAbs()
    const entry = await store.create('token-phone', { ...LISTENER, chain: chainOf('phone', 6 * 60 * 60) })

    await expect(build(abs).usableChain(entry)).resolves.toEqual(entry.chain)
    expect(abs.refresh).not.toHaveBeenCalled()
  })

  // On-demand refresh (SPEC section 8): the daily sweep keeps the chain alive, but the access token
  // it leaves behind expires long before the next sweep — so the request path renews it itself.
  it('renews an access token that has run out mid-use, and returns the new one', async () => {
    const abs = fakeAbs()
    const entry = await store.create('token-phone', { ...LISTENER, chain: chainOf('phone', -60) })

    const chain = await build(abs).usableChain(entry)

    expect(abs.refresh).toHaveBeenCalledWith('refresh-phone')
    expect(chain.refreshToken).toBe('refresh-phone-1')
    expect(store.find('token-phone')?.chain).toEqual(chain)
  })

  it('renews just before expiry rather than waiting for the first failure', async () => {
    const abs = fakeAbs()
    const entry = await store.create('token-phone', { ...LISTENER, chain: chainOf('phone', 30) })

    await build(abs, { accessTokenMarginSeconds: 60 }).usableChain(entry)

    expect(abs.refresh).toHaveBeenCalledTimes(1)
  })

  // Older Audiobookshelf hands out tokens this cannot read a clock off. There is nothing to renew
  // ahead of, so the chain is used as it is and an expiry surfaces the way it did before this loop.
  it('leaves a token it cannot date alone', async () => {
    const abs = fakeAbs()
    const entry = await store.create('token-phone', {
      ...LISTENER,
      chain: { accessToken: 'not-a-jwt', refreshToken: 'refresh-phone' },
    })

    await expect(build(abs).usableChain(entry)).resolves.toEqual(entry.chain)
    expect(abs.refresh).not.toHaveBeenCalled()
  })

  it('refuses a dead chain with the error that asks for a password', async () => {
    const entry = await store.create('token-phone', { ...LISTENER, chain: chainOf('phone') })
    await store.markDead(entry)

    await expect(build().usableChain(store.find('token-phone')!)).rejects.toBeInstanceOf(UpstreamSessionLostError)
  })

  it('refuses the chain the on-demand refresh just proved dead', async () => {
    const entry = await store.create('token-phone', { ...LISTENER, chain: chainOf('phone', -60) })

    await expect(build(rejectingAbs(new AbsAuthError())).usableChain(entry)).rejects.toBeInstanceOf(
      UpstreamSessionLostError,
    )
    expect(store.find('token-phone')?.deadSince).toEqual(expect.any(String))
  })

  // An outage is not a lost session: the caller gets the upstream error (502), and the chain is
  // still there to renew once ABS is back.
  it('reports an unreachable ABS as an outage, not as a lost session', async () => {
    const entry = await store.create('token-phone', { ...LISTENER, chain: chainOf('phone', -60) })

    await expect(build(rejectingAbs(new AbsUpstreamError('no answer'))).usableChain(entry)).rejects.toBeInstanceOf(
      AbsUpstreamError,
    )
    expect(store.find('token-phone')?.deadSince).toBeUndefined()
  })

  // Audiobookshelf rotates the refresh token on use, so spending one twice is how a live chain gets
  // killed by its own keep-alive. Concurrent requests for one device must share a single refresh.
  it('spends one refresh token even when several requests need the chain at once', async () => {
    const abs = fakeAbs()
    const entry = await store.create('token-phone', { ...LISTENER, chain: chainOf('phone', -60) })
    const keepAlive = build(abs)

    const chains = await Promise.all([
      keepAlive.usableChain(entry),
      keepAlive.usableChain(entry),
      keepAlive.usableChain(entry),
    ])

    expect(abs.refresh).toHaveBeenCalledTimes(1)
    expect(chains[1]).toEqual(chains[0])
    expect(chains[2]).toEqual(chains[0])
  })

  it('lets the next request refresh again once the shared one has settled', async () => {
    const abs = fakeAbs()
    const entry = await store.create('token-phone', { ...LISTENER, chain: chainOf('phone', -60) })
    const keepAlive = build(abs)

    await keepAlive.usableChain(entry)
    await keepAlive.usableChain(entry)

    expect(abs.refresh).toHaveBeenCalledTimes(2)
  })
})
