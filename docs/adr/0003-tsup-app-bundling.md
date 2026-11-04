# ADR-0003: tsup bundles deployable entry points

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
Source-first packages (ADR-0001) cannot run directly in production containers without a TypeScript loader, and shipping the full monorepo into each image enlarges the attack surface.

## Decision
apps/api, apps/worker, apps/egress-proxy and the DB CLI (`orc-db`) are bundled with tsup (esbuild) into `dist/*.js`: ESM, target node24, `noExternal: [/^@orc\//]`, third-party dependencies external (installed with `npm ci --omit=dev` in the image), sourcemaps on, `APP_VERSION` injected via `define`.

## Consequences
Small images containing only bundled code and production node_modules; stack traces map via sourcemaps.

## Alternatives considered
Plain `tsc` emit (needs per-package builds and path rewriting); running TypeScript in production via tsx or type stripping (loader in prod, slower start, type-only import pitfalls).

## Rollback path
Replace tsup with the esbuild CLI or `tsc` emit; entry points and Dockerfiles change only in the build stage.
