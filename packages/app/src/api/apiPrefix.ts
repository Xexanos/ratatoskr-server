// Single source of truth for the API version-mount prefix (SPEC section 6: "Keep the version
// prefix in one place so a future /v2 can be served alongside /v1"). app.ts reads it once, for
// both the Fastify mount (openapi-glue's `prefix`) and the ApiService it hands the same value to,
// so the mounted routes and the URLs the API hands out can never drift apart.
export const API_PREFIX = '/v1'
