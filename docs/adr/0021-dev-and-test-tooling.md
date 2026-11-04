# ADR-0021: Development and test tooling

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
Lint, typecheck and web component tests need tooling outside the mandatory stack (Vitest and Supertest are mandatory).

## Decision
ESLint (flat config) with typescript-eslint (strict type-checked), @vitejs/plugin-react, @testing-library/react, @testing-library/user-event and jsdom for the `web` Vitest project, pino-pretty (development only). TypeScript version: the newest release supported by typescript-eslint (Platform pins it).

## Consequences
Standard toolchain; all are devDependencies absent from production images.

## Alternatives considered
Biome (no type-aware rules comparable to typescript-eslint); happy-dom (less complete DOM).

## Rollback path
Tooling is confined to devDependencies and config files.
