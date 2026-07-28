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

interface Fixture {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE'
  // The contract path, without the mount prefix — the sweep adds each major's own (both documents
  // declare these same paths, which is why one table serves both).
  path: string
  payload?: unknown
}

// One well-formed request per bearer-protected operation. Well-formed matters: Fastify's
// schema validation runs before the handler (and thus before the token guard), so a
// malformed body would 400 without ever reaching the code under test.
const FIXTURES: Record<string, Fixture> = {
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
}

// Every served major is swept, each against its own document and through its own guard instance.
// Deriving the expected set from one major's document would leave the other's protected operations
// outside the sweep entirely — and the frozen /v1 major is the one whose guard must not quietly
// change, since installed app versions depend on it.
//
// `notImplemented` names bearer-protected operations a document declares but nothing serves yet, so
// there is no token validation to sweep: openapi-glue's not-implemented stub answers before any guard
// runs. An entry is a promise that the operation joins FIXTURES when it is implemented — until then
// the "fixture for every protected operation" check below fails on it.
const MAJORS = [
  { prefix: '/v1', document: frozenV1Document, notImplemented: [] as string[] },
  {
    prefix: '/v2',
    document: openapiDocument,
    // #134. Note it will not join FIXTURES as-is: the contract makes logout idempotent, so an unknown
    // token answers 204, and the sweep's "invalid bearer → 401" shape does not apply to it.
    notImplemented: ['logout'],
  },
]

// Derived here with a deliberate, independent walk (not tokenGuard's) so a derivation bug
// in the implementation cannot hide from the sweep.
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

describe.each(MAJORS)('$prefix: every bearer-protected operation rejects an invalid token with 401', (major) => {
  afterEach(() => vi.restoreAllMocks())

  it('has a fixture for every implemented bearer-protected operation in the contract', () => {
    // A new protected endpoint cannot dodge the sweep: this fails until it gets a fixture (or, for
    // one that is still only declared, an entry in this major's `notImplemented`).
    expect([...Object.keys(FIXTURES), ...major.notImplemented].sort()).toEqual(
      bearerProtectedOperationIds(major.document),
    )
  })

  it.each(Object.entries(FIXTURES))('%s → 401', async (_operationId, fixture) => {
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

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
    await app.close()
  })
})
