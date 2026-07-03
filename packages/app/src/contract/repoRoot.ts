import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Locates the monorepo root by walking up from a starting directory until the
// workspace marker is found. This keeps contract loading independent of whether the
// code runs via ts-node/tsx (src/) or compiled output (dist/), and independent of the
// process's current working directory.
export function findRepoRoot(startDir: string): string {
  let dir = startDir
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`Could not locate repo root (pnpm-workspace.yaml) above ${startDir}`)
    }
    dir = parent
  }
}

export function repoRootFromHere(importMetaUrl: string): string {
  return findRepoRoot(dirname(fileURLToPath(importMetaUrl)))
}
