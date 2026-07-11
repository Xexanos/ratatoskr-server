import { fileURLToPath } from 'node:url'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

// Boot + seed a real Audiobookshelf container for the integration tests (shared by the playback
// session-flow test). Digest-pinned for reproducibility; see also absLive.integration.test.ts.
const ABS_IMAGE = 'ghcr.io/advplyr/audiobookshelf@sha256:1eef6716183c52abafe5405e7d6be8390248ecd59c7488c44af871757ac8fc4d'
const ABS_PORT = 13378
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/audiobooks', import.meta.url))

export const ROOT_USER = 'root'
export const ROOT_PASS = 'rootpassword'
export const STREAMER_USER = 'streamer'
export const STREAMER_PASS = 'streampassword'

async function poll(label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms${lastError ? ` (last: ${String(lastError)})` : ''}`)
}

// Retry first-contact calls through ABS's warm-up (transient network / 5xx); return <500 so a
// genuine 4xx surfaces immediately.
async function seedFetch(label: string, url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, init)
      if (res.status < 500) return res
      last = `HTTP ${res.status}`
      await res.body?.cancel()
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${label} did not succeed within ${timeoutMs}ms (last: ${String(last)})`)
}

async function adminToken(absBase: string): Promise<string> {
  const res = await seedFetch('ABS admin login', `${absBase}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-return-tokens': 'true' },
    body: JSON.stringify({ username: ROOT_USER, password: ROOT_PASS }),
  })
  if (!res.ok) throw new Error(`ABS admin login failed: ${res.status}`)
  const body = (await res.json()) as { accessToken?: unknown; user?: { accessToken?: unknown; token?: unknown } }
  const token = [body.accessToken, body.user?.accessToken, body.user?.token].find((t) => typeof t === 'string')
  if (typeof token !== 'string') throw new Error('ABS admin login returned no access token')
  return token
}

export interface SeededAbs {
  container: StartedTestContainer
  absBase: string
  itemId: string
  adminToken: string
}

// Start ABS, create the root user, a book library with the fixture audiobook, force a scan, and a
// streamer user. Returns the base URL, the scanned item's id, and the admin token (for e.g.
// pre-seeding progress).
export async function startSeededAbs(): Promise<SeededAbs> {
  const container = await new GenericContainer(ABS_IMAGE)
    .withEnvironment({ PORT: String(ABS_PORT) })
    .withExposedPorts(ABS_PORT)
    .withCopyDirectoriesToContainer([{ source: FIXTURE_DIR, target: '/audiobooks' }])
    .withWaitStrategy(Wait.forHttp('/status', ABS_PORT).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start()
  const absBase = `http://${container.getHost()}:${container.getMappedPort(ABS_PORT)}`

  const initRes = await seedFetch('ABS /init', `${absBase}/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newRoot: { username: ROOT_USER, password: ROOT_PASS } }),
  })
  if (!initRes.ok) throw new Error(`ABS /init failed: ${initRes.status}`)

  const token = await adminToken(absBase)
  const authHeader = { authorization: `Bearer ${token}` }

  const libRes = await seedFetch('ABS create library', `${absBase}/api/libraries`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Books', folders: [{ fullPath: '/audiobooks' }], mediaType: 'book' }),
  })
  if (!libRes.ok) throw new Error(`ABS create library failed: ${libRes.status}`)
  const lib = (await libRes.json()) as { id?: string }
  const libraryId = lib.id
  if (libraryId === undefined) throw new Error('ABS create library returned no id')

  await seedFetch('ABS scan', `${absBase}/api/libraries/${libraryId}/scan`, { method: 'POST', headers: authHeader })

  let itemId = ''
  await poll(
    'the seeded book to be scanned with a probed duration',
    async () => {
      const res = await fetch(`${absBase}/api/libraries/${libraryId}/items`, { headers: authHeader })
      if (!res.ok) return false
      const data = (await res.json()) as { results?: { id?: string; media?: { duration?: number } }[] }
      const first = data.results?.[0]
      if (first?.id && typeof first.media?.duration === 'number' && first.media.duration > 0) {
        itemId = first.id
        return true
      }
      return false
    },
    90_000,
  )

  // isActive defaults to false on creation — an inactive user cannot log in (401), so the streamer
  // identity the server uses for media URLs must be created active.
  const userRes = await seedFetch('ABS create streamer user', `${absBase}/api/users`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ username: STREAMER_USER, password: STREAMER_PASS, type: 'user', isActive: true }),
  })
  if (!userRes.ok) throw new Error(`ABS create streamer user failed: ${userRes.status}`)

  return { container, absBase, itemId, adminToken: token }
}
