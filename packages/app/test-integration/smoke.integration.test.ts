import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { AddressInfo, createServer as createNetServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { Ajv } from 'ajv'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

// Process-level smoke tests: the real compiled server, spawned as a child process,
// spoken to over real HTTP — no inject(), no fetch stubbing. This is the automated
// version of the manual "boot it and curl /v1/health" verification, and it pins down
// the one file no unit test executes: main.ts.

const DIST_MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const CONTRACT = fileURLToPath(new URL('../../../contract/openapi.yaml', import.meta.url))

// Env keys the config reader consumes — removed from the inherited env so the test is
// hermetic no matter what the host shell has set. The rest of process.env is inherited
// on purpose (PATH, and SystemRoot, without which networking breaks on Windows).
const CONFIG_KEYS = [
  'ABS_URL',
  'ABS_STREAMER_USER',
  'ABS_STREAMER_PASSWORD',
  'SONOS_SEED_HOST',
  'PORT',
  'POLL_INTERVAL_SECONDS',
  'SEEK_SETTLE_MS',
  'SEEK_TOLERANCE_SECONDS',
  'SEEK_RETRIES',
  'PROGRESS_WRITE_THRESHOLD_SECONDS',
  'TLS_CERT_PATH',
  'TLS_KEY_PATH',
  'ALLOW_PLAIN_HTTP',
]

function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of CONFIG_KEYS) delete env[key]
  return { ...env, ...overrides }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

interface SpawnedServer {
  child: ChildProcess
  stdout: () => string
  stderr: () => string
}

function spawnServer(env: NodeJS.ProcessEnv): SpawnedServer {
  const child = spawn(process.execPath, [DIST_MAIN], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  })
  let out = ''
  let err = ''
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()))
  return { child, stdout: () => out, stderr: () => err }
}

// Poll /v1/health until the server answers. Races against the child's exit so a
// misconfigured server surfaces its stderr instead of an opaque timeout.
async function waitUntilReady(server: SpawnedServer, port: number, deadlineMs = 15_000): Promise<void> {
  let exited = false
  server.child.once('exit', () => (exited = true))

  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`server process exited before becoming ready.\nstderr:\n${server.stderr()}`)
    }
    try {
      await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1000) })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`server did not become ready within ${deadlineMs}ms.\nstderr:\n${server.stderr()}`)
}

describe('server process smoke test', () => {
  let running: SpawnedServer | undefined
  let fakeAbs: Server | undefined

  beforeAll(() => {
    try {
      statSync(DIST_MAIN)
    } catch {
      throw new Error(`${DIST_MAIN} not found — run \`pnpm run build\` before test:integration`)
    }
  })

  afterEach(async () => {
    if (running && running.child.exitCode === null) {
      running.child.kill('SIGTERM')
      await Promise.race([
        once(running.child, 'exit'),
        new Promise((r) => setTimeout(r, 5000)).then(() => running?.child.kill('SIGKILL')),
      ])
    }
    running = undefined
    if (fakeAbs) {
      // The child's undici fetch holds keep-alive connections; close() alone would hang.
      fakeAbs.closeAllConnections()
      await new Promise((r) => fakeAbs?.close(r))
      fakeAbs = undefined
    }
  })

  it('boots, serves /v1/health over real HTTP, and conforms to the contract', async () => {
    // A real HTTP upstream standing in for Audiobookshelf — any response counts as
    // reachable, which is exactly the health check's own contract.
    fakeAbs = createServer((_req, res) => res.end('ok'))
    await new Promise<void>((r) => fakeAbs?.listen(0, '127.0.0.1', r))
    const absPort = (fakeAbs.address() as AddressInfo).port

    const port = await freePort()
    running = spawnServer(
      cleanEnv({
        ABS_URL: `http://127.0.0.1:${absPort}`,
        ABS_STREAMER_USER: 'streamer',
        ABS_STREAMER_PASSWORD: 'secret',
        ALLOW_PLAIN_HTTP: 'true',
        PORT: String(port),
      }),
    )
    await waitUntilReady(running, port)

    const res = await fetch(`http://127.0.0.1:${port}/v1/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    expect(body.status).toBe('ok')
    expect(body.abs).toEqual({ reachable: true })
    expect((body.sonos as { reachable: boolean }).reachable).toBe(false)
    // SPEC section 14: /health must not leak the server version to unauthenticated callers.
    expect(body.version).toBeUndefined()

    // Independent contract conformance: validate against the raw contract document, not
    // the server's own (ref-rewritten) schema copies — the server must not grade its own
    // homework. strict:false because the contract uses OpenAPI-3.0 keywords (nullable,
    // format: double) that plain Ajv rejects; note this *ignores* nullable rather than
    // honoring it, which is fine here since Health has no nullable fields.
    const ajv = new Ajv({ strict: false })
    ajv.addSchema(load(readFileSync(CONTRACT, 'utf8')) as object, 'contract')
    const validate = ajv.getSchema('contract#/components/schemas/Health')
    if (!validate) throw new Error('Health schema not found in contract')
    const valid = validate(body)
    expect(validate.errors).toBeNull()
    expect(valid).toBe(true)
  })

  it('refuses to start with missing config, reporting all problems at once', async () => {
    running = spawnServer(cleanEnv())
    const [code] = (await once(running.child, 'exit')) as [number | null]

    expect(code).toBe(1)
    const stderr = running.stderr()
    expect(stderr).toContain('ABS_URL is required')
    expect(stderr).toContain('ABS_STREAMER_USER is required')
    expect(stderr).toContain('ABS_STREAMER_PASSWORD is required')
    expect(stderr).toContain('no TLS configured')
  })
})
