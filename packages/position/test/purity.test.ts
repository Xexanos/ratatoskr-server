import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Architectural guard for SPEC section 13: the position package must stay pure and
// I/O-free. Zero runtime dependencies makes that impossible to violate by accident —
// this test fails loudly if one ever gets added.
describe('package purity (SPEC section 13)', () => {
  it('declares zero runtime dependencies', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> }
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([])
  })
})
