import type { FastifyRequest } from 'fastify'

// The bearer-protected endpoints carry the caller's Audiobookshelf access token (SPEC
// section 8). It is treated as an opaque credential: this module only extracts it from the
// header and checks it is present — it is never decoded, and its claims and signature are
// never inspected (we do not even assume it is a JWT). Ratatoskr forwards it to
// Audiobookshelf on every call, and ABS is the sole authority on validity, so a bad or
// expired token surfaces as a 401 from the upstream call, not from local validation.
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
