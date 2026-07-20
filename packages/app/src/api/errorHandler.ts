import type { FastifyError } from 'fastify'
import { InvalidCursorError } from '../abs/cursor.js'
import { AbsAuthError, AbsNotFoundError, AbsUpstreamError, ItemNotPlayableError } from '../abs/errors.js'
import { NoActiveSessionError } from '../playback/errors.js'
import { SonosUpstreamError } from '../sonos/errors.js'
import { MissingBearerError } from './bearer.js'

// Thrown for contract operations that openapi-glue registers but ApiService does not implement.
// Mapped to 404 not_found (which the contract declares) instead of glue's default 500.
export class NotImplementedError extends Error {
  constructor() {
    super('This operation is not implemented yet')
    this.name = 'NotImplementedError'
  }
}

export interface MappedError {
  statusCode: number
  code: string
  message: string
}

// fastify-openapi-glue wraps a failing securityHandler's thrown error(s) in a SecurityError
// carrying { statusCode, errors }. Unwrap it so we classify the underlying domain error
// (e.g. MissingBearerError) rather than the wrapper.
function isGlueSecurityError(error: unknown): error is { statusCode: number; errors: unknown[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    Array.isArray((error as { errors?: unknown }).errors) &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
  )
}

// Maps any thrown value to the contract's Error shape ({ code, message }) plus a status code.
// Central so every route shares one mapping.
export function mapError(error: unknown): MappedError {
  if (isGlueSecurityError(error)) {
    return mapError(error.errors[0] ?? new MissingBearerError())
  }
  if (error instanceof MissingBearerError) {
    return { statusCode: 401, code: 'unauthorized', message: 'A valid Audiobookshelf token is required' }
  }
  if (error instanceof AbsAuthError) {
    return { statusCode: 401, code: 'unauthorized', message: 'Audiobookshelf rejected the credentials' }
  }
  if (error instanceof AbsNotFoundError) {
    return { statusCode: 404, code: 'not_found', message: 'The requested resource was not found' }
  }
  if (error instanceof InvalidCursorError) {
    return { statusCode: 400, code: 'bad_request', message: 'Invalid pagination cursor' }
  }
  if (error instanceof NoActiveSessionError) {
    return { statusCode: 404, code: 'not_found', message: 'No audiobook is currently playing' }
  }
  if (error instanceof ItemNotPlayableError) {
    return { statusCode: 400, code: 'bad_request', message: 'This item cannot be played' }
  }
  if (error instanceof AbsUpstreamError) {
    return { statusCode: 502, code: 'upstream_error', message: 'Audiobookshelf is unavailable' }
  }
  if (error instanceof SonosUpstreamError) {
    return { statusCode: 502, code: 'upstream_error', message: 'Sonos is unavailable' }
  }
  if (error instanceof NotImplementedError) {
    return { statusCode: 404, code: 'not_found', message: 'This operation is not implemented yet' }
  }
  // Fastify's own errors: schema validation and other client-side (4xx) failures.
  const fastifyError = error as FastifyError
  if (fastifyError?.validation) {
    return { statusCode: 400, code: 'bad_request', message: fastifyError.message }
  }
  if (typeof fastifyError?.statusCode === 'number' && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
    return { statusCode: fastifyError.statusCode, code: 'bad_request', message: fastifyError.message }
  }
  return { statusCode: 500, code: 'internal_error', message: 'Internal server error' }
}
