# ADR-0035: Impact analysis seeded with the worker's diff (no git inside the sandbox)

- Status: Accepted (2026-11-04, contract v2.2.0; ratified by GPM); amends the impact row of contract §12.2, §12.5 (`ResultJson`), the §2.7 `detectChanges` signature (additive) and the §18.4 fake; adds a config check to §16.3
- Deciders: Code Intelligence Manager (proposal); Solution Architecture Manager; GPM (ratified by GPM)
- Contract: `docs/architecture/contract.md` §2.7, §10.11 item 4, §11.1, §11.3, §12.2, §12.5, §16.3, §18.4

## Context
`npm run test:compose` passed, but every runner-mode `impact_analysis` failed with `mcp_tool_error "git revision resolution failed: base_branch "<sha>" or HEAD is not a commit"`. The smoke tolerated the failure. Reproduced in the worker image (codebase-memory-mcp v0.12.0 `linux-amd64-portable`, git 2.39.5) with the production layout: a mirror at `<WS>/.repos/p.git` owned by 1000 with mode 0700, an attempt worktree created from it, and the worktree and scope cache handed to uid 20001 (lease handoff, §10.11 item 3):

1. As uid 20001, `index_repository` succeeds, and `detect_changes {base_branch: <sha>, scope: impact}` returns the error above. `git rev-parse HEAD` in the worktree fails with `fatal: not a git repository: /v/ws/.repos/p.git/worktrees/a1`, because the worktree's `.git` file names the admin dir inside the mirror.
2. Control run with `.repos` at 0755: the same error, now `fatal: detected dubious ownership in repository at '/v/ws/p/t/a1'`. Git refuses the gitdir because it belongs to another uid.
3. The binary runs `git -C '<root>' rev-parse 'HEAD^{commit}' '<base>^{commit}' --show-prefix`, `merge-base` and `diff --name-status`. The v0.12.0 `detect_changes` `inputSchema` (from `tools/list`) accepts only revisions (`base_branch`, `since`) and no file list or diff.

The sandbox uid has no git access to the worktree by design: the git admin dir belongs to the worker (§10.11 item 4, §11.3, ADR-0024). The runner's env allowlist has no `GIT_*`, and a sandbox uid must never reach `.repos`. Server-side `detect_changes` therefore cannot work in runner mode without weakening the sandbox.

## Decision
The worker already computes the diff `baseSha..HEAD` with hardened git (`collectChanges`: name-status, numstat and per-file patch). `McpManager.detectChanges(scope, {baseSha, lease, signal, changes})` takes this diff as the optional `changes: ImpactChangeSet` (`{headSha, files: Pick<ChangedFileInput, path|oldPath|changeType|isBinary|patch|patchTruncated>[], totalFiles, truncated}`). The pipeline always passes it. When `changes` is present, the server runs no git. In the same session as before (attempt lease, §12.1 spawn unchanged), the operation:

1. verifies `get_file_outline {project, file_path}` and `trace_path {project, function_name, direction, depth}` in `tools/list`. A missing tool or parameter fails only this operation, as `mcp_tool_missing` / `mcp_tool_schema_mismatch`;
2. calls `get_file_outline` (`format: json`, pages of 200, at most 10 pages) for each changed file that is not deleted, not binary and has a safe repository-relative path, at most 200 files;
3. selects the seeds: declarations whose line range contains a changed new-side line of the file's hunks (added lines, and for a removal the line before it, like git `-U0`). If the patch is missing or truncated (`CHANGED_FILE_PATCH_MAX_BYTES`), every declaration of the file is a seed;
4. calls `trace_path` per seed (`direction: inbound`, `depth: 2`, `format: json`, `limit: 200`), at most 100 seeds. Seeds are not reported as impacted, and the minimum hop is kept. `{"error":"function not found"}` counts as `seeds_unresolved`; any other tool error fails the operation;
5. shares one `MCP_DETECT_TIMEOUT_MS` budget across all calls (`mcp_timeout`). Responses are Zod-validated, and an undecodable response fails with `mcp_protocol_error`.

`ResultJson` (still capped by `MCP_RESULT_MAX_BYTES`) keeps detect_changes' keys and adds a few: `{source: "worker_diff", base, head, direction, depth, changed_total, changed_files (<= 500), changed_has_more, files_examined, skipped_total, skipped_files, seed_total, seeds_traced, seeds_unresolved, seeds: [{qn, label, file, start, end, seed_reason: hunk|file}], impacted_total, impacted_total_relation, impacted: [{qn, module, hop, via}] (<= 200), impacted_symbols: [qn], impacted_has_more, impacted_modules: [{module, count}], truncated}`. The UI already renders `changed_files` and `impacted_symbols`.

Without `changes`, `detectChanges` behaves as in §12.2 (`detect_changes`). This path stays available for callers whose server can read the repository's git dir, and `REQUIRED_MCP_TOOLS` is unchanged.

Both modes use the same path. Local mode (development, win32) uses it too, so the production algorithm is the one covered by the Windows suites (scripted, fake and real binary), and the impact always matches the diff stored in `TaskChangedFiles`.

### Daemon socket length (same finding, config)
The Linux binary binds `<CBM_RUNTIME_DIR>/cbm-daemon-<uid>/cbm-<16 hex>.sock`. In runner mode `CBM_RUNTIME_DIR` is the leased cache `<CBM_CACHE_DIR>/{p,w}/<GUID>`. Measured in the worker image: with a 5-digit uid, a 64-byte runtime dir works and 65 bytes fail with `secure daemon endpoint could not be created`; with a 10-digit uid the limit is 59 bytes. This is AF_UNIX `sun_path[108]`. The win32 binary creates no socket below the runtime dir (a 120-byte dir works). The allowed `CBM_CACHE_DIR` length is therefore `107 - 39 - len("/cbm-daemon-<uid>") - 26` bytes, which is 25 for the default uids 20000..20063 (production `/var/lib/orc/cbm-cache` is 22). Two checks enforce it:
- `WorkerConfigSchema` (runner mode, `MCP_ENABLED`, not win32) rejects a `CBM_CACHE_DIR` that cannot fit even the shortest sandbox uid (4 digits, `RUNNER_UID_BASE >= 1000`) with a `ConfigError` on `CBM_CACHE_DIR`;
- the worker re-checks against the runner's real range after `hello` (`uidBase + maxLeases - 1`) and refuses to start (`config_invalid`) like the existing hello checks.

## Consequences
- Runner-mode impact analysis works with an unchanged security boundary. Sandbox uids still cannot reach `.repos`, `.orc` or any other worker-owned path. The server receives only repository-relative paths that are already visible in its own worktree and qualified names from its own index, as JSON arguments (no shell).
- Impact semantics: seeds come from the worker's diff instead of the server's `git diff`. Both are `baseSha..HEAD` with `-M` rename detection, and the worktree is committed before re-indexing (§13.2). `impacted` entries carry `module` (the qualified-name prefix) and `via` instead of the server's `label`/`file`. A file's patch over `CHANGED_FILE_PATCH_MAX_BYTES` falls back to file-level seeds, and caps set `truncated`.
- Cost: one `get_file_outline` per changed file and one `trace_path` per seed. Both are bounded (200 files, 100 seeds) and fast (milliseconds on the v0.12.0 index).
- Claude's own codebase-memory-mcp server has the same git limitation in runner mode, and so does Claude's Bash `git`. This ADR does not change that (the prompt does not ask Claude for `detect_changes`).
- Tests: `tests/unit/mcp-manager/impact.test.ts` (hunk mapping, seeds, flow, limits, budget, error mapping); `tests/unit/mcp-manager/fake-cbm.test.ts` (fake server, worktree without git); `tests/integration/mcp-manager/mcp-real.test.ts` (real binary: with an unreadable gitdir `detect_changes` fails exactly as in production and the diff-seeded path succeeds); `scripts/compose-smoke.mjs` now requires `impact_analysis` to succeed in the stack. Socket checks: `tests/unit/shared/config-hardening.test.ts` and `tests/integration/worker/runner-lost.test.ts`.

## Alternatives considered
- Grant the lease uid read access to the mirror's `worktrees/<id>` and objects (ACL/group/safe.directory): forbidden. It exposes every task's objects and refs of the project to untrusted code and contradicts §10.11 item 4 and ADR-0024.
- A per-attempt standalone git repository in a leased path, with the worktree's `.git` redirected to it: this needs copies of the base and head objects, a write into the worktree (git-manager scope) and repair on reuse. It would also re-enable a gitdir under sandbox control.
- Pass `GIT_DIR` through the runner: not in the env allowlist (packages/sandbox), and the target would still be the mirror.
- Run `detect_changes` in the worker: the worker never runs code that parses repository content (§10.11).
- A single `query_graph` Cypher query: v0.12.0 rejects path variables (`MATCH p=...`), and building Cypher from repository-controlled names needs string escaping, whereas tool arguments need none.
- Keep `detect_changes` in local mode only: production would then run a code path that the development suites never execute.

## Rollback path
Stop passing `changes` in `packages/orchestrator/src/pipeline.ts` (`reindex`). `detectChanges` then calls `detect_changes` again: it works in local mode and fails as a non-fatal warning in runner mode. Revert the impact step of `scripts/compose-smoke.mjs` to tolerate the failure. The socket checks can be removed independently: drop the `CBM_CACHE_DIR` check from `WorkerConfigSchema` and the hello check in `apps/worker/src/runtime.ts`.

## Proposed contract text
- §2.7: `detectChanges(scope, o: { baseSha: string; lease: LaunchLease; signal?: AbortSignal; changes?: ImpactChangeSet }) ...`, with `ImpactChangeSet` as in Decision.
- §12.2 impact row: "impact | `get_file_outline` + `trace_path` seeded with the worker's diff (ADR-0035); `detect_changes {project, base_branch, scope: 'impact'}` only when no diff is given | `MCP_DETECT_TIMEOUT_MS` (120000) for all calls of the operation".
- §12.5: "`ResultJson` = diff-seeded impact document (ADR-0035)".
- §16.3 `CBM_CACHE_DIR`: "runner mode with MCP: `<CBM_CACHE_DIR>/w/<GUID>/cbm-daemon-<uid>/cbm-<16 hex>.sock` must fit 107 bytes (config check with 4-digit uids, worker re-check after `hello`)".
- §18.4: the fake also exposes `get_file_outline` and `trace_path` (v0.12.0 JSON shapes, declarations and call edges from `function`/`class` lines).
