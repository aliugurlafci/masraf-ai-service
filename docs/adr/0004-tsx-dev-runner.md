# ADR-0004: tsx for development and CLI scripts

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
Developers and agents need watch-mode execution of TypeScript sources on the Windows dev host without a build step.

## Decision
`tsx watch` runs apps in development; `tsx` runs TypeScript scripts under `scripts/`. Never used in production images.

## Consequences
Fast iteration; dev behaviour can differ slightly from the bundled build, so e2e tests use in-process factories and the image build is verified by DevOps.

## Alternatives considered
Node type stripping (no path aliases, still evolving); ts-node (slower, ESM friction).

## Rollback path
Swap the dev scripts to another runner; no source changes.
