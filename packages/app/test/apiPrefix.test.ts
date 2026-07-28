import { openapiDocument } from '@ratatoskr/contract'
import { describe, expect, it } from 'vitest'
import { API_PREFIX, versionPrefix } from '../src/apiPrefix.js'

// The mount prefix is derived from the contract rather than declared next to it (SPEC section 6), so
// these tests are about the derivation holding for the shapes `servers.url` can take — and failing
// loudly for the ones that carry no version, since an unprefixed mount would serve whichever major
// happens to be built under a path that promises nothing.
describe('versionPrefix', () => {
  it('takes the path of the first server, past the templated authority', () => {
    expect(versionPrefix({ servers: [{ url: 'http://{host}:{port}/v2' }] })).toBe('/v2')
  })

  it('reads the live contract (the prefix the server actually mounts)', () => {
    expect(API_PREFIX).toBe(versionPrefix(openapiDocument))
    expect(API_PREFIX).toMatch(/^\/v\d+$/)
  })

  it('ignores a trailing slash', () => {
    expect(versionPrefix({ servers: [{ url: 'https://ratatoskr.local/v3/' }] })).toBe('/v3')
  })

  it.each([
    ['no servers at all', {}],
    ['an empty server list', { servers: [] }],
    ['a server without a url', { servers: [{ description: 'no url here' }] }],
    ['a non-string url', { servers: [{ url: 42 }] }],
    ['an origin with no path', { servers: [{ url: 'http://{host}:{port}' }] }],
    ['a root path', { servers: [{ url: 'http://{host}:{port}/' }] }],
  ])('throws on %s', (_case, document) => {
    expect(() => versionPrefix(document)).toThrow(/no version path/)
  })
})
