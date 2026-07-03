import fastifyResponseValidation from '@fastify/response-validation'
import { contractSchemas } from '@ratatoskr/contract'
import { Ajv } from 'ajv'
import type { FastifyInstance } from 'fastify'

// Dev/test only. Fastify's route response schemas only serialize (fast-json-stringify);
// they do not validate enum values or shape. This registers real response validation
// against the contract schemas so drift is caught in tests. Kept in a separate module
// that app.ts imports dynamically, so ajv and the plugin — both devDependencies — never
// load in production.
export function enableResponseValidation(app: FastifyInstance): void {
  // Own Ajv instance seeded with the contract's shared schemas, so route responses
  // declared as `{ $ref: 'Name#' }` resolve. strict:false because the contract uses
  // OpenAPI 3.0 keywords (nullable, format: double) that plain Ajv rejects in strict mode.
  const ajv = new Ajv({ strict: false, coerceTypes: false, allErrors: true })
  for (const [name, schema] of Object.entries(contractSchemas)) {
    ajv.addSchema({ $id: name, ...schema })
  }
  app.register(fastifyResponseValidation, { ajv })
}
