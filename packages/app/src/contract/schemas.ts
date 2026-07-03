import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { repoRootFromHere } from './repoRoot.js'

// contract/openapi.yaml is the single source of truth (SPEC section 6). Rather than
// hand-duplicating JSON schemas for runtime response validation, we load the contract's
// components.schemas directly and register them with Fastify's validator, so a route's
// declared response schema is always the real contract shape. The only transformation
// needed is rewriting OpenAPI-local $refs ("#/components/schemas/X") into the form
// Fastify/AJV expects for schemas registered by $id ("X#").
const LOCAL_SCHEMA_REF = '#/components/schemas/'

function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs)
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] =
        key === '$ref' && typeof value === 'string' && value.startsWith(LOCAL_SCHEMA_REF)
          ? `${value.slice(LOCAL_SCHEMA_REF.length)}#`
          : rewriteRefs(value)
    }
    return out
  }
  return node
}

interface OpenApiDocument {
  components?: {
    schemas?: Record<string, object>
  }
}

export function loadContractSchemas(importMetaUrl: string): Record<string, object> {
  const contractPath = join(repoRootFromHere(importMetaUrl), 'contract', 'openapi.yaml')
  const doc = load(readFileSync(contractPath, 'utf8')) as OpenApiDocument
  const schemas = doc.components?.schemas ?? {}

  const out: Record<string, object> = {}
  for (const [name, schema] of Object.entries(schemas)) {
    out[name] = rewriteRefs(schema) as object
  }
  return out
}
