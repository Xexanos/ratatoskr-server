import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { SessionStoreConflictError, SessionStoreCorruptError, SessionStoreIoError } from './errors.js'
import { decodeStoreFile, encodeStoreFile, writeFileAtomic } from './sessionFile.js'

// One device login's private Audiobookshelf session: the access token in use plus the refresh
// token that continues its chain. Never shared between devices (SPEC section 8) — two consumers
// of one rotating chain is the exact failure mode ADR-0001 removes.
export interface AbsChain {
  accessToken: string
  refreshToken: string
}

// What a sign-in supplies: the identified ABS user plus the chain created for this device. The
// ABS username is kept because ABS invalidates a chain when the username changes, so the
// keep-alive path needs to recognize the account it is refreshing for.
export interface SessionRecord {
  absUserId: string
  absUsername: string
  chain: AbsChain
}

// A stored device login. Instances are frozen: every change goes through the store, so the file
// on disk can never lag behind what callers see.
export interface SessionEntry extends SessionRecord {
  tokenHash: string
  createdAt: string
}

export interface SessionStoreOptions {
  path: string
  key: Buffer
}

// The persisted half of the Ratatoskr-native session model (SPEC section 8): one entry per
// device login, held in memory for the token guard's in-process lookup and mirrored into a
// single AES-256-GCM file so "signed in until explicit sign-out" survives a server restart.
//
// Scope guard (SPEC section 11): this store persists credentials, not domain state. Progress and
// user data live in Audiobookshelf only — do not grow this into a database.
//
// Single writer per file, by deployment (one container per volume, compose.yaml) rather than by
// lock. Mutations within a process are serialized here and each write replaces the whole file
// atomically, so nothing can tear. A second process is not coordinated with — each holds its own
// copy of every entry and writes all of them — so it is instead *detected*: every write checks the
// revision on disk against the one this server left there and refuses on a mismatch, turning the
// silent loss of another instance's sessions into a loud SessionStoreConflictError. Detection, not
// coexistence: a conflict means a misconfiguration to fix, and merging would hide it.
export class SessionStore {
  private entries: Map<string, SessionEntry>
  // Tail of the write chain, so concurrent mutations queue instead of racing the same file.
  private writes: Promise<unknown> = Promise.resolve()
  // Revision this server last saw in the file, bumped on every successful write. Zero means the
  // file was absent (or predates the counter), which is the only state where writing over
  // "nothing" is legitimate.
  private revision: number

  private constructor(
    private readonly path: string,
    private readonly key: Buffer,
    loaded: { entries: Map<string, SessionEntry>; revision: number },
  ) {
    this.entries = loaded.entries
    this.revision = loaded.revision
  }

  static async open(options: SessionStoreOptions): Promise<SessionStore> {
    const { path, key } = options
    const file = await readStoreFile(path)
    const loaded =
      file === undefined
        ? { entries: new Map<string, SessionEntry>(), revision: 0 }
        : parsePayload(decodeStoreFile(key, file, path), path)
    const store = new SessionStore(path, key, loaded)
    // Create the file right away when it is absent, so an unwritable volume or a broken mount
    // fails loud at boot rather than at some user's first sign-in hours later. Two servers booting
    // at once on an empty volume also settle here: the loser's first write hits the conflict check.
    if (file === undefined) await store.flush()
    return store
  }

  // The token guard's hot path: a synchronous in-process lookup, no ABS roundtrip (SPEC
  // section 8). Takes the token itself — hashing is the store's business (see hashToken).
  find(token: string): SessionEntry | undefined {
    return this.entries.get(hashToken(token))
  }

  list(): readonly SessionEntry[] {
    return [...this.entries.values()]
  }

  async create(token: string, record: SessionRecord): Promise<SessionEntry> {
    const entry = freezeEntry({
      tokenHash: hashToken(token),
      absUserId: record.absUserId,
      absUsername: record.absUsername,
      chain: { ...record.chain },
      createdAt: new Date().toISOString(),
    })
    await this.mutate((entries) => {
      entries.set(entry.tokenHash, entry)
      return true
    })
    return entry
  }

  // Sign-out: the token is dead the moment the entry is gone. Reports whether there was
  // anything to delete, so the caller can stay idempotent on an unknown token.
  async delete(token: string): Promise<boolean> {
    const tokenHash = hashToken(token)
    return this.mutate((entries) => entries.delete(tokenHash))
  }

  // Record a refreshed ABS chain against an entry obtained from find()/list(). False means the
  // entry is gone — the device signed out while its chain was being refreshed, and re-adding it
  // would resurrect a revoked token.
  async updateChain(entry: SessionEntry, chain: AbsChain): Promise<boolean> {
    return this.mutate((entries) => {
      const current = entries.get(entry.tokenHash)
      if (current === undefined) return false
      entries.set(entry.tokenHash, freezeEntry({ ...current, chain: { ...chain } }))
      return true
    })
  }

  // Every mutation funnels through here: queued behind the previous write, and rolled back if
  // the write fails. Memory must never hold a session the file does not, or the next restart
  // would sign that device out with nobody having seen an error.
  private mutate(change: (entries: Map<string, SessionEntry>) => boolean): Promise<boolean> {
    return this.enqueue(async () => {
      const snapshot = new Map(this.entries)
      if (!change(this.entries)) return false
      try {
        await this.flush()
      } catch (err) {
        this.entries = snapshot
        throw err
      }
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

  private async flush(): Promise<void> {
    await this.assertNobodyElseWrote()
    const revision = this.revision + 1
    const payload = Buffer.from(JSON.stringify({ revision, entries: [...this.entries.values()] }), 'utf8')
    await writeFileAtomic(this.path, encodeStoreFile(this.key, payload))
    this.revision = revision
  }

  // Optimistic concurrency check: re-read the file and compare its revision against what this
  // server left there. Costs one small read and decrypt per write — writes are sign-ins, sign-outs
  // and the daily keep-alive, so that is free in practice.
  //
  // This narrows the window rather than closing it: another writer could still publish between
  // this check and the rename below. Closing it would need a lock, and a lock file outlives a
  // SIGKILL — a stale one would stop the server from booting at all, which is a worse failure for
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

// Only the hash of the Ratatoskr token is ever stored (SPEC section 8), so even a full store +
// key leak cannot reproduce the credential the app holds. Hashing lives inside the store rather
// than in its callers, so no caller can persist a raw token by mistake. A plain digest is right
// here, not a password hash: the token is 256 bits of entropy, so there is nothing to
// brute-force and no low-entropy secret for a salt to protect.
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function freezeEntry(entry: SessionEntry): SessionEntry {
  Object.freeze(entry.chain)
  return Object.freeze(entry)
}

async function readStoreFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new SessionStoreIoError(path, { cause })
  }
}

function parsePayload(plaintext: Buffer, path: string): { entries: Map<string, SessionEntry>; revision: number } {
  let payload: unknown
  try {
    payload = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new SessionStoreCorruptError(path, 'the decrypted payload is not valid JSON')
  }
  const { entries: list, revision } = (payload ?? {}) as { entries?: unknown; revision?: unknown }
  if (!Array.isArray(list)) {
    throw new SessionStoreCorruptError(path, 'the decrypted payload carries no entry list')
  }
  const entries = new Map<string, SessionEntry>()
  for (const candidate of list) {
    const entry = asEntry(candidate)
    if (entry === undefined) {
      throw new SessionStoreCorruptError(path, 'the decrypted payload contains a malformed entry')
    }
    entries.set(entry.tokenHash, entry)
  }
  // A payload without a revision counts as zero, so the very first write after this counter was
  // introduced does not read as somebody else's work.
  return { entries, revision: typeof revision === 'number' ? revision : 0 }
}

// Validate the shape rather than trusting our own past writes: the alternative is a malformed
// entry surfacing as an obscure TypeError somewhere in the auth path. Only known fields are
// carried over, so anything added here later must be optional to stay readable both ways.
function asEntry(candidate: unknown): SessionEntry | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const { tokenHash, absUserId, absUsername, createdAt, chain } = candidate as Record<string, unknown>
  if (![tokenHash, absUserId, absUsername, createdAt].every(isNonEmptyString)) return undefined
  if (typeof chain !== 'object' || chain === null) return undefined
  const { accessToken, refreshToken } = chain as Record<string, unknown>
  if (!isNonEmptyString(accessToken) || !isNonEmptyString(refreshToken)) return undefined
  return freezeEntry({
    tokenHash: tokenHash as string,
    absUserId: absUserId as string,
    absUsername: absUsername as string,
    createdAt: createdAt as string,
    chain: { accessToken, refreshToken },
  })
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}
