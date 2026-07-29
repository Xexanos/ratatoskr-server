import type { FastifyInstance } from 'fastify'
import { buildApp, type BuildAppOptions } from '../../src/api/app.js'
import type { SessionStore } from '../../src/auth/sessionStore.js'
import type { Config } from '../../src/config/index.js'
import { tempSessionStore } from './tempSessionStore.js'
import { testConfig } from './testConfig.js'

// buildApp around a throwaway session store, since buildApp opens one as part of startup wiring
// (app.ts) and the configured path in testConfig deliberately cannot be written.
//
// One signed-in device, as the /v2 route tests see it: the opaque Ratatoskr token a client sends, and
// the private Audiobookshelf chain the server holds behind it. Keeping the two visibly different is
// the point — every assertion that an upstream call carries ABS_CHAIN.accessToken is also an
// assertion that the caller's own bearer never reaches Audiobookshelf (ADR-0001).
export const DEVICE_TOKEN = 'rtk-device-token'
export const ABS_CHAIN = { accessToken: 'abs-chain-access', refreshToken: 'abs-chain-refresh' }
export const DEVICE_USER = { absUserId: 'usr-1', absUsername: 'listener' }
// The bearer a signed-in /v2 client sends.
export const V2_AUTH = { authorization: `Bearer ${DEVICE_TOKEN}` }

export interface TestApp {
  app: FastifyInstance
  store: SessionStore
}

// `signedIn: false` for the tests that are about what happens to a caller this server knows nothing
// about.
export async function buildTestApp(
  options: BuildAppOptions = {},
  { config = testConfig(), signedIn = true }: { config?: Config; signedIn?: boolean } = {},
): Promise<TestApp> {
  const store = options.sessionStore ?? (await tempSessionStore())
  if (signedIn) await store.create(DEVICE_TOKEN, { ...DEVICE_USER, chain: ABS_CHAIN })
  return { app: await buildApp(config, { ...options, sessionStore: store }), store }
}
