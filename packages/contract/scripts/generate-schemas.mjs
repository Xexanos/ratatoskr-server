// Emits the full OpenAPI document as a runtime TypeScript module for fastify-openapi-glue's
// `specification` option (glue dereferences the refs itself, so no rewriting is needed). Doing
// this at generate time — not at server boot — removes any runtime dependency on the repo layout
// or on reading the YAML, so the built package is self-contained for the container deployment
// (SPEC section 12).
//
// Run via `pnpm --filter @ratatoskr/contract run generate`. Output is gitignored and
// regenerated, exactly like the type definitions next to it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const contractPath = join(here, '..', '..', '..', 'contract', 'openapi.yaml')
const outPath = join(here, '..', 'src', 'generated', 'openapi-document.ts')

const doc = load(readFileSync(contractPath, 'utf8'))

const banner =
  '// GENERATED from contract/openapi.yaml by scripts/generate-schemas.mjs — do not edit.\n' +
  '// Regenerate with `pnpm --filter @ratatoskr/contract run generate`.\n\n'
const body = `export const openapiDocument: Record<string, unknown> = ${JSON.stringify(doc, null, 2)}\n`

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, banner + body)
console.log(`wrote the OpenAPI document to ${outPath}`)
