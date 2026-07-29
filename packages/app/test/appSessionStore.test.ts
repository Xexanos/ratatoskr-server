import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { buildApp, type BuildAppOptions } from '../src/api/app.js'
import { SessionStoreKeyError, SessionStoreWriteError } from '../src/auth/errors.js'
import type { SonosClient } from '../src/sonos/client.js'
import { testConfig } from './helpers/testConfig.js'

// Opening the store is part of startup wiring, not of the first sign-in (SPEC section 8): a wrong key
// or an unwritable volume has to stop the boot, while the operator is watching, rather than surface
// hours later as one user's failed login. These tests are about that timing, and they are the only
// ones that exercise the store buildApp builds from config — everywhere else injects one.
const KEY = Buffer.alloc(32, 0x11)
const OTHER_KEY = Buffer.alloc(32, 0x22)

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rtk-boot-'))
  path = join(dir, 'sessions.enc')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// No sessionStore among the options on purpose — the store built from config is the subject here.
const FAKES: BuildAppOptions = {
  absClient: {
    login: vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r', user: { id: 'usr-1', username: 'listener' } })),
    logout: vi.fn(async () => undefined),
  } as unknown as AbsClient,
  sonosClient: {} as SonosClient,
}

describe('buildApp session store wiring', () => {
  it('opens the configured store at startup, creating the file when it is absent', async () => {
    const app = await buildApp(testConfig({ sessionStorePath: path, sessionStoreKey: KEY }), FAKES)

    // The file exists before any request has been served — an unwritable volume fails here.
    expect((await stat(path)).isFile()).toBe(true)
    await app.close()
  })

  // A mistyped SESSION_STORE_PATH is the likeliest way to get this wrong, and it must arrive as a
  // SessionStoreError so main.ts prints one actionable line instead of a raw ENOENT stack.
  it('refuses to start when the store file cannot be written', async () => {
    const missing = join(dir, 'no-such-directory', 'sessions.enc')
    const failure = await buildApp(testConfig({ sessionStorePath: missing, sessionStoreKey: KEY }), FAKES).catch(
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(SessionStoreWriteError)
    expect((failure as Error).message).toContain(missing)
  })

  it('refuses to start when the store cannot be decrypted with the configured key', async () => {
    const first = await buildApp(testConfig({ sessionStorePath: path, sessionStoreKey: KEY }), FAKES)
    await first.close()

    await expect(
      buildApp(testConfig({ sessionStorePath: path, sessionStoreKey: OTHER_KEY }), FAKES),
    ).rejects.toBeInstanceOf(SessionStoreKeyError)
  })

  // The hard requirement the store exists for, through the config path rather than an injected store:
  // a token minted before a restart still works after it.
  it('keeps a device signed in across a restart', async () => {
    const config = testConfig({ sessionStorePath: path, sessionStoreKey: KEY })
    const first = await buildApp(config, FAKES)
    const login = await first.inject({
      method: 'POST',
      url: '/v2/auth/login',
      payload: { username: 'listener', password: 's3cret' },
    })
    expect(login.statusCode).toBe(200)
    await first.close()

    // A second process reading the same file: the token minted before the restart still resolves,
    // which sign-out answering 204 rather than a fresh 401 is what demonstrates.
    const second = await buildApp(config, FAKES)
    const res = await second.inject({
      method: 'POST',
      url: '/v2/auth/logout',
      headers: { authorization: `Bearer ${login.json().token as string}` },
    })
    expect(res.statusCode).toBe(204)
    await second.close()
  })
})
