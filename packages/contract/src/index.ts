// Public surface of the generated contract artifacts. Everything here is derived from the contract
// YAML in the `generate` step and is never hand-edited (SPEC section 6).
export { openapiDocument } from './generated/openapi-document.js'
// Contract 1.4.0, served in parallel under /v1 for the transition window (SPEC section 6). Only the
// document is generated for it, no types: the /v1 surface is finished code that no longer grows, and
// the few shapes it alone needs are declared where they are used.
export { frozenV1Document } from './generated/openapi-document-v1.js'
export type { components, paths, operations } from './generated/openapi.js'
