import { describe, expect, it } from 'vitest'
import { redactedReqSerializer } from '../src/api/app.js'

// SPEC section 14: tokens must never be logged. Pino logs the raw req.url, so the request
// serializer must strip the query string — a path-based redact would be inert here.
describe('redactedReqSerializer', () => {
  it('strips the query string, so a token in the URL is never logged', () => {
    const out = redactedReqSerializer({ method: 'GET', url: '/v1/health?token=SUPERSECRET' })
    expect(out).toEqual({ method: 'GET', url: '/v1/health' })
    expect(JSON.stringify(out)).not.toContain('SUPERSECRET')
  })

  it('passes through a URL that has no query string unchanged', () => {
    expect(redactedReqSerializer({ method: 'GET', url: '/v1/speakers' })).toEqual({
      method: 'GET',
      url: '/v1/speakers',
    })
  })
})
