# ADR-0022: Per-workspace codebase-memory-mcp cache directories

- Status: Accepted (2026-11-02); amended by ADR-0024 (cache dirs owned by the lease uid; Claude file tools denied on CBM_CACHE_DIR)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
The brief used one per-worker `CBM_CACHE_DIR`. Claude's own MCP server reads that cache, so it could query indexes of other projects' worktrees by name, violating cross-project isolation.

## Decision
Cache directories are scoped: `<CBM_CACHE_DIR>/p/<projectId>` for the project base index and `<CBM_CACHE_DIR>/w/<workspaceId>` for each attempt workspace; both the orchestrator's indexing and Claude's `--mcp-config` server use the workspace cache and `CBM_ALLOWED_ROOT=<worktree>`. Cleanup deletes the index and the directory. (Changes brief D10.)

## Consequences
Claude sees only its own index; each workspace is indexed from scratch (mode from the project setting).

## Alternatives considered
Single shared cache (leaks); copying the project index into the workspace cache (depends on an undocumented cache layout).

## Rollback path
Point all scopes at one directory again by changing `cacheDir(scope)`.
