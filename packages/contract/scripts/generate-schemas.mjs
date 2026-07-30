// Emits each served major's OpenAPI document as a runtime TypeScript module for
// fastify-openapi-glue's `specification` option (glue dereferences the refs itself, so no rewriting
// is needed). Doing this at generate time — not at server boot — removes any runtime dependency on
// the repo layout or on reading the YAML, so the built package is self-contained for the container
// deployment (SPEC section 12).
//
// Two majors are served side by side during the transition window (SPEC section 6): the contract
// under development, and contract 1.4.0 frozen under /v1. Both are read from a YAML file in the
// build context rather than from the git tag the freeze is named after, so the image build needs no
// history and stays hermetic; what keeps the frozen copy honest is the contract-freeze CI job,
// which diffs it against that tag.
//
// Run via `pnpm --filter @ratatoskr/contract run generate`. Output is gitignored and
// regenerated, exactly like the type definitions next to it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const outDir = join(here, '..', 'src', 'generated')

// One entry per served major. `pinnedVersion` is set for a frozen document: its whole point is that
// it never moves, so the version it has to report is stated here rather than trusted.
const documents = [
  { source: join(repoRoot, 'contract', 'openapi.yaml'), out: 'openapi-document.ts', name: 'openapiDocument' },
  {
    source: join(repoRoot, 'contract', 'v1', 'openapi.yaml'),
    out: 'openapi-document-v1.ts',
    name: 'frozenV1Document',
    pinnedVersion: '1.4.0',
  },
]

mkdirSync(outDir, { recursive: true })

for (const document of documents) {
  const source = describe(document)
  const doc = load(readFileSync(document.source, 'utf8'))
  check(doc, document, source)

  const banner =
    `// GENERATED from ${source} by scripts/generate-schemas.mjs — do not edit.\n` +
    '// Regenerate with `pnpm --filter @ratatoskr/contract run generate`.\n\n'
  const body = `export const ${document.name}: Record<string, unknown> = ${JSON.stringify(doc, null, 2)}\n`

  const outPath = join(outDir, document.out)
  writeFileSync(outPath, banner + body)
  console.log(`wrote ${document.name} (from ${source}) to ${outPath}`)
}

// The version and the mount prefix are two statements about the same major, kept in two places a
// contract edit can touch independently (SPEC section 6: the prefix lives in `servers.url`). A
// mismatch would mount a major under another major's path — served happily and wrong — so it fails
// the build here, where the document is being read anyway, instead of at runtime.
function check(doc, document, source) {
  const version = doc?.info?.version
  if (typeof version !== 'string') {
    fail(source, `info.version is missing or not a string (${JSON.stringify(version)})`)
  }
  if (document.pinnedVersion !== undefined && version !== document.pinnedVersion) {
    fail(source, `expected the frozen contract ${document.pinnedVersion}, found ${version}`)
  }
  const url = doc?.servers?.[0]?.url
  const path = typeof url === 'string' ? /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/[^?#]*)/i.exec(url)?.[1] : undefined
  const prefix = path?.replace(/\/+$/, '')
  if (prefix !== `/v${version.split('.')[0]}`) {
    fail(source, `info.version ${version} does not match the servers[0].url prefix ${JSON.stringify(prefix)}`)
  }
}

function fail(source, message) {
  console.error(`${source}: ${message}`)
  process.exit(1)
}

function describe(document) {
  return relative(repoRoot, document.source).replace(/\\/g, '/')
}
