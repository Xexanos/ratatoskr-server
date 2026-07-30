import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from '../src/auth/sessionFile.js'

// writeFileAtomic stages the bytes through a temp file and renames it over the target, so a crash
// leaves either the old store or a new one, never a torn mix. The temp name carries that guarantee,
// and it has to be unique per writer: two containers sharing one /data volume both run as PID 1 (the
// deployment this whole store hardening exists for), so a process-id suffix cannot tell them apart,
// and two writers on one temp name defeat the atomic replace outright.

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rtk-atomic-'))
  path = join(dir, 'sessions.enc')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('publishes the bytes it was given', async () => {
    await writeFileAtomic(path, Buffer.from('hello'))
    expect((await readFile(path)).toString()).toBe('hello')
  })

  // The regression guard for the shared-volume hazard. Before a per-write suffix, concurrent writers
  // that a process id could not distinguish (identical in a container) raced on `${path}.${pid}.tmp`:
  // one writer's exclusive open hit the file another had just staged, failing with EEXIST. The
  // assertion is on that collision specifically rather than on "no writer failed", because what a
  // given platform does with concurrent renames onto one existing target differs (POSIX replaces
  // atomically; Windows refuses) and is beside the point — the fix is about the temp name, not the
  // rename. Whatever happens there, the published file is still exactly one writer's whole payload.
  it('gives writers that share a process id distinct temp names, so their exclusive opens do not collide', async () => {
    const payloads = Array.from({ length: 64 }, (_, i) => Buffer.from(`payload-${i}`.padEnd(4096, `${i}`)))

    const results = await Promise.allSettled(payloads.map((bytes) => writeFileAtomic(path, bytes)))

    const failureCodes = results.flatMap((result) =>
      result.status === 'rejected' ? [(result.reason as NodeJS.ErrnoException).code] : [],
    )
    expect(failureCodes).not.toContain('EEXIST')
    const published = await readFile(path)
    expect(payloads.some((bytes) => bytes.equals(published))).toBe(true)
  })
})
