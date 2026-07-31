import type { AbsClient } from '../abs/client.js'
import { AbsAuthError } from '../abs/errors.js'
import { jwtExpSeconds } from '../abs/jwt.js'
import { UnknownTokenError, UpstreamSessionLostError } from './errors.js'
import { chainRefreshedAt, type AbsChain, type SessionEntry, type SessionStore, type UserChain } from './sessionStore.js'

// How often every stored chain is renewed. Daily, as ADR-0001 decided: Audiobookshelf's refresh
// window is at least seven days, so a sweep a day means a chain survives six missed ones.
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

// The jitter window, as a fraction of whatever the interval is: a spread drawn on top of each
// interval so two servers started by the same update do not walk into ABS together every day at the
// same moment, and neither does one of them land on the same wall-clock second for the rest of its
// uptime. A twenty-fourth gives the daily default its hour, and - being derived rather than a
// constant of its own - cannot outgrow a shortened interval and swamp the thing it is spreading.
const REFRESH_JITTER_FRACTION = 24

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
  // SPEC section 7), because it is also the boot pass's staleness cutoff - which is what lets a test
  // deployment provoke the dead-chain path by restarting instead of by waiting a day.
  refreshIntervalMs?: number
  accessTokenMarginSeconds?: number
  // Injected so a test can pin the jitter it would otherwise have to guess.
  random?: () => number
  logger?: KeepAliveLogger
}

// The keep-alive half of the Ratatoskr-native session model (SPEC section 8 / ADR-0001): what makes
// a stored Audiobookshelf chain outlive any pause, on three schedules that answer three different
// ways of losing one. The unit it renews is the **per-user chain** (ADR-0004): one refresh serves
// every device of a user, so two devices whose access tokens expire together can never drive two
// refreshes at once - the ABS < 2.35.1 identical-token collision a per-device chain left open, and
// the reason the old CHAIN_SPACING_MS gap existed at all. With one chain per user there is nothing
// of a user's to space against anything else of theirs, so the gap is gone.
//
// - **Daily, jittered**: every stored chain is renewed once a day, so the refresh token never ages
//   out of Audiobookshelf's window while the server is up.
// - **On boot**: chains that missed a sweep because the server was down are renewed first, nearest
//   the window's edge first - the ones a slow or partial recovery would otherwise lose.
// - **On demand**: a stored access token is renewed as its own (much shorter) expiry approaches,
//   because the daily sweep is about the refresh token and says nothing about the access one.
//
// What is left after that is the failure this cannot prevent: Audiobookshelf refuses the refresh
// token, because contact was lost for the whole window or the account was renamed. Then the chain is
// marked dead and the devices are *kept*, so a device's next request is answered with 401
// `UPSTREAM_SESSION_LOST` - "your password, please" - instead of the 401 that means "signed out".
export class ChainKeepAlive {
  private readonly refreshIntervalMs: number
  private readonly accessTokenMarginSeconds: number
  private readonly random: () => number
  private readonly logger: KeepAliveLogger | undefined

  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  // Set by stop(), read between the steps of a batch - a sweep must not outlive the server.
  private aborted = false
  // Whether a sweep is mid-walk, so the schedule can skip rather than stack (see scheduleSweep).
  private sweeping = false
  // One refresh per user chain, shared by everyone who asks for it while it is in flight, keyed by
  // ABS user id. Audiobookshelf rotates the refresh token on use, so two concurrent refreshes of one
  // chain would spend the same token twice - the second call fails, and this loop would then mark a
  // perfectly live chain dead. Keying by user (not by device) is what makes several devices of one
  // user share the single refresh their single chain needs.
  private readonly inFlight = new Map<string, Promise<RefreshOutcome>>()
  // Tail of the refresh chain, so no two refreshes overlap even across the three schedules above.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly abs: AbsClient,
    private readonly store: SessionStore,
    options: KeepAliveOptions = {},
  ) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS
    this.accessTokenMarginSeconds = options.accessTokenMarginSeconds ?? ACCESS_TOKEN_MARGIN_SECONDS
    this.random = options.random ?? Math.random
    this.logger = options.logger
  }

  // Arm both schedules. Returns immediately: the boot refresh runs in the background, because a
  // slow or unreachable Audiobookshelf must delay the server's first request, never its startup.
  // Its rejection is caught rather than left to float - an unhandled one takes the process down,
  // and a boot with an unreachable ABS is an ordinary morning, not a fatal condition.
  start(): void {
    if (this.running) return
    this.running = true
    this.aborted = false
    void this.refreshStale().catch((err: unknown) => this.logger?.warn({ err }, 'the boot chain refresh failed'))
    this.scheduleSweep()
  }

  // Stops the schedule *and* whatever it is in the middle of: a sweep of a large store runs for a
  // while, and shutdown must not keep renewing chains and writing the store behind a server that is
  // closing (app.ts's onClose). Returns at once; the refresh already in flight is left to finish,
  // and drained() is how the caller waits for it.
  stop(): void {
    this.running = false
    this.aborted = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  // Resolves once the refresh in flight has finished its store write. onClose awaits this after
  // stop(), because main.ts calls process.exit the instant app.close() settles: a SIGTERM landing
  // between abs.refresh (the token already rotated upstream) and the write would otherwise lose the
  // write, and the next boot - presenting the spent token - would mark a live chain dead, the exact
  // restart-sign-out this loop exists to prevent. Nothing new can enqueue behind it by then: stop()
  // has aborted the sweep, and Fastify has stopped accepting the requests that drive on-demand
  // renewals - so the current tail is the whole of what is left. main.ts's drain timeout bounds it.
  drained(): Promise<void> {
    return this.queue.then(() => undefined)
  }

  // Renew every live chain in the store.
  async sweep(): Promise<void> {
    this.sweeping = true
    try {
      await this.refreshEach(this.store.listChains().filter(isLive))
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
    // Held under the same skip flag as sweep(): at a test-shortened interval the first scheduled
    // sweep can come due while this boot pass is still walking, and stacking the two would refresh
    // every chain twice back-to-back - the pile-up the flag exists to prevent.
    this.sweeping = true
    try {
      const cutoff = Date.now() - this.refreshIntervalMs
      const stale = this.store
        .listChains()
        .filter((chain) => isLive(chain) && chainRefreshedAt(chain) <= cutoff)
        .sort((a, b) => chainRefreshedAt(a) - chainRefreshedAt(b))
      if (stale.length > 0) this.logger?.info({ chains: stale.length }, 'renewing stale Audiobookshelf chains')
      await this.refreshEach(stale)
    } finally {
      this.sweeping = false
    }
  }

  // The chain to act with right now, for a request that has resolved this entry. Renews the access
  // token when it is at or past its margin, so the upstream call behind this one is not made with a
  // credential that expired during a pause (SPEC section 8).
  //
  // Throws UpstreamSessionLostError - 401 `UPSTREAM_SESSION_LOST` - when the chain is dead, whether
  // it was already marked or this call is what proved it. An unreachable Audiobookshelf propagates
  // instead (502): an outage is not a lost session, and the chain is still there to renew later. A
  // device that signed out while this ran gets the unknown-token 401, which is what it now is.
  async usableChain(entry: SessionEntry): Promise<AbsChain> {
    if (!isLive(entry)) throw new UpstreamSessionLostError()
    if (!this.nearExpiry(entry.chain.accessToken)) return entry.chain
    const outcome = await this.refreshChain(entry.absUserId)
    switch (outcome.kind) {
      case 'renewed':
        return outcome.chain
      case 'dead':
        throw new UpstreamSessionLostError()
      default:
        throw new UnknownTokenError()
    }
  }

  // The request path's counterpart to a refresh that returned `dead` (refreshOnce): a proxied
  // Audiobookshelf call rejected the access token of a chain that was live and not near enough to
  // expiry for usableChain to refresh it first - an upstream revocation ahead of expiry (#163).
  // Bury the chain, exactly as a proven-dead refresh does, and raise the lost-session 401 the client
  // acts on rather than the generic unauthorized the raw AbsAuthError maps to. Only api/app.ts calls
  // this, and only after re-resolving the token to a still-live entry, so a chain that signed out or
  // was already marked dead mid-request is left to its own mapping (SPEC section 8).
  async loseChain(entry: SessionEntry): Promise<never> {
    await this.store.markDead({ absUserId: entry.absUserId })
    this.logger?.warn(
      { absUserId: entry.absUserId, absUsername: entry.absUsername },
      'Audiobookshelf rejected a live access token on the request path; this device must sign in again',
    )
    throw new UpstreamSessionLostError()
  }

  // Whether the access token is close enough to its expiry to renew now. A token this cannot read a
  // clock off is left alone: there is nothing to renew ahead of, so its eventual rejection surfaces
  // as the 401 it always did. Defensive only in practice - the server requires Audiobookshelf 2.26
  // or newer (README), and those issue JWTs.
  private nearExpiry(accessToken: string): boolean {
    const exp = jwtExpSeconds(accessToken)
    if (exp === undefined) return false
    return Date.now() / 1000 >= exp - this.accessTokenMarginSeconds
  }

  // Walk a batch of chains, one refresh apiece. No pacing between them: one chain per user means no
  // two of them can collide on Audiobookshelf's second-precision refresh-token minting (ADR-0004),
  // which is the only thing the old inter-refresh gap ever guarded against.
  //
  // One chain's failure never stops the rest - an outage would otherwise cost every chain behind
  // the first one its renewal, which is the very thing a sweep exists to prevent.
  private async refreshEach(chains: readonly UserChain[]): Promise<void> {
    for (const chain of chains) {
      if (this.aborted) return
      try {
        await this.refreshChain(chain.absUserId)
      } catch (err) {
        this.logger?.warn({ err, absUserId: chain.absUserId }, 'could not renew an Audiobookshelf chain; will retry')
      }
    }
  }

  // Join the refresh already running for this user's chain, or start one (see inFlight). Keyed by
  // ABS user id, so every device of a user shares the single refresh their single chain needs.
  private refreshChain(absUserId: string): Promise<RefreshOutcome> {
    const running = this.inFlight.get(absUserId)
    if (running !== undefined) return running
    const started = (async () => {
      try {
        return await this.enqueue(() => this.refreshOnce(absUserId))
      } finally {
        this.inFlight.delete(absUserId)
      }
    })()
    this.inFlight.set(absUserId, started)
    return started
  }

  // One renewal: spend the stored refresh token, persist the pair Audiobookshelf rotated to.
  // Anything but a 401 is an outage and propagates untouched - only the rejection that *proves* the
  // chain gone marks it.
  private async refreshOnce(absUserId: string): Promise<RefreshOutcome> {
    // Re-read before spending anything. A sweep can reach a chain long after listing it, by which
    // time the request path may have renewed that very chain - presenting the token ABS has since
    // rotated away would earn a 401 and mark a live chain dead, which is precisely the outcome this
    // loop exists to prevent. The in-flight map only rules out *overlapping* refreshes; this rules
    // out the sequential one. Undefined means the user's last device signed out in between.
    const current = this.store.currentChain(absUserId)
    if (current === undefined) return { kind: 'gone' }
    if (!isLive(current)) return { kind: 'dead' }

    // The refresh token this renewal spends. Both the write-back and the death are guarded by it, so
    // a slow refresh whose chain was healed out from under it (a sign-in replaced the dead chain, or
    // another renewal rotated it) neither clobbers the successor nor buries a now-live chain: the
    // stored token has moved on, and the guarded write is skipped (updateChain / markDead).
    const spent = current.chain.refreshToken
    try {
      const pair = await this.abs.refresh(spent)
      const chain = { accessToken: pair.accessToken, refreshToken: pair.refreshToken }
      // A false return means the write did not apply - the user's last device signed out during the
      // call, or the chain was healed/rotated meanwhile. The chain still goes back to the caller: its
      // request is already running on this entry, and the upstream session it names outlives the
      // local chain either way.
      await this.store.updateChain({ absUserId }, chain, spent)
      return { kind: 'renewed', chain }
    } catch (err) {
      if (!(err instanceof AbsAuthError)) throw err
      await this.store.markDead({ absUserId }, spent)
      this.logger?.warn(
        { absUserId: current.absUserId, absUsername: current.absUsername },
        'Audiobookshelf refused a stored refresh token; the devices on this chain must sign in again',
      )
      return { kind: 'dead' }
    }
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

// A dead chain is never refreshed: death is terminal (SPEC section 8 - no in-place repair), so a
// renewal could only fail, and succeeding would quietly revive a session whose devices have already
// been told to re-authenticate.
function isLive(chain: { deadSince?: string }): boolean {
  return chain.deadSince === undefined
}
