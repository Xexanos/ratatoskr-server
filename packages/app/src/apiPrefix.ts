// Single source of truth for the API version-mount prefix (SPEC section 6: "Keep the version
// prefix in one place so a future /v2 can be served alongside /v1"). Both the Fastify mount
// (app.ts's openapi-glue `prefix`) and the cover URL built into the library projection
// (abs/client.ts) read this, so the mounted routes and the URLs the API hands out can never
// drift apart.
export const API_PREFIX = '/v1'
