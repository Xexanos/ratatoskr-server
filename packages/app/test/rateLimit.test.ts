import { frozenV1Document, openapiDocument } from '@ratatoskr/contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AbsClient } from '../src/abs/client.js'
import { buildApp } from '../src/api/app.js'
import { CREDENTIAL_ATTEMPTS_PER_WINDOW, CREDENTIAL_OPERATIONS, credentialPaths } from '../src/api/rateLimit.js'
import type { SonosClient } from '../src/sonos/client.js'
import { testConfig } from './helpers/testConfig.js'

// SPEC section 14: the credential endpoints carry a conservative per-source-address limit so
// Ratatoskr is not a free brute-force funnel in front of Audiobookshelf. Everything else stays
// unlimited — those endpoints take no credentials and are polled legitimately.

const CREDENTIALS = { username: 'lars', password: 'wrong' }
const TOKENS = { accessToken: 'a', refreshToken: 'r', user: { id: '42', username: 'lars' } }

function appWith(abs: Partial<AbsClient> = {}) {
  return buildApp(testConfig(), {
    absClient: {
      login: vi.fn().mockResolvedValue(TOKENS),
      refresh: vi.fn().mockResolvedValue(TOKENS),
      probe: vi.fn().mockResolvedValue('ok'),
      ...abs,
    } as unknown as AbsClient,
    sonosClient: {
      isReachable: vi.fn().mockResolvedValue(true),
      listSpeakers: vi.fn().mockResolvedValue([]),
    } as unknown as SonosClient,
  })
}

// Each attempt comes from the same address, so they land in one bucket. `times` is one more than the
// window allows, so the last response is the first refusal.
async function attempt(
  app: Awaited<ReturnType<typeof buildApp>>,
  url: string,
  times: number,
  remoteAddress = '10.0.0.1',
) {
  let last
  for (let i = 0; i < times; i += 1) {
    last = await app.inject({ method: 'POST', url, payload: CREDENTIALS, remoteAddress })
  }
  if (last === undefined) throw new Error('no attempt was made')
  return last
}

describe('the credential endpoints are rate limited on every served major', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['/v1/auth/login'],
    ['/v2/auth/login'],
    ['/v1/auth/refresh'],
  ])('refuses the attempt after the window is exhausted on %s', async (url) => {
    const app = await appWith()

    const allowed = await attempt(app, url, CREDENTIAL_ATTEMPTS_PER_WINDOW)
    expect(allowed.statusCode, 'the last attempt inside the window must still be served').not.toBe(429)

    const refused = await app.inject({ method: 'POST', url, payload: CREDENTIALS, remoteAddress: '10.0.0.1' })
    expect(refused.statusCode).toBe(429)
    // The contract's Error shape, like every other error this API answers with.
    expect(refused.json()).toEqual({ code: 'too_many_requests', message: expect.any(String) })
    // Tells the client how long to wait instead of leaving it to guess or hammer.
    expect(refused.headers['retry-after']).toBeDefined()
    await app.close()
  })

  // One budget per address across every credential route, not one per route. Deliberate: the budget is
  // for credential attempts as such, so an attacker cannot get a fresh allowance by alternating between
  // login and refresh, or between the two majors' logins.
  it('spends one budget across all credential routes of all majors', async () => {
    const app = await appWith()
    const exhausted = await attempt(app, '/v1/auth/login', CREDENTIAL_ATTEMPTS_PER_WINDOW + 1)
    expect(exhausted.statusCode).toBe(429)

    for (const url of ['/v1/auth/refresh', '/v2/auth/login']) {
      const res = await app.inject({ method: 'POST', url, payload: CREDENTIALS, remoteAddress: '10.0.0.1' })
      expect(res.statusCode, url).toBe(429)
    }
    await app.close()
  })

  it('counts per source address, so one client cannot lock another out', async () => {
    const app = await appWith()
    const exhausted = await attempt(app, '/v1/auth/login', CREDENTIAL_ATTEMPTS_PER_WINDOW + 1)
    expect(exhausted.statusCode).toBe(429)

    const other = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: CREDENTIALS,
      remoteAddress: '10.0.0.2',
    })
    expect(other.statusCode).toBe(200)
    await app.close()
  })

  // These take no credentials, and /health in particular is polled on a timer by anything watching
  // the service — a limit there would turn monitoring into an outage.
  it.each([['/v1/health'], ['/v2/health'], ['/v1/speakers']])('leaves %s unlimited', async (url) => {
    const app = await appWith()
    for (let i = 0; i < CREDENTIAL_ATTEMPTS_PER_WINDOW + 5; i += 1) {
      const res = await app.inject({ method: 'GET', url, remoteAddress: '10.0.0.1' })
      expect(res.statusCode, `${url} attempt ${i + 1}`).toBe(200)
    }
    await app.close()
  })

  // An unrouted path must not consume anyone's budget: it reaches no credential handler, and letting
  // it count would let a stranger exhaust a real client's window by spraying nonsense URLs.
  it('does not count requests to unknown paths', async () => {
    const app = await appWith()
    for (let i = 0; i < CREDENTIAL_ATTEMPTS_PER_WINDOW + 5; i += 1) {
      await app.inject({ method: 'POST', url: '/v1/nope', payload: {}, remoteAddress: '10.0.0.1' })
    }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: CREDENTIALS,
      remoteAddress: '10.0.0.1',
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

// The limited routes are derived from the documents rather than listed, so an operation that takes
// credentials is limited on whichever major declares it, at whatever path that major declares.
describe('credentialPaths', () => {
  it('finds the credential routes of each served major, under its own prefix', () => {
    expect(credentialPaths(frozenV1Document, '/v1').sort()).toEqual(['/v1/auth/login', '/v1/auth/refresh'])
    expect(credentialPaths(openapiDocument, '/v2').sort()).toEqual(['/v2/auth/login'])
  })

  // A path item legitimately holds members that are not operations (OpenAPI allows `parameters`,
  // `summary`, a `$ref`), and an operation may carry no operationId. Neither is a credential route, and
  // neither may throw while the limited set is being built — an exception here would take startup down.
  it('ignores path-item members that are not operations, and operations without an operationId', () => {
    const document = {
      paths: {
        '/auth/login': {
          parameters: [{ name: 'x', in: 'query' }],
          summary: 'not an operation',
          get: null,
          post: { description: 'no operationId here' },
        },
      },
    }
    expect(credentialPaths(document, '/v9')).toEqual([])
  })

  it('has no entry for an operation neither served document declares', () => {
    const declared = new Set(
      [frozenV1Document, openapiDocument].flatMap((document) =>
        Object.values((document as { paths: Record<string, Record<string, { operationId?: string }>> }).paths).flatMap(
          (pathItem) => Object.values(pathItem).map((operation) => operation?.operationId),
        ),
      ),
    )
    expect([...CREDENTIAL_OPERATIONS].filter((operationId) => !declared.has(operationId))).toEqual([])
  })
})
