import { openapiDocument } from '@ratatoskr/contract'
import { describe, expect, it } from 'vitest'
import { versionPrefix } from '../src/api/apiPrefix.js'

// The mount prefix is derived from the contract rather than declared next to it (SPEC section 6), so
// these tests are about the derivation holding for the shapes `servers.url` can take — and failing
// loudly for the ones that carry no version, since an unprefixed mount would serve whichever major
// happens to be built under a path that promises nothing.
describe('versionPrefix', () => {
  it('takes the path of the first server, past the templated authority', () => {
    expect(versionPrefix({ servers: [{ url: 'http://{host}:{port}/v2' }] })).toBe('/v2')
  })

  // The served document, read the way the mount reads it.
  it('gives the served major its prefix', () => {
    expect(versionPrefix(openapiDocument)).toBe('/v2')
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
    // OpenAPI allows a relative servers.url, and this rejects one rather than reading it as a prefix.
    // Pinned as a known limitation, not an accident: the served document carries an absolute template,
    // and a contract that switched to `/v2` should fail loudly at startup here — where the message
    // names servers[0].url — instead of being parsed by a looser rule that would also accept a path
    // that is not a version prefix at all.
    ['a relative url', { servers: [{ url: '/v2' }] }],
  ])('throws on %s', (_case, document) => {
    expect(() => versionPrefix(document)).toThrow(/no version path/)
  })
})
