import { XMLBuilder } from 'fast-xml-parser'
import { secondsToHms } from './time.js'

// DIDL-Lite metadata for the transport URI (SPEC section 4). Setting a bare ABS file URL fails
// with UPnP 714 ("Illegal MIME-Type") because the URL has no extension for Sonos to sniff — the
// speaker needs DIDL-Lite whose <res protocolInfo="http-get:*:<mime>:*"> carries the mime from
// ABS. The element structure mirrors @svrooij/sonos's own TrackToMetaData(includeResource) output,
// so it is known-compatible with real Sonos, but we can't use that helper: the library only emits
// the <res protocolInfo> (the mime carrier we need) when building from a bare URL it recognises as
// a known streaming service, which our ABS URLs are not.
//
// The document is built with a real XML builder (not string concatenation) so titles and URLs are
// escaped for us — no hand-rolled entity handling in the DIDL itself.

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  suppressEmptyNode: true,
  // Keep restricted="true" as a valued attribute rather than collapsing it to a bare `restricted`.
  suppressBooleanAttributes: false,
  // Escape entities in text/attribute values (the whole point of using the builder).
  processEntities: true,
})

export interface DidlTrack {
  title: string
  mimeType: string
  url: string
  /** Track length in seconds — becomes res@duration so the Sonos app can show a timeline (Sonos's
   * own reported TrackDuration is 0 for these streams, SPEC §4). */
  durationSeconds: number
  /** Display author; becomes upnp:artist. Empty string → omitted. */
  author: string
}

export function buildTrackMetadata(track: DidlTrack): string {
  return builder.build({
    'DIDL-Lite': {
      '@_xmlns:dc': 'http://purl.org/dc/elements/1.1/',
      '@_xmlns:upnp': 'urn:schemas-upnp-org:metadata-1-0/upnp/',
      '@_xmlns:r': 'urn:schemas-rinconnetworks-com:metadata-1-0/',
      '@_xmlns': 'urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/',
      item: {
        '@_id': '-1',
        '@_parentID': '-1',
        '@_restricted': 'true',
        // res@duration gives the app the track length (progress bar); Sonos reports it as 0 (SPEC §4).
        res: {
          '@_protocolInfo': `http-get:*:${track.mimeType}:*`,
          '@_duration': secondsToHms(track.durationSeconds),
          '#text': track.url,
        },
        'dc:title': track.title,
        // The author is the artist — omitted when ABS gave none. The book title is always the album
        // (independent of the author), so a multi-file book's tracks group under it in the app. Until
        // chapter titles land (§16), dc:title is also the book title; the target mapping is
        // title=chapter / album=book / artist=author.
        ...(track.author !== '' ? { 'upnp:artist': track.author } : {}),
        'upnp:album': track.title,
        'upnp:class': 'object.item.audioItem.musicTrack',
        desc: {
          '@_id': 'cdudn',
          '@_nameSpace': 'urn:schemas-rinconnetworks-com:metadata-1-0/',
          '#text': 'RINCON_AssociatedZPUDN',
        },
      },
    },
  }) as string
}

// Escape a DIDL document for embedding as a string metadata value in a Sonos SOAP request.
// This is NOT about building the DIDL (the XML builder above handles that) — it exists only
// because @svrooij/sonos inserts string metadata into the SOAP envelope verbatim (it does not
// escape it), so the whole document has to be entity-escaped once before it is handed over. The
// speaker then unescapes twice: once for the SOAP envelope, once for the nested DIDL.
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
