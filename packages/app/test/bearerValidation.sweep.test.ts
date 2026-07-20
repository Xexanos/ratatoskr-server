import { afterEach, describe, expect, it, vi } from 'vitest'
import { openapiDocument } from '@ratatoskr/contract'
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

// One well-formed request per bearer-protected operation. Well-formed matters: Fastify's
// schema validation runs before the handler (and thus before the token guard), so a
// malformed body would 400 without ever reaching the code under test.
const FIXTURES: Record<string, { method: 'GET' | 'PUT' | 'POST' | 'DELETE'; url: string; payload?: unknown }> = {
  listLibraryItems: { method: 'GET', url: '/v1/library/items' },
  getLibraryItem: { method: 'GET', url: '/v1/library/items/li_1' },
  getLibraryItemCover: { method: 'GET', url: '/v1/library/items/li_1/cover' },
  listInProgressItems: { method: 'GET', url: '/v1/library/in-progress' },
  getCurrentSession: { method: 'GET', url: '/v1/sessions/current' },
  startSession: { method: 'PUT', url: '/v1/sessions/current', payload: { itemId: 'li_1', speakerId: 'RINCON_1' } },
  stopSession: { method: 'DELETE', url: '/v1/sessions/current' },
  pauseSession: { method: 'POST', url: '/v1/sessions/current/pause' },
  resumeSession: { method: 'POST', url: '/v1/sessions/current/resume' },
  seekSession: { method: 'POST', url: '/v1/sessions/current/seek', payload: { positionSeconds: 10 } },
}

// Derived here with a deliberate, independent walk (not tokenGuard's) so a derivation bug
// in the implementation cannot hide from the sweep.
function bearerProtectedOperationIds(): string[] {
  const document = openapiDocument as {
    security?: unknown[]
    paths?: Record<string, Record<string, { operationId?: string; security?: unknown[] }>>
  }
  const globallyProtected = (document.security ?? []).length > 0
  const ids: string[] = []
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(pathItem)) {
      if (typeof operation !== 'object' || operation === null || operation.operationId === undefined) continue
      const security = operation.security ?? (globallyProtected ? [{}] : [])
      if (security.length > 0) ids.push(operation.operationId)
    }
  }
  return ids.sort()
}

describe('every bearer-protected operation rejects an invalid token with 401', () => {
  afterEach(() => vi.restoreAllMocks())

  it('has a fixture for every bearer-protected operation in the contract', () => {
    // A new protected endpoint cannot dodge the sweep: this fails until it gets a fixture.
    expect(Object.keys(FIXTURES).sort()).toEqual(bearerProtectedOperationIds())
  })

  it.each(Object.entries(FIXTURES))('%s → 401', async (_operationId, fixture) => {
    const app = await buildApp(testConfig(), {
      absClient: rejectingAbs(),
      sonosClient: {} as SonosClient,
    })
    const res = await app.inject({
      method: fixture.method,
      url: fixture.url,
      headers: { authorization: 'Bearer not-a-real-token' },
      ...(fixture.payload !== undefined ? { payload: fixture.payload } : {}),
    })

    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthorized')
    await app.close()
  })
})
