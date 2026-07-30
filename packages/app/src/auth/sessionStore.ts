import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  SessionStoreConflictError,
  SessionStoreCorruptError,
  SessionStoreIoError,
  SessionStoreWriteError,
} from './errors.js'
import { decodeStoreFile, encodeStoreFile, healStoreFileMode, writeFileAtomic } from './sessionFile.js'

// One Audiobookshelf session: the access token in use plus the refresh token that continues its
// chain. **Shared by every device login of one ABS user** (SPEC section 8, ADR-0004): the server
// keeps exactly one chain per user, so two devices whose access tokens expire together can never
// trigger two refreshes in the same second - the ABS < 2.35.1 identical-refresh-token collision
// (advplyr/audiobookshelf#5253) that a per-device chain left open.
export interface AbsChain {
  accessToken: string
  refreshToken: string
}

// What a sign-in supplies: the identified ABS user plus the chain that sign-in minted. The chain is
// installed only when the user has none yet, or heals a dead one; a user who already has a live
// chain keeps it, and the freshly minted one is a throwaway the caller ends upstream (authService).
export interface SessionRecord {
  absUserId: string
  absUsername: string
  chain: AbsChain
}

// The per-user shared chain, as the store holds it: the ABS user it belongs to, the chain itself,
// when it was last minted or refreshed, and whether it has died. This is the unit the keep-alive
// loop renews - one refresh per user, however many devices ride the chain (keepAlive.ts).
export interface UserChain {
  absUserId: string
  // The ABS username, kept for the operator-facing death report and refreshed on each sign-in. A
  // rename leaves it stale until the next sign-in, which is harmless - nothing branches on it.
  absUsername: string
  chain: AbsChain
  // When this chain was last minted or refreshed, as an ISO string - what the boot pass orders by,
  // stalest first, so the chains nearest Audiobookshelf's refresh-window edge are renewed first.
  chainRefreshedAt: string
  // Set when a refresh proved the chain gone (SPEC section 8). Terminal: a dead chain is never
  // refreshed and never repaired in place. It is revived only by a sign-in of the same user, which
  // replaces it with a fresh chain and thereby heals every device that shares it at once.
  deadSince?: string
}

// A stored device login joined with its user's chain, as callers see it. Instances are frozen:
// every change goes through the store, so the file on disk can never lag behind what callers hold.
// The chain-level fields (chain, chainRefreshedAt, deadSince, absUsername) are the shared chain's;
// several entries of one user carry the same ones.
export interface SessionEntry extends SessionRecord {
  tokenHash: string
  createdAt: string
  chainRefreshedAt?: string
  deadSince?: string
}

// When an entry's (or chain's) chain was last minted or refreshed, as epoch milliseconds. A chain
// always carries its stamp; an entry from a store written before the field existed is dated from
// its creation, which is when its chain was minted. An unparseable stamp reads as the epoch, so a
// damaged record is refreshed first rather than skipped forever.
export function chainRefreshedAt(record: { chainRefreshedAt?: string; createdAt?: string }): number {
  const stamp = Date.parse(record.chainRefreshedAt ?? record.createdAt ?? '')
  return Number.isNaN(stamp) ? 0 : stamp
}

// One device login: the token hash, the ABS user it belongs to, and when it signed in. The chain
// it rides lives once per user in the chains map, not here - that is the whole point of ADR-0004.
interface DeviceRow {
  tokenHash: string
  absUserId: string
  createdAt: string
}

export interface SessionStoreOptions {
  path: string
  key: Buffer
  // How a boot-time warning reaches the operator - today only the mode heal (ADR-0003) speaks.
  // Defaults to console.warn so no caller can turn the heal silent by forgetting to wire it.
  onWarning?: (message: string) => void
}

// The persisted half of the Ratatoskr-native session model (SPEC section 8): device logins and the
// per-user ABS chains they ride, held in memory for the token guard's in-process lookup and mirrored
// into a single AES-256-GCM file so "signed in until explicit sign-out" survives a server restart.
//
// **One chain per ABS user, shared by every device of that user** (ADR-0004, superseding ADR-0001's
// per-device chain). A device row references its user's chain by `absUserId`; the chain is created
// with the user's first device and removed with its last. This is what lets the keep-alive loop
// refresh a user's chain exactly once, and a sign-in heal every device of a user at one stroke.
//
// Scope guard (SPEC section 11): this store persists credentials, not domain state. Progress and
// user data live in Audiobookshelf only - do not grow this into a database.
//
// Single writer per file, by deployment (one container per volume, compose.yaml) rather than by
// lock. Mutations within a process are serialized here and each write replaces the whole file
// atomically, so nothing can tear. A second process is not coordinated with - each holds its own
// copy of every row and writes all of them - so it is instead *detected*: every write checks the
// revision on disk against the one this server left there and refuses on a mismatch, turning the
// silent loss of another instance's sessions into a loud SessionStoreConflictError. Detection, not
// coexistence: a conflict means a misconfiguration to fix, and merging would hide it.
export class SessionStore {
  private devices: Map<string, DeviceRow>
  private chains: Map<string, UserChain>
  // Tail of the write chain, so concurrent mutations queue instead of racing the same file.
  private writes: Promise<unknown> = Promise.resolve()
  // Revision this server last saw in the file, bumped on every successful write. Zero means the
  // file was absent (or predates the counter), which is the only state where writing over
  // "nothing" is legitimate.
  private revision: number

  private constructor(
    private readonly path: string,
    private readonly key: Buffer,
    loaded: { devices: Map<string, DeviceRow>; chains: Map<string, UserChain>; revision: number },
  ) {
    this.devices = loaded.devices
    this.chains = loaded.chains
    this.revision = loaded.revision
  }

  static async open(options: SessionStoreOptions): Promise<SessionStore> {
    const { path, key, onWarning = console.warn } = options
    const file = await readStoreFile(path)
    // A pre-existing file has its mode re-asserted before anything else happens to it - even a
    // wrong-key failure below should not leave the store sitting there widened (ADR-0003).
    if (file !== undefined) await healStoreFileMode(path, onWarning)
    const loaded =
      file === undefined
        ? { devices: new Map<string, DeviceRow>(), chains: new Map<string, UserChain>(), revision: 0 }
        : parsePayload(decodeStoreFile(key, file, path), path)
    const store = new SessionStore(path, key, loaded)
    // Create the file right away when it is absent, so an unwritable volume or a broken mount
    // fails loud at boot rather than at some user's first sign-in hours later. Two servers booting
    // at once on an empty volume also settle here: the loser's first write hits the conflict check.
    if (file === undefined) await store.flush()
    return store
  }

  // The token guard's hot path: a synchronous in-process lookup, no ABS roundtrip (SPEC
  // section 8). Takes the token itself - hashing is the store's business (see hashToken). Joins the
  // device with its user's chain; undefined if the token names no device (a device with no chain is
  // a corruption the parse rules out, so it too reads as absent rather than throwing here).
  find(token: string): SessionEntry | undefined {
    const device = this.devices.get(hashToken(token))
    if (device === undefined) return undefined
    const chain = this.chains.get(device.absUserId)
    return chain === undefined ? undefined : joinEntry(device, chain)
  }

  // One joined entry per device login (several of one user share their chain's fields).
  list(): readonly SessionEntry[] {
    const joined: SessionEntry[] = []
    for (const device of this.devices.values()) {
      const chain = this.chains.get(device.absUserId)
      if (chain !== undefined) joined.push(joinEntry(device, chain))
    }
    return joined
  }

  // Every stored chain, one per ABS user - the unit the keep-alive loop sweeps and boot-orders.
  listChains(): readonly UserChain[] {
    return [...this.chains.values()]
  }

  // The chain for a user as it stands now, for the keep-alive loop holding one from an earlier
  // listChains(). Chains are frozen snapshots, so anything that acts on a *held* one - the sweep,
  // which may reach a chain minutes after listing it - has to re-read first: acting on a chain that
  // has since been refreshed would spend a token Audiobookshelf already rotated away. Undefined
  // means the user's last device signed out in the meantime.
  currentChain(absUserId: string): UserChain | undefined {
    return this.chains.get(absUserId)
  }

  // Add a device login for a user, and settle its chain (ADR-0004). Returns the joined entry and
  // whether the *supplied* chain became the user's chain:
  //   - the user had no chain           → install the supplied one          (usedFreshChain: true)
  //   - the user's chain had died       → replace it, healing every device  (usedFreshChain: true)
  //   - the user already had a live one → keep it, ignore the supplied one  (usedFreshChain: false)
  // The last case is why the caller must end the supplied chain upstream when this returns false: it
  // was minted only to prove the password and is now a throwaway ABS session (authService.signIn).
  async attach(token: string, record: SessionRecord): Promise<{ entry: SessionEntry; usedFreshChain: boolean }> {
    const tokenHash = hashToken(token)
    const now = new Date().toISOString()
    let usedFreshChain = false
    await this.mutate((state) => {
      state.devices.set(tokenHash, freezeDevice({ tokenHash, absUserId: record.absUserId, createdAt: now }))
      const existing = state.chains.get(record.absUserId)
      if (existing === undefined || existing.deadSince !== undefined) {
        state.chains.set(
          record.absUserId,
          freezeChain({
            absUserId: record.absUserId,
            absUsername: record.absUsername,
            chain: { ...record.chain },
            chainRefreshedAt: now,
          }),
        )
        usedFreshChain = true
      }
      return true
    })
    const entry = this.find(token)
    // find() re-reads the live maps after the write landed; the device was just written, so it is
    // there unless a concurrent sign-out of the same token raced this in - vanishingly unlikely for
    // a token only this sign-in holds, but typed honestly all the same.
    if (entry === undefined) throw new SessionStoreWriteError(this.path, { cause: new Error('device vanished mid-attach') })
    return { entry, usedFreshChain }
  }

  // The store side of a sign-in (authService.signIn); returns just the joined entry for callers that
  // do not need to know whether the supplied chain was installed or discarded (tests, fixtures).
  async create(token: string, record: SessionRecord): Promise<SessionEntry> {
    return (await this.attach(token, record)).entry
  }

  // Sign-out: the token is dead the moment its device is gone. When it was the *last* device on its
  // user's chain, the chain is removed too and returned as `endedChain`, so the caller can end that
  // ABS session upstream (authService.signOut) - a chain other devices still ride is kept, and no
  // `endedChain` comes back. `removed` stays false for a token this store never held, so sign-out
  // can be idempotent.
  async delete(token: string): Promise<{ removed: boolean; endedChain?: AbsChain }> {
    const tokenHash = hashToken(token)
    let endedChain: AbsChain | undefined
    const removed = await this.mutate((state) => {
      const device = state.devices.get(tokenHash)
      if (device === undefined) return false
      state.devices.delete(tokenHash)
      if (isLastDevice(state.devices, device.absUserId)) {
        const chain = state.chains.get(device.absUserId)
        if (chain !== undefined) {
          endedChain = chain.chain
          state.chains.delete(device.absUserId)
        }
      }
      return true
    })
    return endedChain === undefined ? { removed } : { removed, endedChain }
  }

  // Record a refreshed ABS chain against a user, stamped with the moment it was refreshed. False
  // means the chain is gone - the user's last device signed out while the chain was being refreshed,
  // and re-adding it would resurrect a revoked session.
  //
  // Deliberately does not clear `deadSince`: death is terminal (SPEC section 8 - no in-place
  // repair), so the keep-alive loop never refreshes a dead chain in the first place; only a sign-in
  // revives one, by replacing it outright (see attach).
  async updateChain(ref: { absUserId: string }, chain: AbsChain): Promise<boolean> {
    return this.mutate((state) => {
      const current = state.chains.get(ref.absUserId)
      if (current === undefined) return false
      state.chains.set(
        ref.absUserId,
        freezeChain({ ...current, chain: { ...chain }, chainRefreshedAt: new Date().toISOString() }),
      )
      return true
    })
  }

  // The chain behind a user is gone and cannot be renewed (see UserChain.deadSince). Every device of
  // that user keeps its entry, so their next request answers the 401 that asks for a password rather
  // than the one that reads as "signed out". False means the user's last device signed out first,
  // which needs no marking - there is no chain left to answer.
  async markDead(ref: { absUserId: string }): Promise<boolean> {
    return this.mutate((state) => {
      const current = state.chains.get(ref.absUserId)
      if (current === undefined) return false
      state.chains.set(ref.absUserId, freezeChain({ ...current, deadSince: new Date().toISOString() }))
      return true
    })
  }

  // Every mutation funnels through here: queued behind the previous write, applied to a copy of both
  // maps, and swapped in only once the write has landed. Memory must never hold a session the file
  // does not, or the next restart would sign that device out with nobody having seen an error - and
  // because find() reads the live maps synchronously and unqueued, "after the write" has to mean the
  // maps it reads are never the half-written ones. So the live maps are replaced in a single pair of
  // assignments after flush() succeeds; a failed write (including one the bounded retry could not
  // rescue) leaves the originals in place and never became visible, so there is nothing to roll back.
  private mutate(change: (state: { devices: Map<string, DeviceRow>; chains: Map<string, UserChain> }) => boolean): Promise<boolean> {
    return this.enqueue(async () => {
      const next = { devices: new Map(this.devices), chains: new Map(this.chains) }
      if (!change(next)) return false
      await this.flush(next)
      this.devices = next.devices
      this.chains = next.chains
      return true
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // Chained on both settlements: one failed write must not wedge every later one.
    const run = this.writes.then(task, task)
    this.writes = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // Persist a set of maps, defaulting to the live ones for the boot-time create in open(). mutate()
  // passes the pending copies so the file is written from them before they ever become live - the
  // revision is bumped only once the bytes have landed, so a failed write leaves both the file and
  // the counter as they were.
  private async flush(
    state: { devices: Map<string, DeviceRow>; chains: Map<string, UserChain> } = { devices: this.devices, chains: this.chains },
  ): Promise<void> {
    await this.assertNobodyElseWrote()
    const revision = this.revision + 1
    const payload = Buffer.from(
      JSON.stringify({ revision, devices: [...state.devices.values()], chains: [...state.chains.values()] }),
      'utf8',
    )
    await writeWithRetry(this.path, encodeStoreFile(this.key, payload))
    this.revision = revision
  }

  // Optimistic concurrency check: re-read the file and compare its revision against what this
  // server left there. Costs one small read and decrypt per write - writes are sign-ins, sign-outs
  // and the daily keep-alive, so that is free in practice.
  //
  // This narrows the window rather than closing it: another writer could still publish between
  // this check and the rename below. Closing it would need a lock, and a lock file outlives a
  // SIGKILL - a stale one would stop the server from booting at all, which is a worse failure for
  // a self-hosted appliance than the misconfiguration it guards against. The revision lives inside
  // the encrypted payload, so it is covered by the GCM tag and cannot be edited on its own.
  private async assertNobodyElseWrote(): Promise<void> {
    const file = await readStoreFile(this.path)
    if (file === undefined) {
      // Nothing on disk is only legitimate before this server has written anything.
      if (this.revision === 0) return
      throw new SessionStoreConflictError(this.path, this.revision, undefined)
    }
    const { revision } = parsePayload(decodeStoreFile(this.key, file, this.path), this.path)
    if (revision !== this.revision) {
      throw new SessionStoreConflictError(this.path, this.revision, revision)
    }
  }
}

// A transient IO failure on the store write - a momentary ENOSPC/EIO blip - is retried a few times
// before it is allowed to fail. It matters most right after a successful ABS refresh: losing that
// write discards the pair Audiobookshelf just rotated to, mutate() rolls memory back to the token
// ABS has already spent, and the next refresh presents it and earns a 401 that marks a live chain
// dead - a silent sign-out from one disk hiccup. Only the write is retried: assertNobodyElseWrote
// ran before it and the revision is bumped only on success, so a retry is idempotent and cannot
// manufacture a conflict; a real conflict is not transient and must surface at once. Bounded tight
// so the shutdown drain, which awaits the write tail (app.ts onClose), is never held up for long.
const WRITE_ATTEMPTS = 3
const WRITE_RETRY_BACKOFF_MS = 50

async function writeWithRetry(path: string, bytes: Buffer): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await writeFileAtomic(path, bytes)
      return
    } catch (err) {
      if (attempt >= WRITE_ATTEMPTS || !(err instanceof SessionStoreWriteError)) throw err
      await delay(WRITE_RETRY_BACKOFF_MS * attempt)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })
}

// Only the hash of the Ratatoskr token is ever stored (SPEC section 8), so even a full store +
// key leak cannot reproduce the credential the app holds. Hashing lives inside the store rather
// than in its callers, so no caller can persist a raw token by mistake. A plain digest is right
// here, not a password hash: the token is 256 bits of entropy, so there is nothing to
// brute-force and no low-entropy secret for a salt to protect.
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

// Whether removing this device leaves the user with none, so its chain can be retired with it.
function isLastDevice(devices: Map<string, DeviceRow>, absUserId: string): boolean {
  for (const device of devices.values()) {
    if (device.absUserId === absUserId) return false
  }
  return true
}

// Join a device row with its user's chain into the frozen snapshot callers hold.
function joinEntry(device: DeviceRow, chain: UserChain): SessionEntry {
  return Object.freeze({
    tokenHash: device.tokenHash,
    absUserId: device.absUserId,
    absUsername: chain.absUsername,
    createdAt: device.createdAt,
    chain: chain.chain,
    chainRefreshedAt: chain.chainRefreshedAt,
    ...(chain.deadSince !== undefined ? { deadSince: chain.deadSince } : {}),
  })
}

function freezeDevice(device: DeviceRow): DeviceRow {
  return Object.freeze(device)
}

function freezeChain(chain: UserChain): UserChain {
  Object.freeze(chain.chain)
  return Object.freeze(chain)
}

async function readStoreFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new SessionStoreIoError(path, { cause })
  }
}

function parsePayload(
  plaintext: Buffer,
  path: string,
): { devices: Map<string, DeviceRow>; chains: Map<string, UserChain>; revision: number } {
  let payload: unknown
  try {
    payload = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new SessionStoreCorruptError(path, 'the decrypted payload is not valid JSON')
  }
  const { devices: deviceList, chains: chainList, revision } = (payload ?? {}) as {
    devices?: unknown
    chains?: unknown
    revision?: unknown
  }
  if (!Array.isArray(deviceList) || !Array.isArray(chainList)) {
    throw new SessionStoreCorruptError(path, 'the decrypted payload carries no device and chain lists')
  }
  const chains = new Map<string, UserChain>()
  for (const candidate of chainList) {
    const chain = asChain(candidate)
    if (chain === undefined) {
      throw new SessionStoreCorruptError(path, 'the decrypted payload contains a malformed chain')
    }
    chains.set(chain.absUserId, chain)
  }
  const devices = new Map<string, DeviceRow>()
  for (const candidate of deviceList) {
    const device = asDevice(candidate)
    if (device === undefined) {
      throw new SessionStoreCorruptError(path, 'the decrypted payload contains a malformed device')
    }
    // Every device must reference a chain that is actually present - a device with no chain could
    // not be resolved, so a store carrying one is corrupt, not merely odd (the invariant ADR-0004
    // rests on: one chain per user, created and removed with the user's first and last device).
    if (!chains.has(device.absUserId)) {
      throw new SessionStoreCorruptError(path, 'the decrypted payload has a device with no chain')
    }
    devices.set(device.tokenHash, device)
  }
  // A payload without a revision counts as zero, so the very first write after this counter was
  // introduced does not read as somebody else's work.
  return { devices, chains, revision: typeof revision === 'number' ? revision : 0 }
}

// Validate the shape rather than trusting our own past writes: the alternative is a malformed row
// surfacing as an obscure TypeError somewhere in the auth path.
function asDevice(candidate: unknown): DeviceRow | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const { tokenHash, absUserId, createdAt } = candidate as Record<string, unknown>
  if (![tokenHash, absUserId, createdAt].every(isNonEmptyString)) return undefined
  return freezeDevice({ tokenHash: tokenHash as string, absUserId: absUserId as string, createdAt: createdAt as string })
}

function asChain(candidate: unknown): UserChain | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const { absUserId, absUsername, chainRefreshedAt: refreshedAt, deadSince, chain } = candidate as Record<string, unknown>
  if (![absUserId, absUsername, refreshedAt].every(isNonEmptyString)) return undefined
  if (typeof chain !== 'object' || chain === null) return undefined
  const { accessToken, refreshToken } = chain as Record<string, unknown>
  if (!isNonEmptyString(accessToken) || !isNonEmptyString(refreshToken)) return undefined
  // deadSince is spread in only when present: an explicit `undefined` is not the same as an absent
  // property under exactOptionalPropertyTypes, and writing one back out would put a null into the
  // file for every chain that is alive.
  return freezeChain({
    absUserId: absUserId as string,
    absUsername: absUsername as string,
    chain: { accessToken, refreshToken },
    chainRefreshedAt: refreshedAt as string,
    ...(isNonEmptyString(deadSince) ? { deadSince } : {}),
  })
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}
