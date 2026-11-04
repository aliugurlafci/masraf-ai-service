# ADR-0010: swagger-ui-express serves interactive docs

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
Operators and integrators need a local, offline API explorer; no external documentation hosting is allowed.

## Decision
Serve Swagger UI at `/api/docs` with swagger-ui-express (assets from node_modules, no CDN), fed by `/api/openapi.json`, controlled by `SWAGGER_UI_ENABLED`, with a strict CSP for that route.

## Consequences
Local docs with try-it-out using the session cookie (CSRF header required for unsafe calls).

## Alternatives considered
Redoc (read-only, separate bundling); no UI (worse operability).

## Rollback path
Disable via config or remove the route; the OpenAPI document remains.
