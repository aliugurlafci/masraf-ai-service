# ADR-0030: Phase B implementation deviations

- Status: Accepted (2026-11-03, contract v2.0.1)
- Deciders: Solution Architecture Manager; ratified by GPM
- Contract: `docs/architecture/contract.md` Changelog 2.0.1 (§2.4, §3.3 `RequestIndexRequestSchema`, §4.3, §12.2, §12.5, §18.1, §18.2, §18.5)
- Requirements: §5.6 (ADR/docs indexed), §14, §15

## Context
Phase B implemented the shared packages, database, git, MCP, Claude runner and sandbox against contract 2.0.0. Four places where the contract could not be followed literally, or named files that were placed differently, were found:

1. §4.3 required `DENY ALTER, CONTROL, REFERENCES, TAKE OWNERSHIP, VIEW DEFINITION ON SCHEMA::orc` for both app roles. In SQL Server a DENY of CONTROL also denies every permission CONTROL implies, including SELECT/INSERT/UPDATE/DELETE on all objects of the schema, so it cancels the whole object-level GRANT matrix (verified on SQL Server 2022: every app query fails with error 229).
2. codebase-memory-mcp v0.12.0 excludes `docs/` from the index in the "filtered" modes `moderate` and `fast` (observed on Windows; doc-code candidates are produced only by `full`). The project base index would therefore contain no ADRs or documentation, which violates requirements §5.6, and the doc-link test of §12.2 (mode `moderate`) cannot pass.
3. Test files named in §12.2/§18 were implemented at different locations (per-package directories) than the contract named.
4. `apps/runner` needs its own logger service name; `LoggerOptions.service` did not list `runner` although `AppName` already did.

## Decision
- **(a) No `DENY CONTROL ON SCHEMA::orc`.** Migration `0002_roles_and_grants.sql` issues `DENY UPDATE, DELETE ON orc.AuditLogs` and `DENY ALTER, REFERENCES, TAKE OWNERSHIP, VIEW DEFINITION ON SCHEMA::orc` to `orc_api_role` and `orc_worker_role`; CONTROL is not denied (it is never granted either). DDL stays impossible: neither role holds a DDL permission and ALTER on the schema is denied. `tests/integration/database/least-privilege.test.ts` proves DDL is denied, AuditLogs UPDATE/DELETE are denied, object definitions are hidden and no elevated role membership exists.
- **(b) Index mode rule.** `project_index` (registration sync and every manual `POST /projects/:id/index` reindex) ALWAYS runs `index_repository` with mode `full` and `doc_candidates: true`, regardless of `Projects.IndexMode` and of `RequestIndexRequest.mode` (accepted for compatibility, ignored; the operation row records `full`). `task_index` uses `Projects.IndexMode` (+ `doc_candidates: true`); `task_reindex` stays `fast` without `doc_candidates`. The real-binary doc-link assertion runs on a `full` index.
- **(c) Test file locations actually used** (the contract now names these):
  - git cleanup coverage: `tests/integration/git-manager/workflow.test.ts` (removeWorktree + deleteBranch rollback, idempotent) and `tests/integration/git-manager/isolation.test.ts` (removal never follows linked directories);
  - real-binary MCP tests: `tests/integration/mcp-manager/mcp-real.test.ts` (skipped when the binary is absent);
  - DB reset helper: `tests/helpers/database/db.ts` (`resetDb()`);
  - DB least-privilege gate: `tests/integration/database/least-privilege.test.ts`.
- **(d) Runner logger service.** `LoggerOptions.service` gains `'runner'`; `apps/runner` logs with `service: 'runner'` (log records of the sandbox are distinguishable from the worker's).

## Consequences
- Contract 2.0.1 (patch: documentation of implemented behaviour plus one additive union member): §4.3 DENY list, §12.2/§12.5 mode rule, §3.3 `RequestIndexRequestSchema` note, §18 file paths, §2.4 service union.
- The worker's project sync/index jobs (Backend/Orchestrator team) MUST pass `mode: 'full'` for `project_index`; the API records `full` for queued project_index rows. A `full` project index takes longer than `moderate`; the existing `MCP_INDEX_TIMEOUT_MS` (900000) applies.
- `apps/runner/src/main.ts` switches from `service: 'worker'` (+ child `component: 'runner'`) to `service: 'runner'` (runner owner).
- No schema migration and no data change.

## Alternatives considered
- Keep `DENY CONTROL` and re-grant per object: impossible, DENY wins over GRANT.
- Index projects in `moderate` and add `docs/` through a second call: v0.12.0 has no include-path parameter; two indexes would break §12.3 naming.
- Make `Projects.IndexMode` default `full`: would also slow every `task_index`; the mode stays a per-project tuning knob for task worktrees.
- Move the tests to the contract's paths: churn without benefit; per-package directories match the ownership table.

## Rollback path
Revert the contract to 2.0.0 and this ADR. (a) cannot be rolled back without breaking all app queries. (b) is a caller-side mode choice: passing `Projects.IndexMode` again restores the old behaviour (and loses docs/ in the project index). (d) Removing `'runner'` requires the runner to log as `worker` again.
