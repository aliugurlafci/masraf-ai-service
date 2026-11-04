# ADR-0019: API never touches repositories or workspaces; diffs and patches live in MSSQL

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
The API container should not mount project repositories or workspaces (isolation, independent deployability), yet users must see diffs, patches, merge checks and index status, and project registration must validate a git repository.

## Decision
Project registration stores the relative repo path and enqueues `sync-project`; the worker validates the repository, builds the mirror and base snapshot and sets the project `ready` or `invalid`. Reviewing persists per-file patches (ChangedFiles), the full `format-patch` export (gzip, AttemptPatches) and the merge-check result (TaskAttempts.MergeCheckJson). All indexing runs in the worker (`orc-projects` queue).

## Consequences
The API has no filesystem or git dependency; tasks can only target `ready` projects; patch size is bounded by `PATCH_EXPORT_MAX_BYTES`.

## Alternatives considered
Mount projects/workspaces read-only into the API (wider blast radius); the API calls a worker HTTP endpoint (extra service surface).

## Rollback path
Add a worker RPC endpoint for on-demand git reads; DB-stored artefacts remain valid.
