# ADR-0031: Phase C implementation deviations

- Status: Accepted (2026-11-03, contract v2.1.0)
- Deciders: Solution Architecture Manager; ratified by GPM
- Contract: `docs/architecture/contract.md` Changelog 2.1.0 (§2.9, §2.10, §2.11, §8.3, §9.1, §13.1, §14.7; supersedes the `orc-api-maintenance` rows of §6.2/§6.5)
- Requirements: §8 (live output), §11 (recovery), §15 (security gates)

## Context
Phase C implemented task-manager, project-manager, orchestrator, the worker and the API against contract 2.0.1. Besides additive optional interface fields (ratified as a minor bump in Changelog 2.1.0), five behaviours differ from the literal contract text:

1. A worker that has claimed an attempt can find the workspace lock or the runner attempt lease still held (a previous owner is shutting down, or its lease has not expired yet). The contract left this to the generic job failure path, i.e. BullMQ backoff. But the attempt is already claimed (no longer `queued`), so a BullMQ retry of the same job finds a non-`queued` attempt and is a no-op: the task would hang until stale recovery.
2. §13.1 required self-fencing to force-stop processes with no grace. The pipeline stops processes by aborting the attempt controller, which runs the normal kill sequence (§10.7).
3. §6.2/§6.5/§14.7 placed `auth-cleanup` on an `orc-api-maintenance` BullMQ queue consumed by the API. apps/api has no bullmq dependency (dependency changes are frozen, contract §1.2) and reaches Redis queues only through `@orc/task-manager` (ADR-0019 boundary); a BullMQ Worker in the API would cross that boundary.
4. §8.3 step 2 (204 rule) cannot be decided cheaply for a `d-<id>` resume point on a settled task whose Redis stream has expired: it would need a TaskLogs probe before the response starts.
5. `ProjectIndexStatus.stale` (§12.5: "lastSuccessful.indexed head != Projects.HeadSha") is undefined when no successful `project_index` exists.

## Decision
- **(a) Workspace busy after claim.** The pipeline polls the workspace lock and then the runner attempt lease, writing one `system` line `<what> is busy; waiting`, for up to `ATTEMPT_STALE_MS` (60 s). Still busy => the attempt is handed to infra recovery: `recoverInterruptedAttempt({ reason: 'worker_lost' })` (new `infra_recovery` attempt, `AutoRecoveryCount + 1`, bounded by `MAX_AUTO_RECOVERIES`; workspace retained `ready`). Cancellation and deadline checkpoints run during the wait.
- **(b) Self-fencing with the normal kill grace.** When the last successful DB heartbeat is older than `selfFenceAfterMs` (= `ATTEMPT_STALE_MS - 2 x HEARTBEAT_INTERVAL_MS`, 40 s), the heartbeat marks every active attempt fenced; the pipeline aborts it, the Claude/test process trees are stopped with the normal kill sequence (`CLAUDE_KILL_GRACE_MS` 10 s), then the runner lease and workspace lock are released and no further DB writes are made (`noop`). Stopping finishes at ~50 s, before the 60 s stale threshold at which another worker may recover the attempt. The runner lease TTL (`RUNNER_LEASE_TTL_MS`) remains the backstop when the worker process itself is gone.
- **(c) API auth-cleanup is an in-process timer.** Every API replica runs `createAuthCleanup` every `AUTH_CLEANUP_INTERVAL_MS` (900000): `authSessions.deleteExpired(now - 1 d)` and `idempotency.deleteExpired(now)` in batches of 5000 (at most 100 batches per pass). Every statement is idempotent, so concurrent replicas only repeat no-op deletes. Shutdown stops the timer and awaits a running pass. No `orc-api-maintenance` scheduler or worker exists; `QUEUE_NAMES.apiMaintenance` and `QueueRegistry.apiMaintenance` stay as reserved, unused names (removing them would be a major change of `@orc/shared`).
- **(d) SSE `d-<id>` resume on a settled task with an expired stream.** The response is 200: `status` snapshot, TaskLogs rows after `<id>` (usually none), then `end` with id `d-end`, then close. The 204 rule still applies to `d-end`, and to an `r-` resume point at the end of an existing stream. The client stops on `end` exactly as on 204 (§8.4), so the user-visible behaviour is the same.
- **(e) `ProjectIndexStatus.stale`.** `stale = lastSuccessful.ResultJson.headSha != Projects.HeadSha` when a successful `project_index` exists; otherwise `stale = Projects.HeadSha !== null` (a synced head without a successful index is stale; a project never synced is not).

## Consequences
- Contract 2.1.0 (minor: additive optional fields, documentation of implemented behaviour): §2.9-§2.11 interface facts, §8.3 step 2, §9.1, §13.1, §14.7; the §6.2 `orc-api-maintenance` row and the queue of the §6.5 `auth-cleanup` row are superseded by §14.7.
- (a) A long-held workspace now costs one auto-recovery instead of a hung task; a workspace held across `MAX_AUTO_RECOVERIES` attempts fails the task with `recovery_limit_reached`.
- (b) A fenced worker may still be stopping Claude for up to `CLAUDE_KILL_GRACE_MS` after the fence; this is bounded and ends before stale recovery can start. Config validation keeps `DB_WRITE_RETRY_WINDOW_MS < ATTEMPT_STALE_MS - 2 x HEARTBEAT_INTERVAL_MS`.
- (c) Cleanup load scales with the number of API replicas (each pass is a few batched DELETEs); no Redis dependency for cleanup.
- (d) One extra short-lived connection per such resume; no data is duplicated (client dedup keys, §8.4).
- No schema migration and no data change.

## Alternatives considered
- (a) Fail the job and let BullMQ back off: the retry no-ops on a claimed attempt. Settle the task `failed`: punishes the user for an infrastructure race.
- (b) SIGKILL immediately on fence: skips Claude's graceful exit for no safety gain, since the graceful stop completes before the stale threshold anyway.
- (c) Add bullmq to apps/api, or run `auth-cleanup` on the worker: the first violates the frozen dependency set and ADR-0019; the second needs grants on `AuthSessions`/`IdempotencyKeys` that `orc_worker_role` does not hold (least privilege, §4.3 GRANT matrix).
- (d) Probe TaskLogs before answering to return 204: an extra query on every such reconnect for an identical client outcome.
- (e) `stale = false` without an index: hides that a synced project has never been indexed.

## Rollback path
Revert the contract to 2.0.1 and this ADR. (a) Throw the busy error as a retryable job failure (and accept hung tasks until stale recovery). (b) Pass a zero grace to the fence stop. (c) Requires a bullmq dependency in apps/api (GPM approval) and the `orc-api-maintenance` scheduler/worker. (d) Add a TaskLogs emptiness probe to the 204 rule. (e) Change the `indexStatus` expression in `@orc/project-manager`.
