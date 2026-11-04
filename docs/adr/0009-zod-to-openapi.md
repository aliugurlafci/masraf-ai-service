# ADR-0009: @asteasolutions/zod-to-openapi generates OpenAPI 3.1

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
API documentation must not drift from validation. All request/response schemas already exist as Zod schemas in @orc/shared.

## Decision
Generate `/api/openapi.json` (OpenAPI 3.1) at API startup from an `OpenAPIRegistry` populated with the @orc/shared schemas and route definitions (`OpenApiGeneratorV31`), using a release line that supports Zod 4. Registration lives in apps/api so @orc/shared stays free of OpenAPI metadata.

## Consequences
The spec is always in sync with runtime validation; a test asserts every route of contract §9.5 appears in the document.

## Alternatives considered
Zod 4 native `z.toJSONSchema` plus a hand-written paths object (more manual wiring); hand-maintained YAML (drifts).

## Rollback path
Replace the generator with `z.toJSONSchema` assembly; the endpoint URL stays the same.
