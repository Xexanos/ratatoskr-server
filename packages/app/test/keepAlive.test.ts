import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { AbsAuthError, AbsUpstreamError } from '../src/abs/errors.js'
import { UnknownTokenError, UpstreamSessionLostError } from '../src/auth/errors.js'
import { ChainKeepAlive } from '../src/auth/keepAlive.js'
import type { SessionStore, UserChain } from '../src/auth/sessionStore.js'
import { tempSessionStore } from './helpers/tempSessionStore.js'

// The keep-alive loop (SPEC section 8 / ADR-0001, ADR-0004): what makes a stored chain outlive any
// pause, and what happens on the one path where it dies anyway. The store is the real one on a temp
// file - the loop's whole job is to leave the right thing persisted, which a fake store would have
// to re-implement to be worth anything.
//
// The unit the loop renews is the per-user chain (ADR-0004): one refresh serves every device of a
// user. So tests that want two chains to sweep use two ABS users; two devices of one user share a
// single chain, and the loop refreshes it once.
//
// Timers: the boot tests run on the real clock (the store writes between refreshes are real file I/O
// no timer advance can deterministically flush) with the system clock faked, so chains can look days
// old. Only the daily-schedule tests fake timers wholesale.

const USER1 = { absUserId: 'usr-1', absUsername: 'listener' }
const USER2 = { absUserId: 'usr-2', absUsername: 'reader' }
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const OPTIONS = { refreshIntervalMs: DAY_MS }

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
// and records when each call arrived.
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
        user: USER1,
      }
    }),
    ...overrides,
  } as unknown as AbsClient & { refreshedAt: number[] }
}

// A client whose *first* refresh parks until released, so a sweep can be pinned mid-walk with one
// chain refreshed and the next not yet reached - the window the old inter-refresh gap used to open,
// now opened deliberately for the two tests that need it.
function gatedAbs(): AbsClient & { refreshedAt: number[]; releaseFirst: () => void } {
  let generation = 0
  const refreshedAt: number[] = []
  let releaseFirst = (): void => {}
  let firstGate: Promise<void> | null = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  return {
    refreshedAt,
    releaseFirst: () => releaseFirst(),
    refresh: vi.fn(async (refreshToken: string) => {
      if (firstGate !== null) {
        const gate = firstGate
        firstGate = null
        await gate
      }
      refreshedAt.push(performance.now())
      generation += 1
      return { accessToken: accessToken(12 * 60 * 60), refreshToken: `${refreshToken}-${generation}`, user: USER1 }
    }) as unknown as AbsClient['refresh'],
  } as unknown as AbsClient & { refreshedAt: number[]; releaseFirst: () => void }
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
// on - the write would still be pending when the next sweep is due.
function memoryStore(chains: UserChain[]): SessionStore {
  return {
    listChains: () => chains,
    currentChain: (absUserId: string) => chains.find((chain) => chain.absUserId === absUserId),
    updateChain: async () => true,
    markDead: async () => true,
  } as unknown as SessionStore
}

function chainFixture(user: { absUserId: string; absUsername: string }, name: string): UserChain {
  return { ...user, chain: chainOf(name), chainRefreshedAt: new Date().toISOString() }
}

describe('ChainKeepAlive.sweep', () => {
  it('refreshes every stored chain and records the pair it got back', async () => {
    const abs = fakeAbs()
    const phone = await store.create('token-phone', { ...USER1, chain: chainOf('phone') })

    await build(abs).sweep()

    expect(abs.refresh).toHaveBeenCalledWith('refresh-phone')
    expect(store.find('token-phone')?.chain.refreshToken).toBe('refresh-phone-1')
    expect(store.find('token-phone')?.chain.accessToken).not.toBe(phone.chain.accessToken)
  })

  // ADR-0004: one chain per user, so however many devices a user has, the sweep refreshes their
  // chain exactly once - no two refreshes of one user, the collision the old spacing gap guarded.
  it('refreshes a user’s shared chain once, however many devices ride it', async () => {
    const abs = fakeAbs()
    await store.create('token-phone', { ...USER1, chain: chainOf('phone') })
    await store.create('token-tablet', { ...USER1, chain: chainOf('tablet') })

    await build(abs).sweep()

    expect(abs.refresh).toHaveBeenCalledTimes(1)
    expect(store.find('token-phone')?.chain).toEqual(store.find('token-tablet')?.chain)
  })

  it('abandons a sweep in progress when it is stopped, so shutdown is not held up', async () => {
    const abs = fakeAbs()
    await store.create('token-phone', { ...USER1, chain: chainOf('phone') })
    await store.create('token-reader', { ...USER2, chain: chainOf('reader') })
    const keepAlive = build(abs)

    const sweep = keepAlive.sweep()
    keepAlive.stop()
    await sweep

    // The one already in flight finishes - abandoning it mid-rotation would leave the store naming
    // a token ABS has replaced - but the sweep goes no further.
    expect(abs.refresh).toHaveBeenCalledTimes(1)
  })

  // stop() halts the schedule, but the refresh already in flight has to land its store write before
  // the process exits: main.ts calls process.exit the instant app.close() settles, so a SIGTERM
  // between abs.refresh (token already rotated upstream) and the write would lose it, and the next
  // boot - seeing the spent token - would mark a live chain dead. drained() is what onClose awaits.
  it('drains the write already in flight before drained() resolves', async () => {
    const abs = fakeAbs()
    await store.create('token-phone', { ...USER1, chain: chainOf('phone') })
    const keepAlive = build(abs)

    // Hold the store write open, so stop() lands while a rotation sits between ABS and disk.
    let releaseWrite = (): void => {}
    const writing = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const realUpdate = store.updateChain.bind(store)
    const writeStarted = new Promise<void>((resolve) => {
      vi.spyOn(store, 'updateChain').mockImplementation(async (ref, chain) => {
        resolve()
        await writing
        return realUpdate(ref, chain)
      })
    })

    const sweep = keepAlive.sweep()
    await writeStarted // abs.refresh has resolved; the rotated pair is not yet on disk

    keepAlive.stop()
    const drained = keepAlive.drained()
    let drainedSettled = false
    void drained.then(() => {
      drainedSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20)) // give a premature resolve a chance
    expect(drainedSettled, 'drained() resolved before the in-flight write finished').toBe(false)

    releaseWrite()
    await drained
    await sweep

    expect(drainedSettled).toBe(true)
    // The rotated pair actually landed - not the pre-rotation token the next boot would reject.
    expect(store.find('token-phone')?.chain.refreshToken).toBe('refresh-phone-1')
  })

  // The rare-and-loud failure (SPEC section 8): ABS refused the refresh token, so the chain is gone
  // for good - but the devices' tokens are not, and keeping the entries is what lets their next
  // request say so.
  it('marks a chain dead, keeping its devices, when ABS refuses the refresh token', async () => {
    await store.create('token-phone', { ...USER1, chain: chainOf('phone') })

    await build(rejectingAbs(new AbsAuthError())).sweep()

    expect(store.find('token-phone')).toBeDefined()
    expect(store.find('token-phone')?.deadSince).toEqual(expect.any(String))
  })

  // The whole point of the refresh window: an unreachable ABS is a transient outage, not a death
  // sentence. Declaring the chain dead here would sign a device out over a rebooting container.
  it('leaves a chain alone when ABS is merely unreachable', async () => {
    const phone = await store.create('token-phone', { ...USER1, chain: chainOf('phone') })

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
        return { accessToken: accessToken(3600), refreshToken: 'rotated', user: USER1 }
      }) as unknown as AbsClient['refresh'],
    })
    await store.create('token-phone', { ...USER1, chain: chainOf('phone') })
    await store.create('token-reader', { ...USER2, chain: chainOf('reader') })

    await build(abs).sweep()

    expect(store.find('token-reader')?.chain.refreshToken).toBe('rotated')
  })

  // The chains a sweep walks are frozen snapshots, and it can reach a later one long after listing
  // it. If the request path renewed one in between, presenting the token ABS has since rotated away
  // earns a 401 - and this loop would mark a live chain dead over its own bookkeeping. So the chain
  // is re-read at the moment it is spent. The gated client pins the sweep on the first chain while
  // the second is renewed elsewhere.
  it('re-reads a chain before spending it, so a renewal it did not make cannot kill it', async () => {
    const abs = gatedAbs()
    const phone = await store.create('token-phone', { ...USER1, chain: chainOf('phone') })
    await store.create('token-reader', { ...USER2, chain: chainOf('reader') })
    const keepAlive = build(abs)

    const sweep = keepAlive.sweep()
    // The sweep is parked on the phone's refresh; renew the reader's chain out from under it.
    await store.updateChain({ absUserId: USER2.absUserId }, { accessToken: 'a', refreshToken: 'refresh-reader-elsewhere' })
    abs.releaseFirst()
    await sweep

    expect(abs.refresh).toHaveBeenCalledWith('refresh-reader-elsewhere')
    expect(abs.refresh).not.toHaveBeenCalledWith('refresh-reader')
    expect(store.find('token-reader')?.deadSince).toBeUndefined()
    expect(phone).toBeDefined()
  })

  it('skips a chain whose last device signed out after the sweep listed it', async () => {
    const abs = gatedAbs()
    await store.create('token-phone', { ...USER1, chain: chainOf('phone') })
    await store.create('token-reader', { ...USER2, chain: chainOf('reader') })
    const keepAlive = build(abs)

    const sweep = keepAlive.sweep()
    // Parked on the phone's refresh; the reader signs out before the sweep reaches its chain.
    await store.delete('token-reader')
    abs.releaseFirst()
    await sweep

    expect(abs.refresh).not.toHaveBeenCalledWith('refresh-reader')
  })

  // Death is terminal (SPEC section 8: no in-place repair). Refreshing a dead chain could only
  // fail, and succeeding would be worse - it would quietly revive a session whose devices have
  // already been told to re-authenticate.
  it('skips chains it has already marked dead', async () => {
    const abs = fakeAbs()
    const phone = await store.create('token-phone', { ...USER1, chain: chainOf('phone') })
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
    const keepAlive = build(abs, { random: () => 0.5 }, memoryStore([chainFixture(USER1, 'phone')]))
    keepAlive.start()

    await vi.advanceTimersByTimeAsync(DAY_MS)
    expect(abs.refresh).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(HOUR_MS / 2)
    expect(abs.refresh).toHaveBeenCalledTimes(1)

    keepAlive.stop()
  })

  // The jitter is a fraction of the interval, not a constant beside it. A deployment that shortens
  // the interval to provoke the dead-chain path (KEEP_ALIVE_REFRESH_INTERVAL_MS) would otherwise
  // wait out an hour of spread on top of its five seconds.
  it('scales the jitter to the interval, so a shortened one is not swamped by it', async () => {
    const abs = fakeAbs()
    const keepAlive = build(abs, { refreshIntervalMs: 5000, random: () => 1 }, memoryStore([chainFixture(USER1, 'phone')]))
    keepAlive.start()

    // A twenty-fourth of five seconds is about 208 ms, so the whole window is inside this step.
    await vi.advanceTimersByTimeAsync(6000)

    expect(abs.refresh).toHaveBeenCalledTimes(1)
    keepAlive.stop()
  })

  // At a shortened interval a sweep can still be walking when the next is due - the normal case for
  // the test deployments the knob exists for. Starting a second walk beside the first would queue
  // every chain twice over. A refresh that takes a beat (here a faked delay) is what keeps the first
  // sweep walking across the next due time.
  it('skips a scheduled sweep while the previous one is still walking', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() }
    const abs = fakeAbs({
      refresh: vi.fn(async (refreshToken: string) => {
        await new Promise((resolve) => setTimeout(resolve, 400))
        return { accessToken: accessToken(3600), refreshToken: `${refreshToken}-x`, user: USER1 }
      }) as unknown as AbsClient['refresh'],
    })
    const store = memoryStore([chainFixture(USER1, 'phone'), chainFixture(USER2, 'reader'), chainFixture({ absUserId: 'usr-3', absUsername: 'third' }, 'watch')])
    // Interval 1000; three refreshes of ~400 ms each keep the sweep that starts at 1000 walking past
    // the next due time at 2000.
    const keepAlive = build(abs, { refreshIntervalMs: 1000, random: () => 0, logger }, store)
    keepAlive.start()

    await vi.advanceTimersByTimeAsync(2950)

    // One walk's worth of chains, and the skip said so - a second walk beside the first would have
    // queued all three again, and the pile-up would grow with every interval.
    expect(abs.refresh).toHaveBeenCalledTimes(3)
    expect(logger.info).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('skipping'))
    keepAlive.stop()
  })

  it('keeps sweeping day after day', async () => {
    const abs = fakeAbs()
    const keepAlive = build(abs, { random: () => 0 }, memoryStore([chainFixture(USER1, 'phone')]))
    keepAlive.start()

    await vi.advanceTimersByTimeAsync(DAY_MS)
    await vi.advanceTimersByTimeAsync(DAY_MS)

    expect(abs.refresh).toHaveBeenCalledTimes(2)
    keepAlive.stop()
  })

  it('stops sweeping once it is stopped, so a closed app leaves no loop behind', async () => {
    const abs = fakeAbs()
    const keepAlive = build(abs, { random: () => 0 }, memoryStore([chainFixture(USER1, 'phone')]))
    keepAlive.start()
    await vi.advanceTimersByTimeAsync(DAY_MS)

    keepAlive.stop()
    await vi.advanceTimersByTimeAsync(3 * DAY_MS)

    expect(abs.refresh).toHaveBeenCalledTimes(1)
  })

  it('arms the loop once, however often it is started', async () => {
    const abs = fakeAbs()
    const keepAlive = build(abs, { random: () => 0 }, memoryStore([chainFixture(USER1, 'phone')]))
    keepAlive.start()
    keepAlive.start()

    await vi.advanceTimersByTimeAsync(DAY_MS)

    expect(abs.refresh).toHaveBeenCalledTimes(1)
    keepAlive.stop()
  })
})

describe('ChainKeepAlive refresh-on-boot', () => {
  // Only the clock is faked here: the chains have to look days old, while the refreshes stay real
  // timers (see the note at the top).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  // The server was down through a scheduled sweep, so the chains that missed it are the ones
  // closest to Audiobookshelf's refresh-window edge (SPEC section 8).
  it('renews the chains that went stale while the server was down, and only those', async () => {
    const abs = fakeAbs()
    const fresh = await store.create('token-fresh', { ...USER1, chain: chainOf('fresh') })
    await store.create('token-stale', { ...USER2, chain: chainOf('stale') })
    // Two days on, one user's chain was renewed just before the stop and the other's was not.
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
    await store.create('token-older', { ...USER1, chain: chainOf('older') })
    vi.setSystemTime(Date.now() + HOUR_MS)
    await store.create('token-newer', { ...USER2, chain: chainOf('newer') })
    vi.setSystemTime(Date.now() + 3 * DAY_MS)

    const keepAlive = build(abs)
    keepAlive.start()
    await vi.waitFor(() => expect(abs.refresh).toHaveBeenCalledTimes(2))

    expect(abs.refresh).toHaveBeenNthCalledWith(1, 'refresh-older')
    keepAlive.stop()
  })

  it('never lets a boot refresh failure escape into startup', async () => {
    const abs = rejectingAbs(new AbsUpstreamError('no answer'))
    await store.create('token-stale', { ...USER1, chain: chainOf('stale') })
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
    const entry = await store.create('token-phone', { ...USER1, chain: chainOf('phone', 6 * 60 * 60) })

    await expect(build(abs).usableChain(entry)).resolves.toEqual(entry.chain)
    expect(abs.refresh).not.toHaveBeenCalled()
  })

  // On-demand refresh (SPEC section 8): the daily sweep keeps the chain alive, but the access token
  // it leaves behind expires long before the next sweep - so the request path renews it itself.
  it('renews an access token that has run out mid-use, and returns the new one', async () => {
    const abs = fakeAbs()
    const entry = await store.create('token-phone', { ...USER1, chain: chainOf('phone', -60) })

    const chain = await build(abs).usableChain(entry)

    expect(abs.refresh).toHaveBeenCalledWith('refresh-phone')
    expect(chain.refreshToken).toBe('refresh-phone-1')
    expect(store.find('token-phone')?.chain).toEqual(chain)
  })

  it('renews just before expiry rather than waiting for the first failure', async () => {
    const abs = fakeAbs()
    const entry = await store.create('token-phone', { ...USER1, chain: chainOf('phone', 30) })

    await build(abs, { accessTokenMarginSeconds: 60 }).usableChain(entry)

    expect(abs.refresh).toHaveBeenCalledTimes(1)
  })

  // Older Audiobookshelf hands out tokens this cannot read a clock off. There is nothing to renew
  // ahead of, so the chain is used as it is and an expiry surfaces the way it did before this loop.
  it('leaves a token it cannot date alone', async () => {
    const abs = fakeAbs()
    const entry = await store.create('token-phone', {
      ...USER1,
      chain: { accessToken: 'not-a-jwt', refreshToken: 'refresh-phone' },
    })

    await expect(build(abs).usableChain(entry)).resolves.toEqual(entry.chain)
    expect(abs.refresh).not.toHaveBeenCalled()
  })

  it('refuses a dead chain with the error that asks for a password', async () => {
    const entry = await store.create('token-phone', { ...USER1, chain: chainOf('phone') })
    await store.markDead(entry)

    await expect(build().usableChain(store.find('token-phone')!)).rejects.toBeInstanceOf(UpstreamSessionLostError)
  })

  it('refuses the chain the on-demand refresh just proved dead', async () => {
    const entry = await store.create('token-phone', { ...USER1, chain: chainOf('phone', -60) })

    await expect(build(rejectingAbs(new AbsAuthError())).usableChain(entry)).rejects.toBeInstanceOf(
      UpstreamSessionLostError,
    )
    expect(store.find('token-phone')?.deadSince).toEqual(expect.any(String))
  })

  // Signing out mid-request is not a lost upstream session, it is a token that no longer exists -
  // and answering "your password, please" would send a device that just signed out to a prompt
  // instead of the sign-in screen.
  it('reports a device that signed out mid-request as an unknown token', async () => {
    const abs = fakeAbs()
    const entry = await store.create('token-phone', { ...USER1, chain: chainOf('phone', -60) })
    // The entry a guard resolved is a snapshot; the device can sign out before the renewal it
    // triggered gets to spend anything - and as the user's last device, that takes the chain too.
    await store.delete('token-phone')

    await expect(build(abs).usableChain(entry)).rejects.toBeInstanceOf(UnknownTokenError)
    expect(abs.refresh).not.toHaveBeenCalled()
  })

  // An outage is not a lost session: the caller gets the upstream error (502), and the chain is
  // still there to renew once ABS is back.
  it('reports an unreachable ABS as an outage, not as a lost session', async () => {
    const entry = await store.create('token-phone', { ...USER1, chain: chainOf('phone', -60) })

    await expect(build(rejectingAbs(new AbsUpstreamError('no answer'))).usableChain(entry)).rejects.toBeInstanceOf(
      AbsUpstreamError,
    )
    expect(store.find('token-phone')?.deadSince).toBeUndefined()
  })

  // Audiobookshelf rotates the refresh token on use, so spending one twice is how a live chain gets
  // killed by its own keep-alive. Concurrent requests for one chain must share a single refresh.
  it('spends one refresh token even when several requests need the chain at once', async () => {
    const abs = fakeAbs()
    const entry = await store.create('token-phone', { ...USER1, chain: chainOf('phone', -60) })
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

  // The same single-refresh guarantee across two *devices* of one user: they share a chain, so the
  // in-flight dedup is keyed by user, and one refresh serves both (ADR-0004).
  it('spends one refresh token when two devices of a user need the chain at once', async () => {
    const abs = fakeAbs()
    const phone = await store.create('token-phone', { ...USER1, chain: chainOf('phone', -60) })
    const tablet = await store.create('token-tablet', { ...USER1, chain: chainOf('tablet', -60) })
    const keepAlive = build(abs)

    const [a, b] = await Promise.all([keepAlive.usableChain(phone), keepAlive.usableChain(tablet)])

    expect(abs.refresh).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })

  it('lets the next request refresh again once the shared one has settled', async () => {
    const abs = fakeAbs()
    const entry = await store.create('token-phone', { ...USER1, chain: chainOf('phone', -60) })
    const keepAlive = build(abs)

    await keepAlive.usableChain(entry)
    await keepAlive.usableChain(entry)

    expect(abs.refresh).toHaveBeenCalledTimes(2)
  })
})
