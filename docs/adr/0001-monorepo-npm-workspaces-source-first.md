# ADR-0001: npm workspaces monorepo with source-first packages

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
Fourteen packages/apps are developed in parallel by eight teams. A per-package build step slows feedback and causes stale `dist` mismatches; requirement §9 fixes the folder layout.

## Decision
npm workspaces (`apps/*`, `packages/*`), names `@orc/*`, ESM everywhere, TypeScript strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, no enums/namespaces). Library `exports` point at `./src/index.ts`; one root `tsc --noEmit` typechecks everything (apps/web has its own DOM tsconfig). Only deployable entry points are bundled (ADR-0003). Allowed import edges are fixed in contract §1.2 and enforced by a test and ESLint.

## Consequences
No build cache per package; apps must be bundled for production; deep imports are forbidden so the public surface stays the contract's.

## Alternatives considered
Turborepo/Nx (extra tooling, not needed at this size); project references with per-package `tsc -b` (slower, duplicated config); pnpm (not in the verified toolchain).

## Rollback path
Add `build` scripts and switch `exports` to `./dist/*.js` per package; no code changes in consumers.
