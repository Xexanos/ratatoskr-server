import fastifyResponseValidation from '@fastify/response-validation'
import { Ajv } from 'ajv'
import type { FastifyInstance } from 'fastify'

// Dev/test guard, enabled via config.validateResponses. Fastify's route response schemas only
// serialize (fast-json-stringify); they do not validate enum values or shape. This registers
// real response validation so drift is caught. Kept in a separate module that app.ts imports
// dynamically, so ajv and the plugin — both devDependencies — never load in production.
export function enableResponseValidation(app: FastifyInstance): void {
  // openapi-glue fully dereferences the spec before setting route schemas, so the response
  // schemas carry no $refs and Ajv needs no shared-schema seeding. strict:false because the
  // contract uses OpenAPI 3.0 keywords (nullable, format: double) that plain Ajv rejects.
  const ajv = new Ajv({ strict: false, coerceTypes: false, allErrors: true })
  app.register(fastifyResponseValidation, { ajv })
}
