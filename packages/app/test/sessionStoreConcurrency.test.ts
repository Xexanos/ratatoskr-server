import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStoreWriteError } from '../src/auth/errors.js'
import { decodeStoreFile } from '../src/auth/sessionFile.js'

// A scripted gate around the store's atomic write, so a mutation can be parked mid-flush while
// find() is interrogated in exactly the window the swap-after-flush fix closes. arm() takes one
// step per write attempt the mutation will make; the store's bounded retry (WRITE_ATTEMPTS) is why
// a single flush can make more than one:
//   'pass'      run the real atomic write (also the default once the script is spent)
//   'transient' throw a SessionStoreWriteError, the retryable failure the retry loop swallows
//   'gate'      park until the test releases it, then either write for real or throw
// Anything not scripted — open()'s file-creating write above all — runs the real write untouched.
const gate = vi.hoisted(() => {
  type Step = 'pass' | 'transient' | 'gate'
  let steps: Step[] = []
  let markEntered: (() => void) | undefined
  let entered: Promise<void> = Promise.resolve()
  let release: ((outcome: 'pass' | 'fail') => void) | undefined
  let released: Promise<'pass' | 'fail'> | undefined
  return {
    // Script the next write's attempts. Called before the mutation under test.
    arm(program: Step[]): void {
      steps = [...program]
      entered = new Promise<void>((resolve) => {
        markEntered = resolve
      })
      released = new Promise<'pass' | 'fail'>((resolve) => {
        release = resolve
      })
    },
    // The mock delegates each write attempt here.
    async run(realWrite: () => Promise<void>): Promise<void> {
      const step = steps.shift() ?? 'pass'
      if (step === 'transient') {
        throw new SessionStoreWriteError('gated', { cause: new Error('transient write blip') })
      }
      if (step === 'gate') {
        markEntered?.()
        // A non-transient error, so writeWithRetry gives up at once rather than looping.
        if ((await released) === 'fail') throw new Error('injected write failure')
      }
      return realWrite()
    },
    // Resolves once a 'gate' step is reached — change() has run, the write has not returned.
    entered(): Promise<void> {
      return entered
    },
    // Let the parked write proceed to the real atomic write, so it lands on disk.
    letThrough(): void {
      release?.('pass')
    },
    // Fail the parked write outright.
    fail(): void {
      release?.('fail')
    },
    reset(): void {
      steps = []
      markEntered = undefined
      release = undefined
      entered = Promise.resolve()
      released = undefined
    },
  }
})

vi.mock('../src/auth/sessionFile.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/auth/sessionFile.js')>()
  return {
    ...actual,
    writeFileAtomic: (path: string, bytes: Buffer): Promise<void> =>
      gate.run(() => actual.writeFileAtomic(path, bytes)),
  }
})

// Imported after the mock is registered, so the store binds to the gated writeFileAtomic.
const { SessionStore } = await import('../src/auth/sessionStore.js')

const KEY = Buffer.alloc(32, 0xa1)

const PHONE = {
  absUserId: 'usr-1',
  absUsername: 'listener',
  chain: { accessToken: 'abs-access-phone', refreshToken: 'abs-refresh-phone' },
}

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rtk-sessions-conc-'))
  path = join(dir, 'sessions.enc')
})

afterEach(async () => {
  gate.reset()
  await rm(dir, { recursive: true, force: true })
})

function open() {
  return SessionStore.open({ path, key: KEY })
}

async function storedTokenHashes(): Promise<string[]> {
  const payload = decodeStoreFile(KEY, await readFile(path), path).toString('utf8')
  const { devices } = JSON.parse(payload) as { devices: { tokenHash: string }[] }
  return devices.map((device) => device.tokenHash)
}

describe('SessionStore in-flight visibility', () => {
  it('does not expose a new entry while its write is still in flight', async () => {
    const store = await open()
    gate.arm(['gate'])

    const creating = store.create('token-phone', PHONE)
    await gate.entered()

    // The write is parked: change() has run, flush() has not returned. find() must not authenticate
    // a session the file does not yet hold — the invariant the swap-after-flush fix keeps.
    expect(store.find('token-phone')).toBeUndefined()
    expect(store.list()).toEqual([])

    gate.letThrough()
    const entry = await creating
    expect(store.find('token-phone')).toEqual(entry)
    expect(await storedTokenHashes()).toEqual([entry.tokenHash])
  })

  it('never exposes an entry whose in-flight write then fails', async () => {
    const store = await open()
    gate.arm(['gate'])

    const creating = store.create('token-phone', PHONE)
    await gate.entered()
    expect(store.find('token-phone')).toBeUndefined()

    gate.fail()
    await expect(creating).rejects.toThrow(/injected write failure/)

    // The failed write left the live map untouched — there was never anything to roll back.
    expect(store.find('token-phone')).toBeUndefined()
    expect(store.list()).toEqual([])
    expect(await storedTokenHashes()).toEqual([])
  })

  it('holds an in-flight change back from a concurrent mutation until its write lands', async () => {
    const store = await open()
    const first = await store.create('token-phone', PHONE)
    gate.arm(['gate'])

    // A refresh of the first chain, parked mid-write. A second device signing in queues behind it.
    const refreshing = store.updateChain(first, {
      accessToken: 'abs-access-next',
      refreshToken: 'abs-refresh-next',
    })
    await gate.entered()

    // While the refresh write is in flight, find() still sees the old chain, not the pending one.
    expect(store.find('token-phone')?.chain.accessToken).toBe('abs-access-phone')

    gate.letThrough()
    expect(await refreshing).toBe(true)
    expect(store.find('token-phone')?.chain.accessToken).toBe('abs-access-next')

    // The queued second write builds on the refreshed map, so both survive a reopen.
    await store.create('token-tablet', {
      absUserId: 'usr-1',
      absUsername: 'listener',
      chain: { accessToken: 'abs-access-tablet', refreshToken: 'abs-refresh-tablet' },
    })
    expect((await open()).list()).toHaveLength(2)
  })

  it('keeps a change invisible across the whole retry loop, surfacing it only once a retry lands', async () => {
    const store = await open()
    // Two transient write failures, then the write is parked on the third and final attempt. By the
    // time we inspect, the bounded retry has already been through both failures and their backoffs —
    // the window commit bc8df93 widened, where memory used to roll back only after retries exhaust.
    gate.arm(['transient', 'transient', 'gate'])

    const creating = store.create('token-phone', PHONE)
    await gate.entered()

    // Nothing has landed on disk across the retries, so find() must still not see the entry.
    expect(store.find('token-phone')).toBeUndefined()
    expect(await storedTokenHashes()).toEqual([])

    gate.letThrough()
    const entry = await creating
    expect(store.find('token-phone')).toEqual(entry)
    expect(await storedTokenHashes()).toEqual([entry.tokenHash])
  })
})
