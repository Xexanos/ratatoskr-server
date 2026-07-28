import { openapiDocument } from '@ratatoskr/contract'

// The API version-mount prefix, read out of the contract's `servers.url` — which SPEC section 6
// names as the one place the prefix lives, so that two majors can be served side by side. Both the
// Fastify mount (app.ts's openapi-glue `prefix`) and the cover URL built into the library projection
// (abs/client.ts) read this, so the mounted routes, the URLs the API hands out, and the contract that
// documents them cannot drift apart — deriving it is what makes that a guarantee rather than a note.
//
// The URL is a server-variable template (`http://{host}:{port}/v2`), so the path is taken after the
// authority rather than by parsing it as a URL: the braces are not valid host syntax.
function versionPrefix(document: Record<string, unknown>): string {
  const servers = document['servers']
  const url = Array.isArray(servers) ? (servers[0] as { url?: unknown } | undefined)?.url : undefined
  const path = typeof url === 'string' ? /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/[^?#]*)/i.exec(url)?.[1] : undefined
  const prefix = path?.replace(/\/+$/, '')
  // Fail at import time rather than mounting an unprefixed API: an unversioned surface would answer
  // every client's requests with whatever major happens to be built (SPEC section 6).
  if (prefix === undefined || prefix === '') {
    throw new Error(`contract servers[0].url carries no version path: ${JSON.stringify(url)}`)
  }
  return prefix
}

export const API_PREFIX = versionPrefix(openapiDocument)
