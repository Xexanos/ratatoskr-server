import { describe, expect, it } from 'vitest'
import { InvalidCursorError } from '../src/abs/cursor.js'
import { AbsAuthError, AbsNotFoundError, AbsUpstreamError } from '../src/abs/errors.js'
import { MissingBearerError } from '../src/api/bearer.js'
import { mapError, NotImplementedError } from '../src/api/errorHandler.js'
import { SonosUpstreamError } from '../src/sonos/errors.js'

describe('mapError', () => {
  it('maps each domain error to its contract status and code', () => {
    expect(mapError(new MissingBearerError())).toMatchObject({ statusCode: 401, code: 'unauthorized' })
    expect(mapError(new AbsAuthError())).toMatchObject({ statusCode: 401, code: 'unauthorized' })
    expect(mapError(new AbsNotFoundError())).toMatchObject({ statusCode: 404, code: 'not_found' })
    expect(mapError(new InvalidCursorError())).toMatchObject({ statusCode: 400, code: 'bad_request' })
    expect(mapError(new AbsUpstreamError())).toMatchObject({ statusCode: 502, code: 'upstream_error' })
    expect(mapError(new SonosUpstreamError())).toMatchObject({ statusCode: 502, code: 'upstream_error' })
    // The fallback for a contract operation with no handler wired (glue's notImplemented stub).
    expect(mapError(new NotImplementedError())).toMatchObject({ statusCode: 404, code: 'not_found' })
  })

  it('distinguishes the 502 message by dependency', () => {
    expect(mapError(new AbsUpstreamError()).message).toContain('Audiobookshelf')
    expect(mapError(new SonosUpstreamError()).message).toContain('Sonos')
  })

  it('unwraps a glue SecurityError to the underlying domain error', () => {
    const securityError = Object.assign(new Error('none authenticated'), {
      statusCode: 401,
      errors: [new MissingBearerError()],
    })
    expect(mapError(securityError)).toMatchObject({ statusCode: 401, code: 'unauthorized' })
  })

  it('maps a Fastify schema-validation error to 400 bad_request', () => {
    const validationError = Object.assign(new Error('body must have property username'), {
      validation: [{ message: 'must have property username' }],
    })
    expect(mapError(validationError)).toMatchObject({ statusCode: 400, code: 'bad_request' })
  })

  it('maps other 4xx Fastify errors to bad_request with their own status', () => {
    const err = Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 })
    expect(mapError(err)).toMatchObject({ statusCode: 415, code: 'bad_request' })
  })

  it('falls back to 500 internal_error for unknown errors', () => {
    expect(mapError(new Error('boom'))).toEqual({
      statusCode: 500,
      code: 'internal_error',
      message: 'Internal server error',
    })
  })
})
