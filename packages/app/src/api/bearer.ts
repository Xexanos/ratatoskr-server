import type { FastifyRequest } from 'fastify'

// The bearer-protected endpoints carry the caller's Audiobookshelf access token (SPEC
// section 8). Presence is checked here; ABS itself is the authority on validity, so a
// bad token surfaces as a 401 from the upstream call.
export class MissingBearerError extends Error {
  constructor() {
    super('Missing or malformed Authorization bearer token')
    this.name = 'MissingBearerError'
  }
}

const PREFIX = 'Bearer '

export function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.startsWith(PREFIX)) {
    const token = header.slice(PREFIX.length).trim()
    if (token !== '') return token
  }
  throw new MissingBearerError()
}
