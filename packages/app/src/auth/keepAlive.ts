import type { AbsClient } from '../abs/client.js'
import { AbsAuthError } from '../abs/errors.js'
import { jwtExpSeconds } from '../abs/jwt.js'
import { UpstreamSessionLostError } from './errors.js'
import { chainRefreshedAt, type AbsChain, type SessionEntry, type SessionStore } from './sessionStore.js'

// How often every stored chain is renewed. Daily, as ADR-0001 decided: Audiobookshelf's refresh
// window is at least seven days, so a sweep a day means a chain survives six missed ones.
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

// Spread on top of that interval, drawn once per sweep. Two servers started by the same update do
// not then walk into ABS together every day at the same moment, and neither does this one land on
// the same wall-clock second for the rest of its uptime.
const REFRESH_JITTER_MS = 60 * 60 * 1000

// The gap between two chains within one sweep. Deliberately over a second: below Audiobookshelf
// 2.35.1 the refresh token is minted from second-precision timestamps with no per-session claim, so
// two refreshes of the same user inside one second come back with the *identical* token — and
// ending one chain then ends the other (ADR-0001's amendment, advplyr/audiobookshelf#5253). A loop
// that refreshed the whole store at once would be the most reliable way to trigger exactly that.
export const CHAIN_SPACING_MS = 1500

// How stale a chain has to be at boot to be renewed before the first scheduled sweep. One interval:
// that is precisely "this chain missed a sweep because the server was down for it".
const STALE_AFTER_MS = REFRESH_INTERVAL_MS

// How long before an access token expires the request path renews it. The token has to outlive the
// upstream call it is about to authenticate, and a minute covers a slow ABS with room to spare.
const ACCESS_TOKEN_MARGIN_SECONDS = 60

// The slice of a logger this needs (structurally satisfied by Fastify's pino logger).
export interface KeepAliveLogger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

export interface KeepAliveOptions {
  refreshIntervalMs?: number
  refreshJitterMs?: number
  chainSpacingMs?: number
  staleAfterMs?: number
  accessTokenMarginSeconds?: number
  // Injected so a test can pin the jitter it would otherwise have to guess.
  random?: () => number
  logger?: KeepAliveLogger
}

// The keep-alive half of the Ratatoskr-native session model (SPEC section 8 / ADR-0001): what makes
// a stored Audiobookshelf chain outlive any pause, on three schedules that answer three different
// ways of losing one.
//
// - **Daily, jittered**: every stored chain is renewed once a day, so the refresh token never ages
//   out of Audiobookshelf's window while the server is up.
// - **On boot**: chains that missed a sweep because the server was down are renewed first, nearest
//   the window's edge first — the ones a slow or partial recovery would otherwise lose.
// - **On demand**: a stored access token is renewed as its own (much shorter) expiry approaches,
//   because the daily sweep is about the refresh token and says nothing about the access one.
//
// What is left after that is the failure this cannot prevent: Audiobookshelf refuses the refresh
// token, because contact was lost for the whole window or the account was renamed. Then the chain is
// marked dead and the entry is *kept*, so the device's next request is answered with 401
// `UPSTREAM_SESSION_LOST` — "your password, please" — instead of the 401 that means "signed out".
export class ChainKeepAlive {
  private readonly refreshIntervalMs: number
  private readonly refreshJitterMs: number
  private readonly chainSpacingMs: number
  private readonly staleAfterMs: number
  private readonly accessTokenMarginSeconds: number
  private readonly random: () => number
  private readonly logger: KeepAliveLogger | undefined

  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  // One refresh per entry, shared by everyone who asks for it while it is in flight. Audiobookshelf
  // rotates the refresh token on use, so two concurrent refreshes of one chain would spend the same
  // token twice — the second call fails, and this loop would then mark a perfectly live chain dead.
  private readonly inFlight = new Map<string, Promise<AbsChain | undefined>>()
  // Tail of the refresh chain, so no two refreshes overlap even across the three schedules above.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly abs: AbsClient,
    private readonly store: SessionStore,
    options: KeepAliveOptions = {},
  ) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS
    this.refreshJitterMs = options.refreshJitterMs ?? REFRESH_JITTER_MS
    this.chainSpacingMs = options.chainSpacingMs ?? CHAIN_SPACING_MS
    this.staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS
    this.accessTokenMarginSeconds = options.accessTokenMarginSeconds ?? ACCESS_TOKEN_MARGIN_SECONDS
    this.random = options.random ?? Math.random
    this.logger = options.logger
  }

  // Arm both schedules. Returns immediately: the boot refresh runs in the background, because a
  // slow or unreachable Audiobookshelf must delay the server's first request, never its startup.
  start(): void {
    if (this.running) return
    this.running = true
    void this.refreshStale()
    this.scheduleSweep()
  }

  stop(): void {
    this.running = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  // Renew every live chain in the store, paced (see CHAIN_SPACING_MS).
  async sweep(): Promise<void> {
    await this.refreshEach(this.store.list().filter(isLive))
  }

  // The boot pass: only the chains that missed a sweep, stalest first, so a recovery that gets
  // interrupted has spent its time on the ones nearest Audiobookshelf's refresh-window edge.
  async refreshStale(): Promise<void> {
    const cutoff = Date.now() - this.staleAfterMs
    const stale = this.store
      .list()
      .filter((entry) => isLive(entry) && chainRefreshedAt(entry) <= cutoff)
      .sort((a, b) => chainRefreshedAt(a) - chainRefreshedAt(b))
    if (stale.length > 0) this.logger?.info({ chains: stale.length }, 'renewing stale Audiobookshelf chains')
    await this.refreshEach(stale)
  }

  // The chain to act with right now, for a request that has resolved this entry. Renews the access
  // token when it is at or past its margin, so the upstream call behind this one is not made with a
  // credential that expired during a pause (SPEC section 8).
  //
  // Throws UpstreamSessionLostError — 401 `UPSTREAM_SESSION_LOST` — when the chain is dead, whether
  // it was already marked or this call is what proved it. An unreachable Audiobookshelf propagates
  // instead (502): an outage is not a lost session, and the chain is still there to renew later.
  async usableChain(entry: SessionEntry): Promise<AbsChain> {
    if (!isLive(entry)) throw new UpstreamSessionLostError()
    if (!this.nearExpiry(entry.chain.accessToken)) return entry.chain
    const refreshed = await this.refreshChain(entry)
    if (refreshed === undefined) throw new UpstreamSessionLostError()
    return refreshed
  }

  // Whether the access token is close enough to its expiry to renew now. A token this cannot read a
  // clock off (older, non-JWT Audiobookshelf) is left alone: there is nothing to renew ahead of, so
  // its eventual rejection surfaces as the 401 it always did.
  private nearExpiry(accessToken: string): boolean {
    const exp = jwtExpSeconds(accessToken)
    if (exp === undefined) return false
    return Date.now() / 1000 >= exp - this.accessTokenMarginSeconds
  }

  // Walk a batch, spacing the refreshes. One chain's failure never stops the rest — an outage would
  // otherwise cost every chain behind the first one its renewal, which is the very thing a sweep
  // exists to prevent.
  private async refreshEach(entries: readonly SessionEntry[]): Promise<void> {
    for (const [index, entry] of entries.entries()) {
      if (index > 0) await delay(this.chainSpacingMs)
      try {
        await this.refreshChain(entry)
      } catch (err) {
        this.logger?.warn({ err, absUserId: entry.absUserId }, 'could not renew an Audiobookshelf chain; will retry')
      }
    }
  }

  // Join the refresh already running for this entry, or start one (see inFlight).
  private refreshChain(entry: SessionEntry): Promise<AbsChain | undefined> {
    const running = this.inFlight.get(entry.tokenHash)
    if (running !== undefined) return running
    const started = (async () => {
      try {
        return await this.enqueue(() => this.refreshOnce(entry))
      } finally {
        this.inFlight.delete(entry.tokenHash)
      }
    })()
    this.inFlight.set(entry.tokenHash, started)
    return started
  }

  // One renewal: spend the stored refresh token, persist the pair Audiobookshelf rotated to.
  // Undefined means the chain is gone for good — the only outcome that marks it, and only for the
  // rejection that proves it (401). Anything else is an outage and propagates untouched.
  private async refreshOnce(entry: SessionEntry): Promise<AbsChain | undefined> {
    let pair
    try {
      pair = await this.abs.refresh(entry.chain.refreshToken)
    } catch (err) {
      if (!(err instanceof AbsAuthError)) throw err
      await this.store.markDead(entry)
      this.logger?.warn(
        { absUserId: entry.absUserId, absUsername: entry.absUsername },
        'Audiobookshelf refused a stored refresh token; this device must sign in again',
      )
      return undefined
    }
    const chain = { accessToken: pair.accessToken, refreshToken: pair.refreshToken }
    // A false return means the device signed out mid-refresh, so there is nothing to store. The
    // chain still goes back to the caller: its request is already running on this entry, and the
    // upstream session it names outlives the local entry either way.
    await this.store.updateChain(entry, chain)
    return chain
  }

  // Every refresh runs alone, chained on both settlements so one failure cannot wedge the rest.
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private scheduleSweep(): void {
    this.timer = setTimeout(
      () => {
        // Rescheduled before the sweep rather than after it, so the next day is armed even if this
        // sweep is slow, and so the cadence cannot drift by however long a full store takes.
        if (this.running) this.scheduleSweep()
        void this.sweep().catch((err: unknown) => this.logger?.warn({ err }, 'the daily chain sweep failed'))
      },
      this.refreshIntervalMs + Math.floor(this.random() * this.refreshJitterMs),
    )
    // Never keep the process alive for the sweep: it is maintenance, and shutdown stops it anyway.
    this.timer.unref?.()
  }
}

// A dead chain is never refreshed: death is terminal (SPEC section 8 — no in-place repair), so a
// renewal could only fail, and succeeding would quietly revive a session whose device has already
// been told to re-authenticate.
function isLive(entry: SessionEntry): boolean {
  return entry.deadSince === undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
