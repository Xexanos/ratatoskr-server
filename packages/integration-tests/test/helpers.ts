import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, statSync } from 'node:fs'
import { AddressInfo, createServer as createNetServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { Ajv, type ValidateFunction } from 'ajv'

// Shared harness for the process-level integration tests: they spawn the real compiled
// server (packages/app/dist/main.js) and talk to it over real HTTP — no fetch stubbing.
// Both the config/health smoke test and the live-Audiobookshelf tests build on this.

export const DIST_MAIN = fileURLToPath(new URL('../../app/dist/main.js', import.meta.url))

// The contract of each served major, keyed by its mount prefix (SPEC section 6). `/v1` is the copy of
// contract 1.4.0 that the contract-freeze CI job holds byte-identical to the contract-1.4.0 tag, so
// grading a /v1 response against this file is grading it against that tag.
export const CONTRACTS = {
  '/v1': fileURLToPath(new URL('../../../contract/v1/openapi.yaml', import.meta.url)),
  '/v2': fileURLToPath(new URL('../../../contract/openapi.yaml', import.meta.url)),
} as const

export type ServedMajor = keyof typeof CONTRACTS

// Env keys the config reader consumes — removed from the inherited env so a test is
// hermetic no matter what the host shell has set. The rest of process.env is inherited
// on purpose (PATH, and SystemRoot, without which networking breaks on Windows).
export const CONFIG_KEYS = [
  'ABS_URL',
  'ABS_ALLOW_PLAIN_HTTP',
  'ABS_STREAMER_API_KEY',
  'ABS_CA_CERT',
  'ABS_CA_CERT_PATH',
  'ABS_TLS_INSECURE',
  'SONOS_SEED_HOST',
  'PORT',
  'POLL_INTERVAL_SECONDS',
  'SEEK_SETTLE_MS',
  'SEEK_TOLERANCE_SECONDS',
  'SEEK_RETRIES',
  'PROGRESS_WRITE_THRESHOLD_SECONDS',
  'LISTENING_TOKEN_REFRESH_MARGIN_SECONDS',
  'SHUTDOWN_TIMEOUT_MS',
  'RESUME_REWIND_SECONDS',
  'WRITE_POSITION_BACKOFF_SECONDS',
  'TLS_CERT_PATH',
  'TLS_KEY_PATH',
  'ALLOW_PLAIN_HTTP',
  'VALIDATE_RESPONSES',
]

export function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of CONFIG_KEYS) delete env[key]
  return { ...env, ...overrides }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

export interface SpawnedServer {
  child: ChildProcess
  stdout: () => string
  stderr: () => string
}

export function spawnServer(env: NodeJS.ProcessEnv): SpawnedServer {
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

// Poll /v2/health until the server answers. Races against the child's exit so a
// misconfigured server surfaces its stderr instead of an opaque timeout.
export async function waitUntilReady(server: SpawnedServer, port: number, deadlineMs = 15_000): Promise<void> {
  let exited = false
  server.child.once('exit', () => (exited = true))

  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`server process exited before becoming ready.\nstderr:\n${server.stderr()}`)
    }
    try {
      await fetch(`http://127.0.0.1:${port}/v2/health`, { signal: AbortSignal.timeout(1000) })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`server did not become ready within ${deadlineMs}ms.\nstderr:\n${server.stderr()}`)
}

// Stop a spawned server and wait for it to actually exit. SIGTERM first; if it has not gone
// within the grace window, SIGKILL. The kill timer is cleared on the fast path (no dangling
// timer to complicate vitest worker teardown), and we always await the real `exit` event —
// the SIGKILL branch only proves the signal was *sent*, not that the process is gone.
export async function stopServer(server: SpawnedServer): Promise<void> {
  const child = server.child
  if (child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const forceKill = new Promise<void>((resolve) => {
    killTimer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 5000)
  })
  await Promise.race([exited, forceKill])
  if (killTimer) clearTimeout(killTimer)
  await exited
}

// Fail with an actionable message if the server has not been built — every integration
// test needs dist/main.js to exist first (`pnpm run build`).
export function assertServerBuilt(): void {
  try {
    statSync(DIST_MAIN)
  } catch {
    throw new Error(`${DIST_MAIN} not found — run \`pnpm run build\` before test:integration`)
  }
}

// Independent contract conformance: validate a live response against the raw contract
// document, not the server's own (ref-rewritten) schema copies — the server must not grade
// its own homework. strict:false because the contract uses OpenAPI-3.0 keywords (nullable,
// format: double) that plain Ajv rejects; note this *ignores* nullable rather than honoring
// it, which is fine for the shapes asserted here (their required fields are never null).
//
// One Ajv per served major, because a schema name means different things in each: a /v1 Session may
// carry the rotation handover, a /v2 one has no such field. Grading a response against the other
// major's document would accept shapes the major it came from does not promise.
const contractAjvs = new Map<ServedMajor, Ajv>()

export function contractValidator(schemaName: string, major: ServedMajor = '/v2'): ValidateFunction {
  let ajv = contractAjvs.get(major)
  if (ajv === undefined) {
    ajv = new Ajv({ strict: false })
    ajv.addSchema(load(readFileSync(CONTRACTS[major], 'utf8')) as object, 'contract')
    contractAjvs.set(major, ajv)
  }
  const validate = ajv.getSchema(`contract#/components/schemas/${schemaName}`)
  if (!validate) throw new Error(`${schemaName} schema not found in the ${major} contract`)
  return validate as ValidateFunction
}
