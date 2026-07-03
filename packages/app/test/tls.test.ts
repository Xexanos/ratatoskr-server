import { Server as HttpsServer } from 'node:https'
import { get as httpsGet } from 'node:https'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/api/app.js'
import type { Config } from '../src/config/index.js'

// The one thing worth proving end-to-end here (SPEC section 14): a configured
// certificate actually results in a real, working HTTPS listener — not just that the
// `https` option was accepted by the types. This is the code path behind the
// `as unknown as FastifyInstance` cast in api/app.ts.
const FIXTURES = fileURLToPath(new URL('./fixtures/tls/', import.meta.url))

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    absUrl: 'http://abs.invalid',
    absStreamerUser: 'streamer',
    absStreamerPassword: 'secret',
    sonosSeedHost: undefined,
    port: 0,
    pollIntervalSeconds: 15,
    seekSettleMs: 1000,
    seekToleranceSeconds: 3,
    seekRetries: 2,
    progressWriteThresholdSeconds: 5,
    tls: undefined,
    ...overrides,
  }
}

describe('buildApp TLS wiring', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.unstubAllGlobals()
  })

  it('serves over plain HTTP when no TLS is configured', async () => {
    app = await buildApp(testConfig())
    expect(app.server).not.toBeInstanceOf(HttpsServer)
  })

  it('serves real traffic over HTTPS when a certificate is configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unreachable in test')))

    app = await buildApp(
      testConfig({
        tls: { certPath: `${FIXTURES}cert.pem`, keyPath: `${FIXTURES}key.pem` },
      }),
    )
    expect(app.server).toBeInstanceOf(HttpsServer)

    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('expected the server to report an AddressInfo after listen()')
    }

    const body = await new Promise<string>((resolve, reject) => {
      const req = httpsGet(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/v1/health',
          // The fixture cert is self-signed; that's expected and fine for this test.
          rejectUnauthorized: false,
        },
        (res) => {
          let data = ''
          res.on('data', (chunk: Buffer) => (data += chunk.toString()))
          res.on('end', () => resolve(data))
        },
      )
      req.on('error', reject)
    })

    expect(JSON.parse(body).status).toBe('degraded')
  })
})
