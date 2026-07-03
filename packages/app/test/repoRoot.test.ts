import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { findRepoRoot } from '../src/contract/repoRoot.js'

describe('findRepoRoot', () => {
  it('throws a clear error when no pnpm-workspace.yaml is found above the start dir', () => {
    // The OS temp directory is guaranteed to have no pnpm-workspace.yaml between it and
    // the filesystem root.
    expect(() => findRepoRoot(tmpdir())).toThrow(/pnpm-workspace\.yaml/)
  })
})
