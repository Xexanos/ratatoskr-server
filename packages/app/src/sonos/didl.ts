// DIDL-Lite metadata for the transport URI (SPEC section 4). Setting a bare ABS file URL fails
// with UPnP 714 ("Illegal MIME-Type") because the URL has no extension for Sonos to sniff — the
// speaker needs DIDL-Lite whose <res protocolInfo="http-get:*:<mime>:*"> carries the mime from
// ABS. The structure mirrors @svrooij/sonos's own TrackToMetaData(includeResource) output, so it
// is known-compatible with real Sonos.
//
// Note on escaping: this returns a *valid* DIDL XML document (title/url escaped once). When it is
// handed to the library as `EnqueuedURIMetaData`, the library inserts string metadata into the
// SOAP body verbatim (it does not escape it), so the caller must escapeXml() this whole document
// once more before sending — the speaker then unescapes twice (SOAP envelope, then the metadata).

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export interface DidlTrack {
  title: string
  mimeType: string
  url: string
}

export function buildTrackMetadata(track: DidlTrack): string {
  const protocolInfo = `http-get:*:${track.mimeType}:*`
  return (
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" ' +
    'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    '<item id="-1" parentID="-1" restricted="true">' +
    `<res protocolInfo="${escapeXml(protocolInfo)}">${escapeXml(track.url)}</res>` +
    `<dc:title>${escapeXml(track.title)}</dc:title>` +
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
    '<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">RINCON_AssociatedZPUDN</desc>' +
    '</item></DIDL-Lite>'
  )
}
