import type { AbsClient } from '../abs/client.js'
import { AbsAuthError } from '../abs/errors.js'
import { jwtExpSeconds } from '../abs/jwt.js'
import { UnknownTokenError, UpstreamSessionLostError } from './errors.js'
import { chainRefreshedAt, type AbsChain, type SessionEntry, type SessionStore } from './sessionStore.js'

// How often every stored chain is renewed. Daily, as ADR-0001 decided: Audiobookshelf's refresh
// window is at least seven days, so a sweep a day means a chain survives six missed ones.
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

// The jitter window, as a fraction of whatever the interval is: a spread drawn on top of each
// interval so two servers started by the same update do not walk into ABS together every day at the
// same moment, and neither does one of them land on the same wall-clock second for the rest of its
// uptime. A twenty-fourth gives the daily default its hour, and — being derived rather than a
// constant of its own — cannot outgrow a shortened interval and swamp the thing it is spreading.
const REFRESH_JITTER_FRACTION = 24

// The gap between two chains within one sweep. Deliberately over a second: below Audiobookshelf
// 2.35.1 the refresh token is minted from second-precision timestamps with no per-session claim, so
// two refreshes of the same user inside one second come back with the *identical* token — and
// ending one chain then ends the other (ADR-0001's amendment, advplyr/audiobookshelf#5253). A loop
// that refreshed the whole store at once would be the most reliable way to trigger exactly that.
export const CHAIN_SPACING_MS = 1500

// How long before an access token expires the request path renews it. The token has to outlive the
// upstream call it is about to authenticate, and a minute covers a slow ABS with room to spare.
const ACCESS_TOKEN_MARGIN_SECONDS = 60

// The slice of a logger this needs (structurally satisfied by Fastify's pino logger).
export interface KeepAliveLogger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

// What one renewal came to. `gone` and `dead` are different 401s to a caller on the request path
// (see usableChain) and both simply "nothing to do" to a sweep, which is why the outcome is a value
// rather than an exception: only one of the three is exceptional, and it is the one that throws.
type RefreshOutcome = { kind: 'renewed'; chain: AbsChain } | { kind: 'dead' } | { kind: 'gone' }

export interface KeepAliveOptions {
  // How often the sweep runs. The one knob an operator can reach (KEEP_ALIVE_REFRESH_INTERVAL_MS,
  // SPEC section 7), because it is also the boot pass's staleness cutoff — which is what lets a test
  // deployment provoke the dead-chain path by restarting instead of by waiting a day.
  refreshIntervalMs?: number
  chainSpacingMs?: number
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
  private readonly chainSpacingMs: number
  private readonly accessTokenMarginSeconds: number
  private readonly random: () => number
  private readonly logger: KeepAliveLogger | undefined

  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  // Set by stop(), read between the steps of a paced batch — a sweep must not outlive the server.
  private aborted = false
  // Whether a sweep is mid-walk, so the schedule can skip rather than stack (see scheduleSweep).
  private sweeping = false
  // When the last renewal of any kind finished, so a sweep can leave the spacing gap after an
  // on-demand refresh too (see refreshEach).
  private lastRefreshAt = 0
  // One refresh per entry, shared by everyone who asks for it while it is in flight. Audiobookshelf
  // rotates the refresh token on use, so two concurrent refreshes of one chain would spend the same
  // token twice — the second call fails, and this loop would then mark a perfectly live chain dead.
  private readonly inFlight = new Map<string, Promise<RefreshOutcome>>()
  // Tail of the refresh chain, so no two refreshes overlap even across the three schedules above.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly abs: AbsClient,
    private readonly store: SessionStore,
    options: KeepAliveOptions = {},
  ) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS
    this.chainSpacingMs = options.chainSpacingMs ?? CHAIN_SPACING_MS
    this.accessTokenMarginSeconds = options.accessTokenMarginSeconds ?? ACCESS_TOKEN_MARGIN_SECONDS
    this.random = options.random ?? Math.random
    this.logger = options.logger
  }

  // Arm both schedules. Returns immediately: the boot refresh runs in the background, because a
  // slow or unreachable Audiobookshelf must delay the server's first request, never its startup.
  // Its rejection is caught rather than left to float — an unhandled one takes the process down,
  // and a boot with an unreachable ABS is an ordinary morning, not a fatal condition.
  start(): void {
    if (this.running) return
    this.running = true
    this.aborted = false
    void this.refreshStale().catch((err: unknown) => this.logger?.warn({ err }, 'the boot chain refresh failed'))
    this.scheduleSweep()
  }

  // Stops the schedule *and* whatever it is in the middle of: a paced sweep of a large store runs
  // for minutes, and shutdown must not keep renewing chains and writing the store behind a server
  // that is closing (app.ts's onClose). The refresh already in flight is allowed to finish, so the
  // store is never left describing a chain that was rotated away.
  stop(): void {
    this.running = false
    this.aborted = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  // Renew every live chain in the store, paced (see CHAIN_SPACING_MS).
  async sweep(): Promise<void> {
    this.sweeping = true
    try {
      await this.refreshEach(this.store.list().filter(isLive))
    } finally {
      this.sweeping = false
    }
  }

  // The boot pass: only the chains that missed a sweep, stalest first, so a recovery that gets
  // interrupted has spent its time on the ones nearest Audiobookshelf's refresh-window edge.
  //
  // "Stale" is one refresh interval old, read off the interval rather than configured beside it:
  // stale means exactly "was due for a sweep this server was not up for", so the two must not be
  // able to disagree.
  async refreshStale(): Promise<void> {
    const cutoff = Date.now() - this.refreshIntervalMs
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
  // instead (502): an outage is not a lost session, and the chain is still there to renew later. A
  // device that signed out while this ran gets the unknown-token 401, which is what it now is.
  async usableChain(entry: SessionEntry): Promise<AbsChain> {
    if (!isLive(entry)) throw new UpstreamSessionLostError()
    if (!this.nearExpiry(entry.chain.accessToken)) return entry.chain
    const outcome = await this.refreshChain(entry)
    switch (outcome.kind) {
      case 'renewed':
        return outcome.chain
      case 'dead':
        throw new UpstreamSessionLostError()
      default:
        throw new UnknownTokenError()
    }
  }

  // Whether the access token is close enough to its expiry to renew now. A token this cannot read a
  // clock off is left alone: there is nothing to renew ahead of, so its eventual rejection surfaces
  // as the 401 it always did. Defensive only in practice — the server requires Audiobookshelf 2.26
  // or newer (README), and those issue JWTs.
  private nearExpiry(accessToken: string): boolean {
    const exp = jwtExpSeconds(accessToken)
    if (exp === undefined) return false
    return Date.now() / 1000 >= exp - this.accessTokenMarginSeconds
  }

  // Walk a batch, leaving the gap since the *last renewal of any kind* before each one — so the
  // spacing holds against an on-demand refresh too, not just within this batch. The waiting is
  // deliberately all on this side: a sweep is maintenance and can afford to yield, while a request
  // queueing behind a whole store's worth of gaps would be a user watching a spinner for the sake
  // of a collision on an Audiobookshelf older than 2.35.1.
  //
  // One chain's failure never stops the rest — an outage would otherwise cost every chain behind
  // the first one its renewal, which is the very thing a sweep exists to prevent.
  private async refreshEach(entries: readonly SessionEntry[]): Promise<void> {
    for (const entry of entries) {
      if (this.aborted) return
      const gap = this.lastRefreshAt + this.chainSpacingMs - Date.now()
      if (gap > 0) await delay(gap)
      if (this.aborted) return
      try {
        await this.refreshChain(entry)
      } catch (err) {
        this.logger?.warn({ err, absUserId: entry.absUserId }, 'could not renew an Audiobookshelf chain; will retry')
      }
    }
  }

  // Join the refresh already running for this entry, or start one (see inFlight). The completion
  // time is stamped here rather than inside refreshOnce, so a renewal from *any* schedule is what
  // the next sweep's spacing measures from.
  private refreshChain(entry: SessionEntry): Promise<RefreshOutcome> {
    const running = this.inFlight.get(entry.tokenHash)
    if (running !== undefined) return running
    const started = (async () => {
      try {
        return await this.enqueue(() => this.refreshOnce(entry))
      } finally {
        this.lastRefreshAt = Date.now()
        this.inFlight.delete(entry.tokenHash)
      }
    })()
    this.inFlight.set(entry.tokenHash, started)
    return started
  }

  // One renewal: spend the stored refresh token, persist the pair Audiobookshelf rotated to.
  // Anything but a 401 is an outage and propagates untouched — only the rejection that *proves* the
  // chain gone marks it.
  private async refreshOnce(entry: SessionEntry): Promise<RefreshOutcome> {
    // Re-read before spending anything. `entry` is a frozen snapshot, and a paced sweep can reach
    // it long after listing it, by which time the request path may have renewed that very chain —
    // presenting the token ABS has since rotated away would earn a 401 and mark a live chain dead,
    // which is precisely the outcome this loop exists to prevent. The in-flight map only rules out
    // *overlapping* refreshes; this rules out the sequential one.
    const current = this.store.current(entry)
    if (current === undefined) return { kind: 'gone' }
    if (!isLive(current)) return { kind: 'dead' }

    let pair
    try {
      pair = await this.abs.refresh(current.chain.refreshToken)
    } catch (err) {
      if (!(err instanceof AbsAuthError)) throw err
      await this.store.markDead(current)
      this.logger?.warn(
        { absUserId: current.absUserId, absUsername: current.absUsername },
        'Audiobookshelf refused a stored refresh token; this device must sign in again',
      )
      return { kind: 'dead' }
    }
    const chain = { accessToken: pair.accessToken, refreshToken: pair.refreshToken }
    // A false return means the device signed out during the call. The chain still goes back to the
    // caller: its request is already running on this entry, and the upstream session it names
    // outlives the local entry either way.
    await this.store.updateChain(current, chain)
    return { kind: 'renewed', chain }
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
    const jitter = Math.floor(this.random() * (this.refreshIntervalMs / REFRESH_JITTER_FRACTION))
    this.timer = setTimeout(() => {
      // Rescheduled before the sweep rather than after it, so the next interval is armed even if
      // this sweep is slow, and so the cadence cannot drift by however long a full store takes.
      if (this.running) this.scheduleSweep()
      // A sweep still walking when the next one comes due is skipped rather than started beside it.
      // At the daily default this cannot happen; at an interval shortened for a test deployment it
      // is the normal case, and stacking the walks would queue every chain several times over.
      if (this.sweeping) {
        this.logger?.info({}, 'the previous chain sweep is still running; skipping this one')
        return
      }
      void this.sweep().catch((err: unknown) => this.logger?.warn({ err }, 'the daily chain sweep failed'))
    }, this.refreshIntervalMs + jitter)
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
