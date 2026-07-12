import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

// Harness for the live-Audiobookshelf integration tests: boot + seed a real ABS container,
// plus the Docker gating and the pinned images. Consumed by globalSetup, which runs the
// boot + seed ONCE per vitest run and hands the connection info to the test files.

// The local default ABS image (README supports >= 2.26), pinned by multi-arch manifest digest so
// local runs are reproducible and can't slide onto a moving tag. Bump as ABS releases.
// Version coverage lives in CI: two parallel jobs pass ABS_IT_IMAGE — the pinned 2.26.0 minimum
// (whose digest is owned by .github/workflows/ci.yml, the single source of truth for it) and the
// deliberately unpinned :latest tag (a drift canary for new ABS releases).
export const ABS_CURRENT = {
  label: '2.35.1 (current)',
  image: 'ghcr.io/advplyr/audiobookshelf@sha256:1eef6716183c52abafe5405e7d6be8390248ecd59c7488c44af871757ac8fc4d',
}

// The image to test against: ABS_IT_IMAGE (the CI matrix hook, also a local override), or the
// pinned current digest so local runs are deterministic.
export function resolveAbsImage(): string {
  return process.env.ABS_IT_IMAGE ?? ABS_CURRENT.image
}

const ABS_PORT = 13378
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/audiobooks', import.meta.url))

// Root is SEEDING-ONLY: globalSetup uses it to create the library and per-file users. Tests must
// not log in as root or touch its progress — each test file creates its own users (see
// createAbsUser) so files stay isolated on the one shared container.
export const ROOT_USER = 'root'
export const ROOT_PASS = 'rootpassword'

// Probe for a reachable container runtime. On any throw (missing CLI, daemon down, or a slow daemon
// that exceeds the timeout) log *why* and return false, so a skipped-because-absent run is
// distinguishable from a skipped-because-flaked one.
export function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 60_000 })
    return true
  } catch (error) {
    console.warn(`[integration] Docker probe failed; live tests cannot run against a real container: ${String(error)}`)
    return false
  }
}

// In CI (or when explicitly demanded) a missing runtime must FAIL rather than silently skip, so
// live coverage can't vanish while CI stays green. Locally, with no runtime, it skips cleanly.
export const REQUIRE_LIVE = process.env.CI === 'true' || process.env.ABS_IT_REQUIRE === '1'

export async function poll(label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
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

// Retry first-contact calls through ABS's warm-up (transient network / 5xx); return any <500 so a
// genuine 4xx surfaces immediately instead of being retried into a timeout.
export async function seedFetch(label: string, url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
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

// Log in as root (seeding only), tolerant of small shape differences across versions, to obtain the
// admin access token for the seeding API calls.
async function adminToken(absBase: string): Promise<string> {
  const res = await seedFetch('ABS admin login', `${absBase}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-return-tokens': 'true' },
    body: JSON.stringify({ username: ROOT_USER, password: ROOT_PASS }),
  })
  if (!res.ok) throw new Error(`ABS admin login failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { accessToken?: unknown; user?: { accessToken?: unknown; token?: unknown } }
  const token = [body.accessToken, body.user?.accessToken, body.user?.token].find((t) => typeof t === 'string')
  if (typeof token !== 'string') throw new Error('ABS admin login returned no access token')
  return token
}

// Create an (active) ABS user. Each test file creates its OWN end user and streamer user so
// files cannot interfere through shared progress or login sessions on the shared container.
// isActive defaults to false → an inactive user cannot log in (401), and the server logs the
// streamer in at startup and aborts if that fails, so users must be created active. Tolerant of
// the user already existing (vitest watch mode re-runs a file against the still-warm container).
export async function createAbsUser(
  absBase: string,
  adminAccessToken: string,
  username: string,
  password: string,
): Promise<void> {
  const authHeader = { authorization: `Bearer ${adminAccessToken}` }
  const res = await seedFetch(`ABS create user ${username}`, `${absBase}/api/users`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, type: 'user', isActive: true }),
  })
  if (res.ok) return

  // The user may already exist (vitest watch mode re-runs a file against the still-warm container).
  // Confirm that STRUCTURALLY — the username is present in GET /api/users — rather than by matching
  // ABS's error wording: this suite runs an unpinned :latest leg precisely because upstream drifts,
  // so a reworded/localized message must not turn a benign re-run into a hard failure, nor an
  // unrelated 4xx that happens to contain "already exists" into a silent pass.
  const failure = `ABS create user ${username} failed: ${res.status} ${await res.text()}`
  const listRes = await fetch(`${absBase}/api/users`, { headers: authHeader })
  if (!listRes.ok) throw new Error(failure)
  const list = (await listRes.json()) as { users?: { username?: unknown }[] }
  const exists = list.users?.some((user) => user.username === username) ?? false
  if (!exists) throw new Error(failure)
}

export interface SeededAbs {
  container: StartedTestContainer
  absBase: string
  itemId: string
  libraryId: string
  adminToken: string
}

// Start the given ABS image, create the root user, and a book library with the fixture audiobook,
// then force a scan. Returns the base URL, the scanned item's id, and the admin token (for the
// per-file user creation). Test users are NOT created here — see createAbsUser.
export async function startSeededAbs(image: string): Promise<SeededAbs> {
  const container = await new GenericContainer(image)
    // The image binds port 80 by default; pin it to a known port explicitly instead.
    .withEnvironment({ PORT: String(ABS_PORT) })
    .withExposedPorts(ABS_PORT)
    .withCopyDirectoriesToContainer([{ source: FIXTURE_DIR, target: '/audiobooks' }])
    .withWaitStrategy(Wait.forHttp('/status', ABS_PORT).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start()
  const absBase = `http://${container.getHost()}:${container.getMappedPort(ABS_PORT)}`

  // Retried: /init may not be serving the instant the wait strategy's HTTP probe first succeeds.
  const initRes = await seedFetch('ABS /init', `${absBase}/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newRoot: { username: ROOT_USER, password: ROOT_PASS } }),
  })
  if (!initRes.ok) throw new Error(`ABS /init failed: ${initRes.status} ${await initRes.text()}`)

  const token = await adminToken(absBase)
  const authHeader = { authorization: `Bearer ${token}` }

  const libRes = await seedFetch('ABS create library', `${absBase}/api/libraries`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Books', folders: [{ fullPath: '/audiobooks' }], mediaType: 'book' }),
  })
  if (!libRes.ok) throw new Error(`ABS create library failed: ${libRes.status} ${await libRes.text()}`)
  const lib = (await libRes.json()) as { id?: string; library?: { id?: string } }
  const libraryId = lib.id ?? lib.library?.id
  if (libraryId === undefined) throw new Error('ABS create library returned no id')

  // The auto-scan on creation does not reliably pick up freshly-copied files; force one.
  const scanRes = await seedFetch('ABS library scan', `${absBase}/api/libraries/${libraryId}/scan`, {
    method: 'POST',
    headers: authHeader,
  })
  if (!scanRes.ok) throw new Error(`ABS library scan failed: ${scanRes.status} ${await scanRes.text()}`)

  let itemId = ''
  await poll(
    'the seeded book to be scanned with a probed duration',
    async () => {
      const res = await fetch(`${absBase}/api/libraries/${libraryId}/items`, { headers: authHeader })
      if (!res.ok) return false
      const data = (await res.json()) as { results?: { id?: string; media?: { duration?: number } }[] }
      const first = data.results?.[0]
      // ABS inserts the item row before ffprobe fills in the duration — gate on both.
      if (first?.id && typeof first.media?.duration === 'number' && first.media.duration > 0) {
        itemId = first.id
        return true
      }
      return false
    },
    90_000,
  )

  return { container, absBase, itemId, libraryId, adminToken: token }
}
