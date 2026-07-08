// Emits the contract's component schemas as a runtime TypeScript module, with the local
// OpenAPI $refs ("#/components/schemas/X") rewritten into the form Fastify/AJV expects
// for schemas registered by $id ("X#"). Doing this at generate time (not at server boot)
// removes any runtime dependency on the repo layout or on reading the YAML — the built
// package is self-contained, which the container deployment (SPEC section 12) needs.
//
// Run via `pnpm --filter @ratatoskr/contract run generate`. Output is gitignored and
// regenerated, exactly like the type definitions next to it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const contractPath = join(here, '..', '..', '..', 'contract', 'openapi.yaml')
const outPath = join(here, '..', 'src', 'generated', 'schemas.ts')

const LOCAL_SCHEMA_REF = '#/components/schemas/'

function rewriteRefs(node) {
  if (Array.isArray(node)) return node.map(rewriteRefs)
  if (node !== null && typeof node === 'object') {
    const out = {}
    for (const [key, value] of Object.entries(node)) {
      out[key] =
        key === '$ref' && typeof value === 'string' && value.startsWith(LOCAL_SCHEMA_REF)
          ? `${value.slice(LOCAL_SCHEMA_REF.length)}#`
          : rewriteRefs(value)
    }
    return out
  }
  return node
}

const doc = load(readFileSync(contractPath, 'utf8'))
const schemas = doc?.components?.schemas ?? {}
const rewritten = {}
for (const [name, schema] of Object.entries(schemas)) {
  rewritten[name] = rewriteRefs(schema)
}

const banner =
  '// GENERATED from contract/openapi.yaml by scripts/generate-schemas.mjs — do not edit.\n' +
  '// Regenerate with `pnpm --filter @ratatoskr/contract run generate`.\n\n'
const body = `export const contractSchemas: Record<string, object> = ${JSON.stringify(rewritten, null, 2)}\n`

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, banner + body)
console.log(`wrote ${Object.keys(rewritten).length} schemas to ${outPath}`)

// The full, unmodified OpenAPI document as a runtime object, for fastify-openapi-glue's
// `specification` option. Unlike contractSchemas, refs are left standard
// ("#/components/schemas/X") — glue dereferences them itself — so this must NOT be rewritten.
const docOutPath = join(here, '..', 'src', 'generated', 'openapi-document.ts')
const docBody = `export const openapiDocument: Record<string, unknown> = ${JSON.stringify(doc, null, 2)}\n`
writeFileSync(docOutPath, banner + docBody)
console.log(`wrote the OpenAPI document to ${docOutPath}`)
