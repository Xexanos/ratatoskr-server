import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  assertServerBuilt,
  cleanEnv,
  freePort,
  readSessionStore,
  sessionStoreEnv,
  signIn,
  spawnServer,
  stopServer,
  waitUntilReady,
  type SpawnedServer,
  type StoredEntry,
} from './helpers.js'
import { createAbsUser, createStreamerApiKey, deleteAbsUser } from './absSeed.js'

// The keep-alive loop against a live Audiobookshelf (SPEC section 8 / ADR-0001), at the process level.
// Its two outcomes — a stored chain renewed before its refresh token ages out, and a chain marked
// dead when ABS refuses it — exist only in unit tests otherwise; KEEP_ALIVE_REFRESH_INTERVAL_MS was
// added expressly so a test deployment could provoke them by running the sweep on a short clock
// instead of the daily one (issue #166). Here the compiled server runs with that interval down at a
// couple of seconds, and the store it maintains is decrypted off disk to watch both happen.
//
// Neither shows on the /v2 surface, which is the whole point of the model (the device never sees an
// ABS token): the renewal rotates a credential the client never holds, and the death is only visible
// as the 401 the *next* request earns. So the store, read with the key this test handed the server,
// is the one place from outside where the loop's work is observable.

const abs = inject('absLive')

// This file's own ABS users (per-file isolation on the shared container). The end user's chain is the
// one renewed and then killed; the streamer only exists because the server logs it in at boot.
const KA_USER = 'it-keepalive-user'
const KA_PASS = 'it-keepalive-pass'
const KA_STREAMER = 'it-keepalive-streamer'
const KA_STREAMER_PASS = 'it-keepalive-streamer-pass'

// The sweep clock. Short so a chain is renewed several times within a test's patience, and comfortably
// above the loop's CHAIN_SPACING_MS (1500) so this file's single chain is never made to wait out the
// inter-chain gap before its own refresh.
const REFRESH_INTERVAL_MS = 2000

describe.skipIf(abs === null)(`keep-alive against live Audiobookshelf [${abs?.imageLabel ?? 'skipped: no Docker'}]`, () => {
  let server: SpawnedServer | undefined
  let serverBase = ''
  let storePath = ''
  let storeKey = ''
  let v2Token = ''
  // The chain as it stood right after sign-in, before any sweep — the yardstick the renewal is measured
  // against.
  let baseline: StoredEntry

  const bearer = (): Record<string, string> => ({ authorization: `Bearer ${v2Token}` })

  // Poll the on-disk store until this file's one entry satisfies `ready`, then return it. The loop's
  // effects land asynchronously (a sweep every REFRESH_INTERVAL_MS), so every assertion waits for the
  // store to show the change rather than sleeping a guessed amount. A read that catches the file
  // mid-rename, or any transient FS error, just retries.
  async function waitForEntry(ready: (entry: StoredEntry) => boolean, timeoutMs = 30_000): Promise<StoredEntry> {
    const deadline = Date.now() + timeoutMs
    let last: StoredEntry | undefined
    while (Date.now() < deadline) {
      try {
        const entry = readSessionStore(storePath, storeKey).find((e) => e.absUsername === KA_USER)
        if (entry !== undefined) {
          last = entry
          if (ready(entry)) return entry
        }
      } catch {
        // a read that raced the store's atomic rename, or a momentary FS hiccup — try again
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`store entry did not reach the expected state within ${timeoutMs}ms (last: ${JSON.stringify(last)})`)
  }

  beforeAll(async () => {
    assertServerBuilt()
    const { absBase, adminToken } = abs!

    await createAbsUser(absBase, adminToken, KA_USER, KA_PASS)
    const streamerApiKey = await createStreamerApiKey(absBase, adminToken, KA_STREAMER, KA_STREAMER_PASS)

    const port = await freePort()
    serverBase = `http://127.0.0.1:${port}`
    const store = sessionStoreEnv()
    storePath = store.SESSION_STORE_PATH
    storeKey = store.SESSION_STORE_KEY
    server = spawnServer(
      cleanEnv({
        ABS_URL: absBase,
        ABS_ALLOW_PLAIN_HTTP: 'true',
        ABS_STREAMER_API_KEY: streamerApiKey,
        ALLOW_PLAIN_HTTP: 'true',
        // The one operator-reachable knob (SPEC section 7): the sweep cadence, and the boot pass's
        // staleness cutoff with it. Short here so the renewal and the death arrive in seconds.
        KEEP_ALIVE_REFRESH_INTERVAL_MS: String(REFRESH_INTERVAL_MS),
        PORT: String(port),
        ...store,
      }),
    )
    await waitUntilReady(server, port)

    // One /v2 sign-in opens this device's private ABS chain and writes it to the store. create() awaits
    // the flush, so by the time this returns the file already carries the entry to read as the baseline.
    v2Token = await signIn(serverBase, KA_USER, KA_PASS)
    const entry = readSessionStore(storePath, storeKey).find((e) => e.absUsername === KA_USER)
    if (entry === undefined) throw new Error('the stored chain is missing right after sign-in')
    baseline = entry
  })

  afterAll(async () => {
    // The shared ABS container is stopped by globalSetup, not here.
    if (server) await stopServer(server)
  })

  it('renews the stored chain against the live ABS, invisibly to the device', async () => {
    // Wait on the refresh stamp, not on the token bytes: updateChain rewrites chainRefreshedAt on every
    // successful refresh and nothing else touches it, so its advance is the version-independent signal
    // that a sweep reached ABS and rewrote the store. Keying the poll on the access token instead would
    // ride the same second-precision-JWT hazard the loop's CHAIN_SPACING_MS guards against (keepAlive).
    const renewed = await waitForEntry((e) => refreshedAtMs(e) > refreshedAtMs(baseline))

    // And a fresh access token came back with it — the credential the next upstream call will carry,
    // not the one minted at sign-in. (Holds on every version; the renewal above is what proves it ran.)
    expect(renewed.chain.accessToken).not.toBe(baseline.chain.accessToken)
    // Whether the *refresh* token also rotates is version-dependent: ABS < 2.35.1 returns the same one,
    // >= 2.35.1 rotates it (the split absLive.integration pins). The renewal is already proven above,
    // so rotation is only noted, not required — a hard assertion here would fail the 2.26.0 matrix leg.

    // The device notices none of it: the opaque token it holds keeps working straight across the swap.
    const res = await fetch(`${serverBase}/v2/library/items`, { headers: bearer() })
    expect(res.status).toBe(200)
  })

  it('marks the chain dead and answers 401 UPSTREAM_SESSION_LOST once ABS refuses it', async () => {
    // Still good right up to the moment the account goes away — so the 401 below is the death, not a
    // token that was already invalid.
    expect((await fetch(`${serverBase}/v2/library/items`, { headers: bearer() })).status).toBe(200)

    // Revoke the account upstream. The chain stays live locally; the next sweep is what discovers it.
    await deleteAbsUser(abs!.absBase, abs!.adminToken, KA_USER)

    // The sweep spends the stored refresh token, ABS refuses it with a 401, and the loop marks the
    // entry dead — kept rather than deleted, which is what separates "re-authenticate" from "signed
    // out" (SPEC section 8). Reaching past this wait IS the assertion that the death was detected; it
    // throws on timeout.
    await waitForEntry((e) => e.deadSince !== undefined)

    // The next request resolves the still-live token onto that dead chain and is turned away before any
    // upstream call, with the one 401 that asks for the password again.
    const res = await fetch(`${serverBase}/v2/library/items`, { headers: bearer() })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('UPSTREAM_SESSION_LOST')
  })
})

// When the entry's chain was last minted or refreshed, as epoch ms — mirrors the store's own
// chainRefreshedAt(), falling back to createdAt for an entry written before the stamp existed.
function refreshedAtMs(entry: StoredEntry): number {
  const stamp = Date.parse(entry.chainRefreshedAt ?? entry.createdAt)
  return Number.isNaN(stamp) ? 0 : stamp
}
