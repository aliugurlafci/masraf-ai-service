# ADR-0007: react-router for SPA routing

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
The web app has about fifteen screens (dashboard, projects, tasks, task detail tabs, agents/teams, workers/queue, audit, error pages) that need deep links and protected routes.

## Decision
Use react-router (current major, library/data mode, no framework/SSR mode) with route-level permission guards based on `/auth/me` permissions.

## Consequences
Standard routing; no server rendering needed because nginx serves static assets with SPA fallback.

## Alternatives considered
TanStack Router (smaller ecosystem for the team); a hand-written router (error-prone).

## Rollback path
Routes are isolated in one module; swapping the router touches routing files only.
