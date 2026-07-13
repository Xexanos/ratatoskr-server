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
      author: 'Jane Doe',
      durationSeconds: 3661,
      mimeType: 'audio/mpeg',
      url: 'http://abs.invalid/api/items/li_1/file/42?token=secret',
    })
    expect(didl).toContain('protocolInfo="http-get:*:audio/mpeg:*"')
    expect(didl).toContain('http://abs.invalid/api/items/li_1/file/42?token=secret')
    expect(didl).toContain('<dc:title>Chapter 1</dc:title>')
    expect(didl).toContain('<upnp:class>object.item.audioItem.musicTrack</upnp:class>')
    // The Sonos app shows a timeline from res@duration (Sonos's own TrackDuration is 0 — SPEC §4).
    expect(didl).toContain('duration="1:01:01"')
    // Author → artist; title → album, so the app shows the book.
    expect(didl).toContain('<upnp:artist>Jane Doe</upnp:artist>')
    expect(didl).toContain('<upnp:album>Chapter 1</upnp:album>')
  })

  it('omits only the artist when ABS gave no author — the book title is still the album', () => {
    const didl = buildTrackMetadata({ title: 'T', author: '', durationSeconds: 10, mimeType: 'audio/mp4', url: 'http://x/1' })
    expect(didl).not.toContain('upnp:artist')
    expect(didl).toContain('<upnp:album>T</upnp:album>') // album is the book title, independent of author
  })

  it('escapes special characters in the title', () => {
    const didl = buildTrackMetadata({ title: 'A & B', author: '', durationSeconds: 10, mimeType: 'audio/mp4', url: 'http://x/1' })
    expect(didl).toContain('<dc:title>A &amp; B</dc:title>')
  })
})
