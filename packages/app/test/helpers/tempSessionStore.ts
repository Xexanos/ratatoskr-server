import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import { SessionStore } from '../../src/auth/sessionStore.js'

// The real store on a throwaway file, removed when the test finishes. A fake would have to
// re-implement the one property everything here depends on — that the store keys entries by the
// token's hash and hands the raw token back to nobody (SPEC section 8) — so the tests use the
// genuine article; it is a single small file write per mutation.
const TEST_KEY = Buffer.alloc(32, 0x5a)

export async function tempSessionStore(): Promise<SessionStore> {
  const dir = await mkdtemp(join(tmpdir(), 'rtk-store-'))
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return SessionStore.open({ path: join(dir, 'sessions.enc'), key: TEST_KEY })
}
