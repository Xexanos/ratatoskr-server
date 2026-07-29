// A served major's version-mount prefix, read out of its contract's `servers.url` — which SPEC
// section 6 names as the one place the prefix lives, one place *per major*, so that two majors can be
// served side by side. The Fastify mount (app.ts's openapi-glue `prefix`) and the cover URLs that
// major's responses carry (contractMapping.ts) both come from here, so the mounted routes, the URLs
// the API hands out, and the contract that documents them cannot drift apart — deriving it is what
// makes that a guarantee rather than a note.
//
// Deliberately a function and no constant: with /v1 and /v2 both served, a module-level prefix would
// be one major's answer given to both, which is how a /v1 client ends up holding a /v2 cover URL —
// for a route its own frozen contract documents under /v1, and which, once #134 lands, its token
// cannot open.
//
// The URL is a server-variable template (`http://{host}:{port}/v2`), so the path is taken after the
// authority rather than by parsing it as a URL: the braces are not valid host syntax.
export function versionPrefix(document: Record<string, unknown>): string {
  const servers = document['servers']
  const url = Array.isArray(servers) ? (servers[0] as { url?: unknown } | undefined)?.url : undefined
  const path = typeof url === 'string' ? /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/[^?#]*)/i.exec(url)?.[1] : undefined
  const prefix = path?.replace(/\/+$/, '')
  // Fail at startup rather than mounting an unprefixed API: an unversioned surface would answer
  // every client's requests with whatever major happens to be built (SPEC section 6).
  if (prefix === undefined || prefix === '') {
    throw new Error(`contract servers[0].url carries no version path: ${JSON.stringify(url)}`)
  }
  return prefix
}
