import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SessionStoreConflictError,
  SessionStoreCorruptError,
  SessionStoreKeyError,
  SessionStoreWriteError,
} from '../src/auth/errors.js'
import { decodeStoreFile, encodeStoreFile } from '../src/auth/sessionFile.js'
import { chainRefreshedAt, SessionStore } from '../src/auth/sessionStore.js'

const KEY = Buffer.alloc(32, 0xa1)
const OTHER_KEY = Buffer.alloc(32, 0xb2)

// Two device logins of the same ABS user - the "one chain per user, shared by every device"
// invariant (SPEC section 8, ADR-0004) is what most of these tests are about. Each supplies its own
// freshly minted chain, but only the first user's install takes: the second device rides the chain
// already there, and the chain it brought is ignored (a throwaway the caller ends upstream).
const PHONE = {
  absUserId: 'usr-1',
  absUsername: 'listener',
  chain: { accessToken: 'abs-access-phone', refreshToken: 'abs-refresh-phone' },
}
const TABLET = {
  absUserId: 'usr-1',
  absUsername: 'listener',
  chain: { accessToken: 'abs-access-tablet', refreshToken: 'abs-refresh-tablet' },
}
// A second ABS user, so a test that wants two genuinely distinct chains can have them.
const OTHER = {
  absUserId: 'usr-2',
  absUsername: 'other',
  chain: { accessToken: 'abs-access-other', refreshToken: 'abs-refresh-other' },
}

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rtk-sessions-'))
  path = join(dir, 'sessions.enc')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function open(key: Buffer = KEY): Promise<SessionStore> {
  return SessionStore.open({ path, key })
}

// The plaintext as it sits inside the encrypted file - used to assert what is (and is not)
// persisted, which is the store's central security property.
async function storedPayload(): Promise<string> {
  return decodeStoreFile(KEY, await readFile(path), path).toString('utf8')
}

// A correctly encrypted file around an arbitrary payload, for the malformed-content cases.
async function writePayload(payload: unknown): Promise<void> {
  await writeFile(path, encodeStoreFile(KEY, Buffer.from(JSON.stringify(payload), 'utf8')))
}

// One device and its chain exactly as they are persisted (the two-list on-disk shape of ADR-0004).
const STORED_DEVICE = {
  tokenHash: 'a'.repeat(64),
  absUserId: 'usr-1',
  createdAt: '2026-07-28T09:00:00.000Z',
}
const STORED_CHAIN = {
  absUserId: 'usr-1',
  absUsername: 'listener',
  chain: { accessToken: 'abs-access-phone', refreshToken: 'abs-refresh-phone' },
  chainRefreshedAt: '2026-07-28T09:00:00.000Z',
}
// The joined entry the store reads those two back as.
const STORED_ENTRY = {
  tokenHash: STORED_DEVICE.tokenHash,
  absUserId: 'usr-1',
  absUsername: 'listener',
  createdAt: STORED_DEVICE.createdAt,
  chain: STORED_CHAIN.chain,
  chainRefreshedAt: STORED_CHAIN.chainRefreshedAt,
}

describe('SessionStore', () => {
  it('starts empty and creates the file, so an unwritable volume fails at open, not at first login', async () => {
    const store = await open()
    expect(store.list()).toEqual([])
    await expect(stat(path)).resolves.toBeDefined()
  })

  // File mode is a POSIX concept; Windows ignores the mode argument entirely, so asserting it
  // there would test nothing.
  it.skipIf(process.platform === 'win32')('keeps the file at mode 0600 across rewrites', async () => {
    const store = await open()
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await store.create('token-phone', PHONE)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  // The mode heal (ADR-0003): 0600 is a standing invariant re-asserted at open, not a one-time
  // creation property - a cp/tar-without--p restore is the classic way a live store drifts to the
  // umask. Healed and warned, never a boot blocker.
  it.skipIf(process.platform === 'win32')('heals a widened file back to 0600 at open and says so', async () => {
    await (await open()).create('token-phone', PHONE)
    await chmod(path, 0o644)
    const warnings: string[] = []

    const healed = await SessionStore.open({ path, key: KEY, onWarning: (message) => warnings.push(message) })

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(healed.find('token-phone')).toBeDefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(path)
    expect(warnings[0]).toContain('0600')
  })

  // Only group/other bits are a leak. Owner-only-narrower is the operator's business: the atomic
  // replace never opens this file for writing, so even 0400 costs the server nothing.
  it.skipIf(process.platform === 'win32')('leaves a file narrowed below 0600 alone', async () => {
    await (await open()).create('token-phone', PHONE)
    await chmod(path, 0o400)
    const warnings: string[] = []

    await SessionStore.open({ path, key: KEY, onWarning: (message) => warnings.push(message) })

    expect((await stat(path)).mode & 0o777).toBe(0o400)
    expect(warnings).toEqual([])
  })

  // Meaningful on every platform, for opposite reasons: on POSIX a healthy 0600 file has nothing
  // to heal; on Windows the heal must be a no-op outright - stat there mirrors the owner bits onto
  // group/other, so an ungated check would cry wolf on every single boot.
  it('opens an already-owner-only store without a warning', async () => {
    await (await open()).create('token-phone', PHONE)
    const warnings: string[] = []

    await SessionStore.open({ path, key: KEY, onWarning: (message) => warnings.push(message) })

    expect(warnings).toEqual([])
  })

  it('survives a reopen with the chain and metadata intact', async () => {
    const store = await open()
    const created = await store.create('token-phone', PHONE)

    const reopened = await open()
    expect(reopened.find('token-phone')).toEqual(created)
    expect(reopened.find('token-phone')?.chain).toEqual(PHONE.chain)
    expect(reopened.find('token-phone')?.absUsername).toBe('listener')
    expect(Date.parse(created.createdAt)).not.toBeNaN()
  })

  it('persists only the token hash, never the token itself', async () => {
    const store = await open()
    const entry = await store.create('token-phone', PHONE)

    expect(entry.tokenHash).toBe(createHash('sha256').update('token-phone').digest('hex'))
    const payload = await storedPayload()
    expect(payload).not.toContain('token-phone')
    expect(payload).toContain(entry.tokenHash)
  })

  it('answers an unknown token with undefined', async () => {
    const store = await open()
    await store.create('token-phone', PHONE)
    expect(store.find('token-tablet')).toBeUndefined()
  })

  // The heart of ADR-0004: two devices of one user share a single chain, so there is only ever one
  // for the keep-alive loop to refresh - and the invariant that removes the ABS < 2.35.1 collision.
  it('shares one chain across every device of a user', async () => {
    const store = await open()
    const phone = await store.create('token-phone', PHONE)
    const tablet = await store.create('token-tablet', TABLET)

    // The tablet rides the chain the phone already installed; the chain it brought is ignored.
    expect(tablet.chain).toEqual(PHONE.chain)
    expect(phone.chain).toEqual(PHONE.chain)
    expect(store.listChains()).toHaveLength(1)
    // list() is still per device: two logins, two entries, one shared chain behind them.
    expect(store.list()).toHaveLength(2)
  })

  it('refreshing a user’s chain moves every device of that user to the new pair at once', async () => {
    const store = await open()
    const phone = await store.create('token-phone', PHONE)
    await store.create('token-tablet', TABLET)
    const rotated = { accessToken: 'abs-access-2', refreshToken: 'abs-refresh-2' }

    expect(await store.updateChain(phone, rotated)).toBe(true)

    expect(store.find('token-phone')?.chain).toEqual(rotated)
    expect(store.find('token-tablet')?.chain).toEqual(rotated)
  })

  it('keeps a shared chain alive until its last device signs out, ending it upstream only then', async () => {
    const store = await open()
    await store.create('token-phone', PHONE)
    await store.create('token-tablet', TABLET)

    // Signing one device out leaves the other listening on the still-live chain - nothing to end
    // upstream yet.
    const first = await store.delete('token-phone')
    expect(first).toEqual({ removed: true })
    expect(store.find('token-tablet')?.chain).toEqual(PHONE.chain)
    expect(store.listChains()).toHaveLength(1)

    // The last device takes the chain with it, handed back so its ABS session can be ended.
    const last = await store.delete('token-tablet')
    expect(last).toEqual({ removed: true, endedChain: PHONE.chain })
    expect(store.listChains()).toHaveLength(0)
    expect((await open()).list()).toHaveLength(0)
  })

  it('ends a solo device’s chain upstream the moment it signs out', async () => {
    const store = await open()
    await store.create('token-phone', PHONE)

    expect(await store.delete('token-phone')).toEqual({ removed: true, endedChain: PHONE.chain })
    expect(store.find('token-phone')).toBeUndefined()
  })

  it('leaves another user’s chain untouched when one user’s device signs out', async () => {
    const store = await open()
    await store.create('token-phone', PHONE)
    await store.create('token-other', OTHER)

    await store.delete('token-phone')

    expect(store.find('token-other')?.chain).toEqual(OTHER.chain)
    expect(store.listChains()).toHaveLength(1)
  })

  it('reports an unknown token on delete, so sign-out can stay idempotent', async () => {
    const store = await open()
    expect(await store.delete('token-phone')).toEqual({ removed: false })
  })

  it('replaces a stored chain in place when it is refreshed', async () => {
    const store = await open()
    const entry = await store.create('token-phone', PHONE)
    const rotated = { accessToken: 'abs-access-2', refreshToken: 'abs-refresh-2' }

    expect(await store.updateChain(entry, rotated)).toBe(true)
    expect((await open()).find('token-phone')?.chain).toEqual(rotated)
  })

  it('does not resurrect a chain whose last device signed out mid-refresh', async () => {
    const store = await open()
    const entry = await store.create('token-phone', PHONE)
    await store.delete('token-phone')

    expect(await store.updateChain(entry, { accessToken: 'a', refreshToken: 'r' })).toBe(false)
    expect((await open()).list()).toEqual([])
  })

  it('stamps a refreshed chain, so the boot sweep can tell how stale each one is', async () => {
    const store = await open()
    const entry = await store.create('token-phone', PHONE)
    // The stamp a fresh sign-in leaves is its creation time: nothing about that chain is older.
    expect(chainRefreshedAt(entry)).toBe(Date.parse(entry.createdAt))

    await store.updateChain(entry, { accessToken: 'abs-access-2', refreshToken: 'abs-refresh-2' })

    const refreshed = (await open()).find('token-phone')
    expect(chainRefreshedAt(refreshed!)).toBeGreaterThanOrEqual(chainRefreshedAt(entry))
  })

  // The keep-alive loop's rare-and-loud failure (SPEC section 8): the chain is gone, but its devices
  // stay so their next request can be told *which* 401 this is. Marking is per chain, so every device
  // of the user sees the death at once (ADR-0004).
  it('marks a chain dead while keeping its devices, across a reopen', async () => {
    const store = await open()
    const entry = await store.create('token-phone', PHONE)
    await store.create('token-tablet', TABLET)

    expect(await store.markDead(entry)).toBe(true)

    const reopened = await open()
    expect(reopened.find('token-phone')?.deadSince).toEqual(expect.any(String))
    expect(reopened.find('token-tablet')?.deadSince).toEqual(expect.any(String))
    expect(Date.parse(reopened.find('token-phone')!.deadSince!)).not.toBeNaN()
  })

  it('does not resurrect a chain whose last device signed out before it was marked dead', async () => {
    const store = await open()
    const entry = await store.create('token-phone', PHONE)
    await store.delete('token-phone')

    expect(await store.markDead(entry)).toBe(false)
    expect((await open()).list()).toEqual([])
  })

  it('serializes concurrent writes so no login is lost to a racing write', async () => {
    const store = await open()
    await Promise.all([
      store.create('token-1', PHONE),
      store.create('token-2', OTHER),
      store.create('token-3', PHONE),
    ])

    expect((await open()).list()).toHaveLength(3)
  })

  it('encrypts each write under a fresh nonce', async () => {
    const store = await open()
    await store.create('token-phone', PHONE)
    const first = await readFile(path)
    await store.updateChain(store.find('token-phone')!, PHONE.chain)
    const second = await readFile(path)

    expect(second.equals(first)).toBe(false)
    expect(await storedPayload()).toContain('abs-refresh-phone')
  })

  it('leaves no temporary file behind, so a store directory listing stays clean', async () => {
    const store = await open()
    await store.create('token-phone', PHONE)
    expect(await readdir(dir)).toEqual(['sessions.enc'])
  })

  // A foreign temp file stands in for another process mid-write: touching it (unlinking it, or
  // renaming it into place) is what would let one writer publish the other's unfinished file.
  it('never touches a temporary file it did not create', async () => {
    const foreign = `${path}.99999.tmp`
    const store = await open()
    await writeFile(foreign, 'another process, mid-write')
    await store.create('token-phone', PHONE)

    expect(await readFile(foreign, 'utf8')).toBe('another process, mid-write')
    expect((await open()).find('token-phone')).toBeDefined()
  })

  it('is unaffected by a temp file left at the old fixed name by a crashed peer', async () => {
    // The temp name is unique per write now (sessionFile.ts), so a file at the pre-fix fixed name -
    // what a peer sharing the volume left when it crashed mid-write, same PID in a container - is
    // neither reused nor removed. It must not block or corrupt the next write; it is a harmless
    // orphan, the accepted cost of never reaching for another writer's temp file.
    const leftover = `${path}.${process.pid}.tmp`
    const store = await open()
    await writeFile(leftover, 'half-written garbage')

    await store.create('token-phone', PHONE)

    expect((await open()).find('token-phone')).toBeDefined()
    expect((await readFile(leftover)).toString()).toBe('half-written garbage')
  })

  // Two SessionStore instances on one path are exactly what two server processes are: each loads
  // its own copy of every row, so whichever writes second would drop the other's sessions.
  it('refuses to overwrite a store another writer has advanced, keeping that writer’s entry', async () => {
    const first = await open()
    const second = await open()
    await second.create('token-tablet', OTHER)

    await expect(first.create('token-phone', PHONE)).rejects.toBeInstanceOf(SessionStoreConflictError)
    expect(first.find('token-phone')).toBeUndefined()
    const onDisk = await open()
    expect(onDisk.find('token-tablet')).toBeDefined()
    expect(onDisk.find('token-phone')).toBeUndefined()
  })

  it('points at SESSION_STORE_PATH in the conflict error, since sharing one file is the cause', async () => {
    const first = await open()
    await (await open()).create('token-tablet', OTHER)
    await expect(first.create('token-phone', PHONE)).rejects.toThrow(/another process|SESSION_STORE_PATH/)
  })

  it('refuses to write a store that vanished underneath it', async () => {
    const store = await open()
    await store.create('token-phone', PHONE)
    await rm(path)

    await expect(store.delete('token-phone')).rejects.toBeInstanceOf(SessionStoreConflictError)
  })

  it('bumps the revision on every write, so a foreign write is detectable at all', async () => {
    const store = await open()
    expect(JSON.parse(await storedPayload()).revision).toBe(1)
    await store.create('token-phone', PHONE)
    expect(JSON.parse(await storedPayload()).revision).toBe(2)
  })

  it('treats a payload without a revision as untouched, not as somebody else’s work', async () => {
    await writePayload({ devices: [STORED_DEVICE], chains: [STORED_CHAIN] })
    const store = await open()

    await expect(store.create('token-other', OTHER)).resolves.toBeDefined()
    expect((await open()).list()).toHaveLength(2)
  })

  it('refuses to open with the wrong key and leaves the file untouched', async () => {
    const store = await open()
    await store.create('token-phone', PHONE)
    const before = await readFile(path)

    await expect(open(OTHER_KEY)).rejects.toBeInstanceOf(SessionStoreKeyError)
    expect((await readFile(path)).equals(before)).toBe(true)
    expect((await open()).find('token-phone')).toBeDefined()
  })

  it('names SESSION_STORE_KEY in the wrong-key error, so the operator knows what to fix', async () => {
    await (await open()).create('token-phone', PHONE)
    await expect(open(OTHER_KEY)).rejects.toThrow(/SESSION_STORE_KEY/)
  })

  // GCM authenticates the ciphertext (and the format header, via AAD), so a single flipped byte in
  // an otherwise-valid file fails the tag check - indistinguishable from a wrong key, and refused
  // the same way rather than read back as partially valid.
  it('refuses a file whose ciphertext was modified, the same as a wrong key', async () => {
    await (await open()).create('token-phone', PHONE)
    const file = await readFile(path)
    const last = file.length - 1
    file[last] = (file[last] ?? 0) ^ 1 // flip the last ciphertext byte
    await writeFile(path, file)

    await expect(open()).rejects.toBeInstanceOf(SessionStoreKeyError)
  })

  it('refuses to open a file that is not a session store', async () => {
    await writeFile(path, Buffer.alloc(200, 0x7))
    await expect(open()).rejects.toBeInstanceOf(SessionStoreCorruptError)
  })

  it('refuses to open a truncated file rather than starting empty', async () => {
    await (await open()).create('token-phone', PHONE)
    const full = await readFile(path)
    await writeFile(path, full.subarray(0, 20))

    await expect(open()).rejects.toBeInstanceOf(SessionStoreCorruptError)
  })

  // The store is opened at boot (main.ts), and open() creates its file when absent - so a
  // mistyped SESSION_STORE_PATH or a volume this user cannot write to surfaces here, as a
  // SessionStoreError with an actionable message, rather than as a raw ENOENT stack.
  it('refuses to open when its file cannot be written, naming the path and its directory', async () => {
    const failure = await SessionStore.open({ path: join(dir, 'not-a-directory', 'sessions.enc'), key: KEY }).catch(
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(SessionStoreWriteError)
    expect((failure as Error).message).toContain(join(dir, 'not-a-directory', 'sessions.enc'))
    expect((failure as Error).message).toContain('SESSION_STORE_PATH')
    // The underlying errno is kept as the cause, so the log still says which syscall failed.
    expect((failure as Error).cause).toBeDefined()
  })

  // These payloads authenticate under the right key but are not a store - reachable only by a
  // format change or a bug on the write side (see asDevice/asChain for why the shape is checked).
  it('refuses a decrypted payload that is not JSON', async () => {
    await writeFile(path, encodeStoreFile(KEY, Buffer.from('not json at all', 'utf8')))
    await expect(open()).rejects.toThrow(/not valid JSON/)
  })

  it('refuses a decrypted payload without the device and chain lists', async () => {
    await writePayload({ sessions: [] })
    await expect(open()).rejects.toThrow(/no device and chain lists/)
  })

  it('refuses a device that references a chain the store does not hold', async () => {
    await writePayload({ revision: 1, devices: [STORED_DEVICE], chains: [] })
    await expect(open()).rejects.toThrow(/device with no chain/)
  })

  it.each([
    ['not an object', 'nope'],
    ['a missing field', { ...STORED_DEVICE, absUserId: undefined }],
    ['an empty field', { ...STORED_DEVICE, tokenHash: '' }],
  ])('refuses a device that is %s', async (_case, device) => {
    await writePayload({ devices: [device], chains: [STORED_CHAIN] })
    await expect(open()).rejects.toBeInstanceOf(SessionStoreCorruptError)
  })

  it.each([
    ['not an object', 'nope'],
    ['a missing field', { ...STORED_CHAIN, absUsername: undefined }],
    ['no refreshed stamp', { ...STORED_CHAIN, chainRefreshedAt: undefined }],
    ['no chain', { ...STORED_CHAIN, chain: null }],
    ['half a chain', { ...STORED_CHAIN, chain: { accessToken: 'abs-access' } }],
  ])('refuses a chain that has %s', async (_case, chain) => {
    await writePayload({ devices: [STORED_DEVICE], chains: [chain] })
    await expect(open()).rejects.toBeInstanceOf(SessionStoreCorruptError)
  })

  it('loads a hand-written store, pinning the on-disk shape the store reads back', async () => {
    await writePayload({ devices: [STORED_DEVICE], chains: [STORED_CHAIN] })
    expect((await open()).list()).toEqual([STORED_ENTRY])
  })

  it('reports a store path that cannot be read at all', async () => {
    path = dir
    await expect(open()).rejects.toThrow(/could not be read/)
  })

  it('rolls back an entry whose write failed, so memory never claims an unpersisted session', async () => {
    const store = await open()
    // Take the store's directory out from under it, so persisting the next change cannot proceed - a
    // stand-in for a volume that filled up or vanished. (The old injection pre-created the temp file
    // at a fixed per-process name; the name is randomised now, so break the directory instead.)
    await rm(dir, { recursive: true, force: true })

    await expect(store.create('token-phone', PHONE)).rejects.toThrow()
    expect(store.find('token-phone')).toBeUndefined()
    expect(store.list()).toEqual([])
  })

  it('refuses to open a file written in an unknown format version', async () => {
    await (await open()).create('token-phone', PHONE)
    const file = await readFile(path)
    file.write('RTKSESS9', 0, 'ascii')
    await writeFile(path, file)

    await expect(open()).rejects.toThrow(/version/i)
  })
})
