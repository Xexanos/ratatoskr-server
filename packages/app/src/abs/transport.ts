import { Agent } from 'undici'
import type { Config } from '../config/index.js'

// Builds the fetch `dispatcher` for the ABS connection from the TLS trust config (SPEC section
// 14). Returns undefined for the normal case (verify against the system CAs) so fetch uses its
// default; a custom Agent only when the operator pins a self-signed / private-CA cert or has
// explicitly disabled verification. Scoped to the ABS client, so `rejectUnauthorized: false`
// never affects any other outbound request.
//
// The undici `Agent` and the global fetch `dispatcher` option are typed by two copies of the
// undici types (the `undici` package vs the `undici-types` pulled in by @types/node). They are
// structurally identical, but TypeScript won't unify their recursive `compose` signature, so we
// cast the Agent to the exact type the global fetch expects. It is the same undici Agent at
// runtime — only the type identity differs.
export function buildAbsDispatcher(config: Config): RequestInit['dispatcher'] {
  let agent: Agent | undefined
  if (config.absCaCert !== undefined) {
    agent = new Agent({ connect: { ca: config.absCaCert } })
  } else if (config.absTlsInsecure) {
    agent = new Agent({ connect: { rejectUnauthorized: false } })
  }
  return agent as unknown as RequestInit['dispatcher']
}
