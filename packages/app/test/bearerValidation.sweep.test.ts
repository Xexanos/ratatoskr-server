import { afterEach, describe, expect, it, vi } from 'vitest'
import { frozenV1Document, openapiDocument } from '@ratatoskr/contract'
import type { AbsClient } from '../src/abs/client.js'
import { AbsAuthError } from '../src/abs/errors.js'
import { buildApp } from '../src/api/app.js'
import type { Config } from '../src/config/index.js'
import type { SonosClient } from '../src/sonos/client.js'

function testConfig(): Config {
  return {
    absUrl: 'http://abs.invalid',
    absStreamerApiKey: 'streamer-key',
    sonosSeedHost: undefined,
    port: 0,
    pollIntervalSeconds: 15,
    seekSettleMs: 1000,
    seekToleranceSeconds: 3,
    seekRetries: 2,
    progressWriteThresholdSeconds: 5,
    tls: undefined,
    validateResponses: true,
  } as Config
}

// Every ABS-touching method rejects like ABS does for a bad token, so whichever path an
// operation takes to prove the caller's token — the token guard or its own upstream call —
// the correct outcome for an invalid bearer is 401.
function rejectingAbs(): AbsClient {
  const reject = () => vi.fn().mockRejectedValue(new AbsAuthError())
  return {
    validateToken: reject(),
    listItems: reject(),
    getItem: reject(),
    getItemCover: reject(),
    listInProgressItems: reject(),
    getPlaybackManifest: reject(),
    getProgress: reject(),
  } as unknown as AbsClient
}

// The sweep runs per served major, each against its own document and its own mount. The invariant is
// the same for both — no bearer-protected operation acts on an unproven token — but the set of
// operations is not, and neither is the guard: /v1's and /v2's are built from different documents,
// and #134 replaces /v2's check entirely. A sweep over one major would leave the other's operations
// outside the mechanism that enforces this, and /v1 is the one that must not quietly change.
//
// `expectedProtected` is written out rather than derived a second time: for /v1 it is a fact that can
// never change (the document is frozen at the contract-1.4.0 tag), and for /v2 it is the thing a
// contract edit should have to state on purpose.
//
// `notImplemented` names operations the document declares and no service implements, so glue's
// resolver answers them with the not-implemented stub — reached before any token check, hence 404
// rather than 401. /v2's logout is the case: it is bearer-protected in 2.0.0 and waits on #134 to
// mint the tokens it would revoke. It touches nothing upstream, so nothing acts on an unproven token
// here either; the entry has to disappear when #134 implements it, or the sweep stops holding it to
// 401 forever.
const MAJORS = [
  {
    prefix: '/v1',
    document: frozenV1Document,
    expectedProtected: [
      'getCurrentSession',
      'getLibraryItem',
      'getLibraryItemCover',
      'listInProgressItems',
      'listLibraryItems',
      'pauseSession',
      'resumeSession',
      'seekSession',
      'startSession',
      'stopSession',
    ],
    notImplemented: [] as string[],
  },
  {
    prefix: '/v2',
    document: openapiDocument,
    expectedProtected: [
      'getCurrentSession',
      'getLibraryItem',
      'getLibraryItemCover',
      'listInProgressItems',
      'listLibraryItems',
      'logout',
      'pauseSession',
      'resumeSession',
      'seekSession',
      'startSession',
      'stopSession',
    ],
    notImplemented: ['logout'],
  },
]

// One well-formed request per bearer-protected operation, path relative to the mount. Well-formed
// matters: Fastify's schema validation runs before the handler (and thus before the token guard), so
// a malformed body would 400 without ever reaching the code under test.
const FIXTURES: Record<string, { method: 'GET' | 'PUT' | 'POST' | 'DELETE'; path: string; payload?: object }> = {
  listLibraryItems: { method: 'GET', path: '/library/items' },
  getLibraryItem: { method: 'GET', path: '/library/items/li_1' },
  getLibraryItemCover: { method: 'GET', path: '/library/items/li_1/cover' },
  listInProgressItems: { method: 'GET', path: '/library/in-progress' },
  getCurrentSession: { method: 'GET', path: '/sessions/current' },
  startSession: { method: 'PUT', path: '/sessions/current', payload: { itemId: 'li_1', speakerId: 'RINCON_1' } },
  stopSession: { method: 'DELETE', path: '/sessions/current' },
  pauseSession: { method: 'POST', path: '/sessions/current/pause' },
  resumeSession: { method: 'POST', path: '/sessions/current/resume' },
  seekSession: { method: 'POST', path: '/sessions/current/seek', payload: { positionSeconds: 10 } },
  logout: { method: 'POST', path: '/auth/logout' },
}

// Derived with a deliberate, independent walk (not tokenGuard's) so a derivation bug in the
// implementation cannot hide from the sweep.
function bearerProtectedOperationIds(source: Record<string, unknown>): string[] {
  const document = source as {
    security?: unknown[]
    paths?: Record<string, Record<string, { operationId?: string; security?: unknown[] }>>
  }
  const namesBearer = (requirements: unknown[]) =>
    requirements.some((requirement) => typeof requirement === 'object' && requirement !== null && 'bearerAuth' in requirement)
  const ids: string[] = []
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(pathItem)) {
      if (typeof operation !== 'object' || operation === null || operation.operationId === undefined) continue
      if (namesBearer(operation.security ?? document.security ?? [])) ids.push(operation.operationId)
    }
  }
  return ids.sort()
}

describe.each(MAJORS)('$prefix: every bearer-protected operation refuses an unproven token', (major) => {
  afterEach(() => vi.restoreAllMocks())

  it('protects exactly the operations this major is expected to', () => {
    // A newly protected endpoint cannot dodge the sweep, and one that quietly stops being protected
    // cannot slip past either — on /v1 that would be a change to a frozen surface.
    expect(bearerProtectedOperationIds(major.document)).toEqual([...major.expectedProtected].sort())
  })

  it('has a fixture for each of them', () => {
    expect(major.expectedProtected.filter((id) => FIXTURES[id] === undefined)).toEqual([])
  })

  it.each(major.expectedProtected)('%s', async (operationId) => {
    const fixture = FIXTURES[operationId]
    if (fixture === undefined) throw new Error(`no fixture for ${operationId}`)
    const app = await buildApp(testConfig(), {
      absClient: rejectingAbs(),
      sonosClient: {} as SonosClient,
    })
    const res = await app.inject({
      method: fixture.method,
      url: `${major.prefix}${fixture.path}`,
      headers: { authorization: 'Bearer not-a-real-token' },
      ...(fixture.payload !== undefined ? { payload: fixture.payload } : {}),
    })

    if (major.notImplemented.includes(operationId)) {
      expect(res.statusCode).toBe(404)
      expect(res.json().code).toBe('not_found')
    } else {
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('unauthorized')
    }
    await app.close()
  })
})

// Guards the fixture table itself: an operation that no major protects any more should lose its
// fixture, or the table drifts into describing a surface that no longer exists.
it('has no fixture for an operation neither major protects', () => {
  const protectedSomewhere = new Set(MAJORS.flatMap((major) => bearerProtectedOperationIds(major.document)))
  expect(Object.keys(FIXTURES).filter((id) => !protectedSomewhere.has(id))).toEqual([])
})
