import { afterEach, describe, expect, it, vi } from 'vitest'
import { frozenV1Document, openapiDocument } from '@ratatoskr/contract'
import type { AbsClient } from '../src/abs/client.js'
import { AbsAuthError } from '../src/abs/errors.js'
import { SELF_VALIDATING_OPERATIONS } from '../src/api/tokenGuard.js'
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

// The sweep runs per served major, each against its own document and its own mount. The invariant is
// the same for all of them — no bearer-protected operation acts on an unproven token — but the set of
// operations is not, and neither is the guard, since each is built from its own document. A sweep over
// one major would leave the others' operations outside the mechanism that enforces this.
//
// `expectedProtected` is written out rather than derived a second time: for the frozen major it is a
// fact that cannot change, and for the one under development it is something a contract edit should
// have to state on purpose.
//
// `tolerated` names operations that are *defined* to answer normally for a bearer naming no session,
// so 401 is the wrong expectation for them — sign-out is idempotent by contract, so that a client can
// always complete a sign-out locally (tokenGuard.ts's UNKNOWN_TOKEN_TOLERANT_OPERATIONS). They still
// require a bearer, and they still touch nothing upstream on an unknown one, which is what keeps them
// inside the invariant rather than an exception to it — the assertions below check exactly that.
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
    tolerated: [] as string[],
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
    const abs = rejectingAbs()
    // No device signed in, and an empty store: the bearer below names no session on /v2 and is not a
    // valid ABS token on /v1, so it is unproven on either surface — one request, one invariant.
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
      // (On /v1 the opposite is true by design — proving the bearer there *is* an ABS call — so this
      // assertion belongs to the tolerated path alone.)
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

// Guards the fixture table itself: an operation that no major protects any more should lose its
// fixture, or the table drifts into describing a surface that no longer exists.
it('has no fixture for an operation neither major protects', () => {
  const protectedSomewhere = new Set(MAJORS.flatMap((major) => bearerProtectedOperationIds(major.document)))
  expect(Object.keys(FIXTURES).filter((id) => !protectedSomewhere.has(id))).toEqual([])
})

// SELF_VALIDATING_OPERATIONS is the one piece of the guard every major shares, and createTokenGuard
// checks each entry against the document it is built for — so an entry that holds for only one major
// does not fail that major, it throws while building another one and takes the whole process down at
// startup. A frozen document cannot gain an operationId to resolve such a mismatch.
//
// Its own assertion rather than a boot crash: this names the constraint and says which major lacks the
// operation, and it fails in one test instead of in every test that builds an app.
it('shares no self-validating exemption that only one major protects', () => {
  const perMajor = MAJORS.map((major) => ({
    prefix: major.prefix,
    protectedIds: new Set(bearerProtectedOperationIds(major.document)),
  }))
  const unsupported = [...SELF_VALIDATING_OPERATIONS].flatMap((operationId) =>
    perMajor.filter((major) => !major.protectedIds.has(operationId)).map((major) => `${major.prefix}:${operationId}`),
  )
  expect(unsupported).toEqual([])
})
