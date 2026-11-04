# ADR-0008: @tanstack/react-query for server state

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
Pages poll and cache API data (queue stats, task lists, task detail) and must invalidate after mutations (cancel, retry) and on SSE `end` events.

## Decision
Use @tanstack/react-query for all REST reads and mutations with typed fetchers that validate responses with @orc/shared Zod schemas; SSE stays a native EventSource hook that invalidates queries.

## Consequences
Consistent caching, retry and invalidation; no global state library needed.

## Alternatives considered
SWR (fewer mutation features); Redux Toolkit Query (heavier); manual fetch plus useEffect (duplicated loading/error handling).

## Rollback path
Fetchers are plain functions; replacing the cache layer changes hooks only.
