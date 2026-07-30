import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../src/auth/sessionStore.js'

// The mode heal's failure path (ADR-0003): chmod is the file owner's privilege, so a store left
// root-owned by a root-driven restore cannot be healed by the server's own uid. That EPERM is not
// reproducible in a test without root - a file's owner cannot be changed by whoever runs the
// suite - so the denial is injected at the fs seam instead, the same trick sessionStoreWriteRetry
// uses one layer up.
const io = vi.hoisted(() => ({ denyChmod: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    chmod: vi.fn(async (path: Parameters<typeof real.chmod>[0], mode: Parameters<typeof real.chmod>[1]) => {
      if (io.denyChmod) {
        throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${String(path)}'`), { code: 'EPERM' })
      }
      return real.chmod(path, mode)
    }),
  }
})

const KEY = Buffer.alloc(32, 0xa1)
const PHONE = {
  absUserId: 'usr-1',
  absUsername: 'listener',
  chain: { accessToken: 'abs-access-phone', refreshToken: 'abs-refresh-phone' },
}

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rtk-sessions-heal-'))
  path = join(dir, 'sessions.enc')
  io.denyChmod = false
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

// Both cases below stage a widened file, which on Windows is neither expressible nor checked -
// the heal is a deliberate no-op there (see sessionFile.ts).
describe('SessionStore mode heal', () => {
  it.skipIf(process.platform === 'win32')('boots on a file it cannot chmod, saying the heal failed', async () => {
    await (await SessionStore.open({ path, key: KEY })).create('token-phone', PHONE)
    await chmod(path, 0o644)
    io.denyChmod = true
    const warnings: string[] = []

    const store = await SessionStore.open({ path, key: KEY, onWarning: (message) => warnings.push(message) })

    // Boot went through and the store works - the widened mode is worth a warning, not an outage.
    expect(store.find('token-phone')).toBeDefined()
    expect((await stat(path)).mode & 0o777).toBe(0o644)
    expect(warnings).toHaveLength(1)
    // Distinct from the healed message: this one asks the operator to act.
    expect(warnings[0]).toMatch(/could not/)
    expect(warnings[0]).toContain('0644')
    expect(warnings[0]).toContain(path)
  })

  it.skipIf(process.platform === 'win32')('warns via console when no other channel is wired', async () => {
    await (await SessionStore.open({ path, key: KEY })).create('token-phone', PHONE)
    await chmod(path, 0o644)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await SessionStore.open({ path, key: KEY })

    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('restored mode 0600'))
  })
})
