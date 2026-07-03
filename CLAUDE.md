# Ratatoskr server

Authoritative context lives in two files — read them before doing anything:
- `docs/SPEC.md` — goal, scope, architecture, decisions, constraints.
- `contract/openapi.yaml` — the single source of truth for the client/server API.

Working agreements:
- The OpenAPI contract is authoritative. Do not change it without following the
  versioning rules in SPEC section 6.
- Audiobookshelf is the single source of truth for progress. No database.
- Technology stack and module layout are still open — propose, discuss, then update SPEC.