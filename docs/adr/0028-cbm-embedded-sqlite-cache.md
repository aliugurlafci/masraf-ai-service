# ADR-0028: codebase-memory-mcp's embedded SQLite store is a disposable cache, not an application datastore

- Status: Accepted (2026-11-02, contract v2.0.0)
- Deciders: Solution Architecture Manager; GPM approval with contract v2.0.0
- Contract: `docs/architecture/contract.md` §11.1, §12.3, §10.11
- Review finding: F14

## Context
Requirement §3 forbids SQLite. The mandated tool codebase-memory-mcp keeps its graph in local database files. Verified on the development host (v0.12.0): the cache directory holds one `<project>.db` per index plus `activity.db`, and the files start with the header `SQLite format 3`.

## Decision
The SQLite files are an internal, embedded cache of the mandated codebase-memory-mcp binary, confined to `CBM_CACHE_DIR` (per project `p/<projectId>`, per workspace `w/<workspaceId>`, ADR-0022). They hold no platform data: tasks, logs, sessions, users, audit records, index operation records and impact results are stored only in MSSQL (`McpIndexOperations`), the only system of record. The cache is disposable: deleting it loses nothing that a re-index cannot rebuild, and cleanup deletes it with the workspace. No application code opens these files; access happens only through the MCP tools. Backups exclude the `cbm-cache` volume.

## Consequences
The §3 prohibition applies to the platform's own persistence, which stays MSSQL-only; reviewers can trace this decision. Cache loss costs only re-index time.

## Alternatives considered
Replacing codebase-memory-mcp (it is mandated by the requirements); mounting the cache on tmpfs (re-index on every restart, larger memory footprint).

## Rollback path
None needed; the cache can be wiped at any time.
