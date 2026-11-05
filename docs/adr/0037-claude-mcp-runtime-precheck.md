# ADR-0037: Claude's MCP runtime directory is verified before every Claude spawn; `MCP_REQUIRED` and `requireIndex` fail closed per task

- Status: Accepted (2026-11-05; shipped in contract 3.0.0 together with ADR-0036, approved by the user as one MAJOR release). GPM and the Opus review signed the design (K9, `.claude/state/denetim-defteri.md`): 9.1 `requireIndex` also triggers the fail-closed path; 9.2 same 3.0.0 release, separate changelog subsection.
- Extends the B-014 rule of contract 2.2.1 (§10.11 item 5): the local-mode runtime directory is checked only on MCP operations, so a Claude run could start with an unchecked directory.
- Deciders: Solution Architecture Manager (proposal); Code Intelligence Manager and Worker Platform Manager (design note `.claude/state/tasarim/B-015.md`); Opus review (K9); GPM.
- Contract sections: `docs/architecture/contract.md` §2.7, §10.11 item 5, §12.4, §13.2, §16.3.
- Finding addressed: B-015 (D3-F3-A, K7).

## Context
`prepareLocalRuntimeDir` (B-014) verifies `<os.tmpdir()>/orc-cbm-rt-<uid>/<16 hex>` with `lstat` (directory, not a symlink, owned by the process uid, `mode & 0o077 = 0`) before every codebase-memory-mcp spawn that the worker itself makes. Claude's own MCP server is started by the Claude CLI from `mcp.json`, and nothing verifies the directory first:
- When the workspace index is reused (`reused_workspace_index`), no index call runs.
- When `task_index` fails and the project has `requireIndex = false`, the attempt continues.
- Both paths still start Claude with `--mcp-config`, and `claudeMcpConfig` (sync) never touches the directory.

A pre-created directory with other permissions (cross-user `/tmp` squat, TOCTOU) would then be used by the MCP server that Claude controls. `os.tmpdir()` itself is also unchecked (a world-writable directory without sticky bit, or a symlink).

## Decision
1. **`McpManager.ensureClaudeMcpRuntime(scope: WorkspaceScope): Promise<void>`** (contract §2.7, additive).
   - Local mode: runs `prepareLocalRuntimeDir(cacheDir(scope))`, the same check as for MCP operations.
   - Runner mode: no-op. The runtime directory is a leased cache path that the runner already checks with `validateSpawnEnvPaths`.
   - Failure: `PathEscapeError` (`path_escape`) or the underlying fs error (`EACCES`, `ENOSPC`).
2. **`os.tmpdir()` check (POSIX only).** `prepareLocalRuntimeDir` first runs `lstat(os.tmpdir())`:
   - it must be a directory and not a symlink;
   - `uid` must be `0` or `process.getuid()`;
   - it must be sticky (`mode & 0o1000`) or not other-writable (`mode & 0o002 = 0`).
   Otherwise `PathEscapeError` with role `tmpdir` and reason `tmpdir_owner`, `tmpdir_world_writable` or `symlink`. The check is shared by operations, probe and ensure. A symlinked `TMPDIR` (for example macOS) is rejected, fail-closed. `/tmp` (root, 1777) and a private `TMPDIR` owned by the worker uid (0700) pass. win32 has no uid, so no check.
3. **Pipeline stage.** The orchestrator runs `mcpRuntimeStage()` after the indexing stage and before the running stage, and stores `mcpRuntimeOk`.
   - `cfg.mcpEnabled && mcpRuntimeOk` replaces `mcpEnabled` in three places: `computeToolPolicy`, the prompt's `index.available`, and the Claude request's `mcp`.
   - With `mcp = null` the runner does not pass `--mcp-config` and still passes `--strict-mcp-config` (§10.2 rows 14 and 15); `validateInit` then rejects any `mcp_servers` and any `mcp__codebase-memory-mcp__*` tool, which is consistent. A unit test pins this `mcp === null` argv rule (K9 9.2).
   - Writing `.meta/mcp.json` stays in `prepareWorkspaceFiles`; it is harmless because Claude is not given the file when `mcp = null`.
4. **Per-task `MCP_REQUIRED` and `requireIndex` (K9 9.1).** If `ensureClaudeMcpRuntime` fails and `MCP_REQUIRED` or the project's `requireIndex` is true, the attempt fails closed:
   - `path_escape` => failed(`security_violation`);
   - any other error => failed(`workspace_error`).
   No new `FailureReason` is needed. Otherwise the pipeline publishes a `warning` event (`mcp_runtime_rejected`, with the error code), writes a system log line, and starts Claude without `--mcp-config`.
   - `MCP_REQUIRED` keeps its startup meaning (probe failure refuses to start) and gains this per-task meaning. This is why the change has an ADR.
   - The decision is a pure function `mcpRuntimeDecision(err, {mcpRequired, requireIndex})` returning `{settle}` or `{warn}`, so it is unit-testable without a pipeline harness.
5. **Shared config.** `MCP_REQUIRED` already exists in `WorkerConfigSchema` (default false, requires `MCP_ENABLED`) and is not changed. The worker maps it to the new `PipelineConfig.mcpRequired` (Wave 3). No new env name.

## Consequences
- A Claude run can no longer start with an unchecked MCP runtime directory in local mode. Projects with `requireIndex` now fail instead of silently running without the index when the directory is unsafe.
- Hosts with a shared, non-sticky `TMPDIR` fail MCP operations and, where required, tasks. The operator fix is a private `TMPDIR` (runbook).
- The check runs once per attempt, so a directory swapped after the check but before Claude's MCP spawn remains a theoretical TOCTOU window. It is bounded by the per-uid parent (0700, owned by the worker uid); in production the runner leases the path instead.
- No DB or schema change.

## Alternatives considered
- **Make the sync `claudeMcpConfig` check the directory.** Rejected. It would add blocking fs calls to a pure config builder and still could not fail the attempt with the right outcome.
- **Fail every task when the directory is unsafe, regardless of `MCP_REQUIRED`.** Rejected. A host without a usable MCP runtime should still run MCP-less tasks when the operator did not require MCP.
- **A new `FailureReason` such as `mcp_runtime_rejected`.** Rejected. `security_violation` and `workspace_error` already express both causes and keep `FAILURE_REASONS` unchanged.
- **Ignore `os.tmpdir()`.** Rejected. A world-writable, non-sticky parent defeats the per-uid directory check.

## Rollback path
Remove the `mcpRuntimeStage()` call from `stages()` and fix `mcpRuntimeOk` to true. Behaviour returns to B-014 (checks only at operation time). `ensureClaudeMcpRuntime` and the tmpdir check can stay. If the tmpdir check breaks a legitimate shared `TMPDIR`, it can be reverted on its own by a contract patch. This is a contract change (minor-level), so reverting it after 3.0.0 is a patch to the 3.0.x line.
