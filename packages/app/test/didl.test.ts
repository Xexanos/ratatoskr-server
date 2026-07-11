import { describe, expect, it } from 'vitest'
import { buildTrackMetadata, escapeXml } from '../src/sonos/didl.js'

describe('escapeXml', () => {
  it('escapes the five XML metacharacters', () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f')
  })
})

describe('buildTrackMetadata', () => {
  it('carries the mime in a <res protocolInfo> so Sonos can play an extension-less URL', () => {
    const didl = buildTrackMetadata({
      title: 'Chapter 1',
      mimeType: 'audio/mpeg',
      url: 'http://abs.invalid/api/items/li_1/file/42?token=secret',
    })
    expect(didl).toContain('protocolInfo="http-get:*:audio/mpeg:*"')
    expect(didl).toContain('http://abs.invalid/api/items/li_1/file/42?token=secret')
    expect(didl).toContain('<dc:title>Chapter 1</dc:title>')
    expect(didl).toContain('<upnp:class>object.item.audioItem.musicTrack</upnp:class>')
  })

  it('escapes special characters in the title', () => {
    const didl = buildTrackMetadata({ title: 'A & B', mimeType: 'audio/mp4', url: 'http://x/1' })
    expect(didl).toContain('<dc:title>A &amp; B</dc:title>')
  })
})
