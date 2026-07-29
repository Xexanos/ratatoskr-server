// A parsed OpenAPI document as the runtime sees it. The contract package emits each served major's
// document as plain data (no schema type), and the two places that read one — the mount prefix here
// and the token guard's walk over `paths` — both index into it by key. Named so those signatures say
// what they take rather than repeating an anonymous bag.
export type ContractDocument = Record<string, unknown>

// A served major's version-mount prefix, read out of its contract's `servers.url` — which SPEC
// section 6 names as the one place the prefix lives, one place *per major*, so that two majors can be
// served side by side. The Fastify mount (app.ts's openapi-glue `prefix`) and the cover URLs that
// major's responses carry (contractMapping.ts) both come from here, so the mounted routes, the URLs
// the API hands out, and the contract that documents them cannot drift apart — deriving it is what
// makes that a guarantee rather than a note.
//
// Deliberately a function and no constant: with more than one major served, a module-level prefix
// would be one major's answer given to all of them, which is how a client ends up holding a URL into
// a surface its own contract does not document.
//
// The URL is a server-variable template (`http://{host}:{port}/v2`), so the path is taken after the
// authority rather than by parsing it as a URL: the braces are not valid host syntax.
export function versionPrefix(document: ContractDocument): string {
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
