import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStoreConflictError, SessionStoreCorruptError, SessionStoreKeyError } from '../src/auth/errors.js'
import { decodeStoreFile, encodeStoreFile } from '../src/auth/sessionFile.js'
import { SessionStore } from '../src/auth/sessionStore.js'

const KEY = Buffer.alloc(32, 0xa1)
const OTHER_KEY = Buffer.alloc(32, 0xb2)

// Two device logins of the same ABS user — the "one ABS chain per device, never shared"
// invariant (SPEC section 8) is what most of these tests are about.
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

// The plaintext as it sits inside the encrypted file — used to assert what is (and is not)
// persisted, which is the store's central security property.
async function storedPayload(): Promise<string> {
  return decodeStoreFile(KEY, await readFile(path), path).toString('utf8')
}

// A correctly encrypted file around an arbitrary payload, for the malformed-content cases.
async function writePayload(payload: unknown): Promise<void> {
  await writeFile(path, encodeStoreFile(KEY, Buffer.from(JSON.stringify(payload), 'utf8')))
}

// One entry exactly as it is persisted.
const STORED = {
  tokenHash: 'a'.repeat(64),
  absUserId: 'usr-1',
  absUsername: 'listener',
  createdAt: '2026-07-28T09:00:00.000Z',
  chain: { accessToken: 'abs-access-phone', refreshToken: 'abs-refresh-phone' },
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

  it('keeps one chain per device, so signing one device out leaves the other untouched', async () => {
    const store = await open()
    await store.create('token-phone', PHONE)
    await store.create('token-tablet', TABLET)

    expect(await store.delete('token-phone')).toBe(true)
    expect(store.find('token-phone')).toBeUndefined()
    expect(store.find('token-tablet')?.chain).toEqual(TABLET.chain)
    expect((await open()).list()).toHaveLength(1)
  })

  it('reports an unknown token on delete, so sign-out can stay idempotent', async () => {
    const store = await open()
    expect(await store.delete('token-phone')).toBe(false)
  })

  it('replaces a stored chain in place when it is refreshed', async () => {
    const store = await open()
    const entry = await store.create('token-phone', PHONE)
    const rotated = { accessToken: 'abs-access-2', refreshToken: 'abs-refresh-2' }

    expect(await store.updateChain(entry, rotated)).toBe(true)
    expect((await open()).find('token-phone')?.chain).toEqual(rotated)
  })

  it('does not resurrect an entry whose device signed out mid-refresh', async () => {
    const store = await open()
    const entry = await store.create('token-phone', PHONE)
    await store.delete('token-phone')

    expect(await store.updateChain(entry, { accessToken: 'a', refreshToken: 'r' })).toBe(false)
    expect((await open()).list()).toEqual([])
  })

  it('serializes concurrent writes so no login is lost to a racing write', async () => {
    const store = await open()
    await Promise.all([
      store.create('token-1', PHONE),
      store.create('token-2', TABLET),
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

  it('cleans up its own temporary file left behind by a crash mid-write', async () => {
    const own = `${path}.${process.pid}.tmp`
    const store = await open()
    await writeFile(own, 'half-written garbage')
    await store.create('token-phone', PHONE)

    expect(await readdir(dir)).toEqual(['sessions.enc'])
    expect((await open()).find('token-phone')).toBeDefined()
  })

  // Two SessionStore instances on one path are exactly what two server processes are: each loads
  // its own copy of every entry, so whichever writes second would drop the other's sessions.
  it('refuses to overwrite a store another writer has advanced, keeping that writer’s entry', async () => {
    const first = await open()
    const second = await open()
    await second.create('token-tablet', TABLET)

    await expect(first.create('token-phone', PHONE)).rejects.toBeInstanceOf(SessionStoreConflictError)
    expect(first.find('token-phone')).toBeUndefined()
    const onDisk = await open()
    expect(onDisk.find('token-tablet')).toBeDefined()
    expect(onDisk.find('token-phone')).toBeUndefined()
  })

  it('points at SESSION_STORE_PATH in the conflict error, since sharing one file is the cause', async () => {
    const first = await open()
    await (await open()).create('token-tablet', TABLET)
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
    await writePayload({ entries: [STORED] })
    const store = await open()

    await expect(store.create('token-phone', PHONE)).resolves.toBeDefined()
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

  // These payloads authenticate under the right key but are not a store — reachable only by a
  // format change or a bug on the write side (see asEntry for why the shape is checked at all).
  it('refuses a decrypted payload that is not JSON', async () => {
    await writeFile(path, encodeStoreFile(KEY, Buffer.from('not json at all', 'utf8')))
    await expect(open()).rejects.toThrow(/not valid JSON/)
  })

  it('refuses a decrypted payload without an entry list', async () => {
    await writePayload({ sessions: [] })
    await expect(open()).rejects.toThrow(/no entry list/)
  })

  it.each([
    ['not an object', 'nope'],
    ['a missing field', { ...STORED, absUsername: undefined }],
    ['an empty field', { ...STORED, tokenHash: '' }],
    ['no chain', { ...STORED, chain: null }],
    ['half a chain', { ...STORED, chain: { accessToken: 'abs-access' } }],
  ])('refuses an entry with %s', async (_case, entry) => {
    await writePayload({ entries: [entry] })
    await expect(open()).rejects.toBeInstanceOf(SessionStoreCorruptError)
  })

  it('loads a hand-written entry, pinning the on-disk shape the store reads back', async () => {
    await writePayload({ entries: [STORED] })
    expect((await open()).list()).toEqual([STORED])
  })

  it('reports a store path that cannot be read at all', async () => {
    path = dir
    await expect(open()).rejects.toThrow(/could not be read/)
  })

  it('rolls back an entry whose write failed, so memory never claims an unpersisted session', async () => {
    const store = await open()
    // A directory where the temp file has to go: the revision check passes and the store file is
    // intact, but the write itself cannot proceed — a stand-in for a full or read-only volume.
    await mkdir(`${path}.${process.pid}.tmp`)

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
