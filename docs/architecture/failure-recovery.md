# Failure and recovery scenarios

Binding mechanisms: [contract.md](contract.md) §5 (state machine), §6 (queues), §8 (SSE), §10 (runner), §13 (pipeline), §14 (worker). "Artefacts" = best-effort commit + changed files + patch (§13.7).

| # | Scenario | Detection | Automatic action | Final state | Operator action |
|---|---|---|---|---|---|
| 1 | API crashes before the create transaction commits | client sees connection error | nothing persisted; idempotency row not committed | no task | none; client retries with the same Idempotency-Key |
| 2 | API crashes after commit, before enqueue | task `queued`, BullMQ job missing | `queued-reconciler` (60 s) re-adds `run-attempt` with jobId = attemptId | task runs normally | none |
| 3 | Redis unavailable at enqueue | `queue.add` throws | API logs warn, still answers 202 (rate limits fail open except `login`, §9.6); reconciler enqueues after Redis returns | task runs late | restore Redis |
| 4 | Duplicate POST /tasks with same key | IdempotencyKeys unique row | completed => replay; in progress => 409; different body => 422 | single task | none |
| 5 | Redis unavailable during a run | publish/XADD errors, BullMQ lock renewal errors | events dropped (TaskLogs still written); Claude keeps running; stalled re-delivery later no-ops (CAS claim); SSE connections switch to DB replay + tail mode without closing (§8.3) | task finishes normally | restore Redis |
| 6 | MSSQL unavailable during a run | repository errors | log sink buffers up to 8 MiB; transitions retried for at most 30 s; after 40 s without a successful DB heartbeat the worker self-fences (all processes force-stopped, leases released, no further writes); attempt left `active` | stale recovery (#9) after DB returns | restore MSSQL |
| 7 | Deadlock / lock timeout (1205/1222) | SQL error number | transaction retried 3x with exponential backoff + jitter | operation succeeds; after retries the API answers 503 `dependency_unavailable` + `Retry-After: 5` (§9.6), the worker retries transiently | investigate if frequent |
| 8 | Worker graceful shutdown (SIGTERM) | signal | pause workers, kill Claude/tests gracefully, attempt `interrupted(worker_shutdown)`, new `infra_recovery` attempt enqueued (bounded by MAX_AUTO_RECOVERIES) | task continues on another/restarted worker via `--resume` | none |
| 9 | Worker crash / OOM / host reboot | `LastHeartbeatAt` older than 60 s (`stale-attempt-recovery`, 30 s) or restarted worker finds own active attempts | orphan sweep; attempt `interrupted(worker_lost)`; recovery attempt (resume) or cancelled (cancel requested) / timed_out (deadline passed) / failed(recovery_limit_reached) | as stated | check worker logs/resources if repeated |
| 10 | BullMQ stalled job re-delivered while owner alive | claim CAS returns null | no-op, job completes | unchanged | none |
| 11 | Two workers think they own an attempt (DB outage race) | `ConflictError` on transition, attempt missing from heartbeat result, failed lease/lock renew | prevented first: owner self-fences at 40 s, recovery needs `LastHeartbeatAt` > 60 s **and** an expired owner `hb` key, the workspace lock and runner lease overlap check reject a second writer; a superseded worker stops its processes and writes nothing | owned by the recovery attempt | none |
| 12 | Transient infra error before claim, retries exhausted | BullMQ `attemptsMade >= attempts` | DLQ entry `orc-tasks-dlq`, `failUnclaimedAttempt` => failed(queue_exhausted), audit | failed | inspect `/system/dlq`, fix infra, user retries |
| 13 | Invalid job payload | Zod failure in processor | `UnrecoverableError('invalid:..')` => DLQ, failed(invalid_job) if attempt resolvable | failed | investigate producer bug |
| 14 | Claude CLI missing / probe fails | startup probe | worker refuses to start (readiness never true) | tasks stay queued | install/pin CLI 2.1.316 |
| 15 | Claude spawn ENOENT at run time | spawn error | failed(claude_cli_unavailable) | failed | fix image, retry |
| 16 | No init event within 60 s | init timer | kill sequence, failed(claude_start_failed) | failed | check egress/API key, retry |
| 17 | Init shows foreign MCP server / tool / wrong permission mode / cwd / hook event | `validateInit` | immediate forced kill, failed(security_violation), TaskEvent + audit `security.violation` | failed | security review of worker image/config |
| 18 | Claude exits non-zero / result error / no result | exit + result parsing | failed(claude_exit_nonzero / claude_result_error / claude_protocol_error); artefacts | failed | user retries (fresh or continue) |
| 19 | Budget exceeded | result subtype contains `budget` | failed(budget_exceeded); artefacts | failed | raise budget, retry continue |
| 20 | Output limit exceeded | byte counter > CLAUDE_MAX_OUTPUT_BYTES | kill, failed(output_limit_exceeded); artefacts | failed | adjust task/limit |
| 21 | Claude hangs | attempt deadline | kill sequence, timed_out(timeout); artefacts | timed_out | retry with larger timeout |
| 22 | Claude ignores SIGTERM | group still alive after grace | SIGKILL (-pgid) / `taskkill /T /F`; verification | per trigger | none |
| 23 | Grandchild escapes process group (setsid) | `/proc/*/environ` ORC_ATTEMPT_ID marker scan | SIGKILL; TaskEvent `orphan_killed` | per trigger | none |
| 24 | Orphans after worker/dev-host crash | startup + periodic `sweepOrphans` (registry files, markers) | verified kill, registry cleanup, audit `security.orphan_killed` | n/a | none |
| 25 | Resume session not found | process exits before init with `--resume` | one fallback run with a new session in the same workspace (`resume_fallback`) | continues | none |
| 26 | Workspace missing on recovery/continue | `isWorktreeUsable` false | new worktree from BaseSha (resume) or from previous HeadSha (continue); continue with branch deleted => API 409 | continues / 409 | user retries fresh |
| 27 | Source repository missing/invalid | git validate/fetch failure | project `invalid` (sync) or task blocked(project_unavailable) | blocked | fix repo under ./projects, `POST /projects/:id/sync`, retry |
| 28 | Base ref not found | `rev-parse` exit 1 | blocked(base_ref_not_found) | blocked | retry fresh with `baseRef` override |
| 29 | Free disk below WORKSPACES_MIN_FREE_BYTES | `fs.statfs` | blocked(insufficient_disk_space) | blocked | free space / run cleanup, retry |
| 30 | Workspace exceeds WORKSPACE_MAX_BYTES | periodic `measureSize` | kill, failed(disk_quota_exceeded); artefacts | failed | adjust quota or task |
| 31 | codebase-memory-mcp unavailable / tool missing / timeout | spawn/connect/tools/list/call errors | RequireIndex ? blocked(index_required_failed) : warning, Claude runs without index; reviewing re-index failures are warnings | blocked or continues | fix binary/cache; `POST /projects/:id/index` |
| 32 | Project index op stuck in running | `failStaleRunning` (2 x MCP_INDEX_TIMEOUT_MS) | op failed(mcp_timeout), unblocks new index requests | n/a | none |
| 33 | Test command fails / times out / cannot spawn | exit code, timer, spawn error | continue to reviewing (diff stored), then failed(test_failed / test_timeout / test_command_error) | failed | fix tests, retry continue |
| 34 | JUnit report missing or malformed | parse error | TestRuns.ReportParsed=0 + ReportError; status from exit code | per exit code | fix reporter path |
| 35 | Git commit/diff/patch failure in reviewing | non-zero git exit | failed(review_failed) | failed | inspect GitOperations, retry |
| 36 | Merge conflicts with latest base | `merge-tree` exit 1 | MergeCheck `conflicts` + file list; task still completes | completed | resolve when applying the patch |
| 37 | Cancel while queued | API | job removed, task cancelled immediately | cancelled | none |
| 38 | Cancel control message lost | none | heartbeat DB poll (<= 10 s) aborts the attempt | cancelled | none |
| 39 | Cancel requested while worker dead | stale recovery sees CancelRequestedAt | cancelled instead of requeue | cancelled | none |
| 40 | SSE client disconnects / API instance restarts | EventSource reconnect (retry 3000) | resume from Last-Event-ID (`r-`/`d-` ids); trimmed stream => `gap` flag | continuous view | none |
| 41 | Redis stream expired (> 24 h after settle) | stream key missing | replay from TaskLogs, then `end` | complete history | none |
| 42 | Lost `end`/status publication | SSE heartbeat DB status check | synthesized status + end, stream closed | correct final view | none |
| 43 | Session revoked or user disabled during SSE | 60 s recheck | `error` event + close | stream closed | none |
| 44 | Too many SSE connections | Redis ZSET / process counter | 429 / 503 with Retry-After | rejected | close tabs / raise caps |
| 45 | Login brute force | per-IP and per-username limiters | 429 login_throttled, user LockedUntil, audit `auth.lockout` | locked 15 min | `POST /users/:id/unlock` if legitimate |
| 46 | Migration checksum mismatch | migrator | exit code 2, nothing applied; api/worker readiness fails on schema version | services not ready | restore original migration file or add a new migration |
| 47 | Egress proxy down | Claude network errors | Claude fails (exit/result error) -> failed | failed | restore proxy, retry |
| 48 | Clock skew between containers | n/a | all heartbeat/expiry comparisons use `SYSUTCDATETIME()` in SQL | unaffected | none |
| 49 | Runner unreachable at worker startup | `hello` fails or protocol/TTL mismatch | worker refuses to start (readiness never true) | tasks stay queued | start/fix the runner service |
| 50 | Runner crash, restart or OOM | socket disconnect without `exit`; runner releases stale leases at startup | attempts interrupted `worker_lost` => recovery attempt (bounded by MAX_AUTO_RECOVERIES); the worker itself is unaffected | continues / failed(recovery_limit_reached) | check runner memory (`ATTEMPT_MEMORY_BUDGET`) |
| 51 | Attempt process tree exhausts memory or pids | kernel OOM kill / `prlimit` EAGAIN inside the runner | only that lease's processes fail; worker, API and other attempts unaffected | failed (per §13.4/§13.5) | fix the task or test command |
| 52 | Repository code tries to escape the sandbox | (silent) | blocked by uid ownership, missing secrets, `sandbox` network, egress token | per task outcome | review the repository |
| 53 | Redis memory full (`noeviction`) | write errors, readiness detail `memory_high` | publications dropped (DB is truth), enqueue failures repaired by the reconciler, SSE falls back to DB | tasks continue | raise `maxmemory` or shorten stream TTL |
| 54 | Patch body purged by retention | `PurgedAt`/`PatchPurgedAt` set | API returns `patchPurged: true`, `/patch` 404 `patch_unavailable` | n/a | none |
| 55 | Cancel races with the worker claim | `cancelPending` ConflictError | reload: active => cancel requested (202); settled => 409 | cancelled or unchanged | none |
