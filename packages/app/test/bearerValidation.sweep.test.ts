import { afterEach, describe, expect, it, vi } from 'vitest'
import { openapiDocument } from '@ratatoskr/contract'
import type { AbsClient } from '../src/abs/client.js'
import { AbsAuthError } from '../src/abs/errors.js'
import type { SonosClient } from '../src/sonos/client.js'
import { buildTestApp } from './helpers/testApp.js'

// Every ABS-touching method rejects like ABS does for a bad token, so whichever path an
// operation takes to prove the caller's token — the token guard or its own upstream call —
// the correct outcome for an invalid bearer is 401. `logout` is here for the opposite reason: on the
// tolerated path nothing should call it at all.
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
    login: reject(),
    logout: reject(),
  } as unknown as AbsClient
}

// The invariant: no bearer-protected operation acts on an unproven token. The sweep runs against the
// one served major, its document and its mount.
//
// `expectedProtected` is written out rather than derived a second time: a contract edit should have
// to state on purpose that the set of protected operations changed.
//
// `tolerated` names operations that are *defined* to answer normally for a bearer naming no session,
// so 401 is the wrong expectation for them - sign-out is idempotent by contract, so that a client can
// always complete a sign-out locally (tokenGuard.ts's UNKNOWN_TOKEN_TOLERANT_OPERATIONS). They still
// require a bearer, and they still touch nothing upstream on an unknown one, which is what keeps them
// inside the invariant rather than an exception to it - the assertions below check exactly that.
const MAJORS = [
  {
    prefix: '/v2',
    document: openapiDocument,
    expectedProtected: [
      'endDeviceSession',
      'getCurrentSession',
      'getLibraryItem',
      'getLibraryItemCover',
      'listDeviceSessions',
      'listInProgressItems',
      'listLibraryItems',
      'logout',
      'pauseSession',
      'resumeSession',
      'seekSession',
      'startSession',
      'stopSession',
    ],
    tolerated: ['logout'],
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
  listDeviceSessions: { method: 'GET', path: '/auth/device-sessions' },
  endDeviceSession: { method: 'DELETE', path: '/auth/device-sessions/6f1c5a0e-3f6b-4c1e-9a55-2d8f0b7c1e10' },
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
    // cannot slip past either.
    expect(bearerProtectedOperationIds(major.document)).toEqual([...major.expectedProtected].sort())
  })

  it('has a fixture for each of them', () => {
    expect(major.expectedProtected.filter((id) => FIXTURES[id] === undefined)).toEqual([])
  })

  it.each(major.expectedProtected)('%s', async (operationId) => {
    const fixture = FIXTURES[operationId]
    if (fixture === undefined) throw new Error(`no fixture for ${operationId}`)
    const abs = rejectingAbs()
    // No device signed in, and an empty store: the bearer below names no session, so it is unproven.
    const { app } = await buildTestApp({ absClient: abs, sonosClient: {} as SonosClient }, { signedIn: false })
    const res = await app.inject({
      method: fixture.method,
      url: `${major.prefix}${fixture.path}`,
      headers: { authorization: 'Bearer not-a-real-token' },
      ...(fixture.payload !== undefined ? { payload: fixture.payload } : {}),
    })

    if (major.tolerated.includes(operationId)) {
      expect(res.statusCode).toBe(204)
      // A tolerated operation is exempt from *rejecting* an unknown token, not from acting on one:
      // sign-out has no chain to end when the token names no session, so nothing goes upstream.
      for (const method of Object.values(abs as unknown as Record<string, unknown>)) {
        if (typeof method === 'function') expect(method).not.toHaveBeenCalled()
      }
    } else {
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('unauthorized')
    }
    await app.close()
  })
})

// Guards the fixture table itself: an operation that is no longer protected should lose its fixture,
// or the table drifts into describing a surface that no longer exists.
it('has no fixture for an operation the major does not protect', () => {
  const protectedIds = new Set(MAJORS.flatMap((major) => bearerProtectedOperationIds(major.document)))
  expect(Object.keys(FIXTURES).filter((id) => !protectedIds.has(id))).toEqual([])
})
