# ADR-0002: @orc/shared is browser-safe; node helpers live in @orc/shared/node

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
apps/web imports DTO types and Zod schemas from @orc/shared. Config loading (`_FILE` secrets), the DB-name guard and process utilities need `node:*` modules, which break Vite builds and leak server code into the bundle.

## Decision
`@orc/shared` main entry contains only zod and pure TS (no `node:*`, no `Buffer`, no `process`). Node-only helpers are exported from the subpath `@orc/shared/node` (config schemas/loaders, `assertDbNameForEnv`, `runProcess`, `spawnSupervised`, `killProcessTree`, process registry, orphan sweep). apps/web may import only the main entry.

## Consequences
Process supervision code is shared by git-manager, claude-runner and orchestrator without a new package; a lint rule and the dependency test block `@orc/shared/node` in apps/web.

## Alternatives considered
Separate `@orc/config` and `@orc/process` packages (not in the mandated repository layout); duplicating process code per package (divergent kill semantics).

## Rollback path
Move the `node` subpath into new packages and update imports; the main entry is unaffected.
