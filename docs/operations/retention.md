# Retention and purge policies

Tasks are never deleted. The following rows are **kept for the task's lifetime**: Tasks, TaskAttempts,
TaskEvents, TestRuns, TestResults, ClaudeSessions, ChangedFiles metadata and Workspaces (contract §6.5,
F12). Everything else is bounded by one of the policies below.

## Database (worker job `retention`, every hour)

Deletes run in batches of `RETENTION_BATCH_SIZE` rows (default 5000), with a 100 ms pause between
batches and at most 60 s per run. Each run writes the audit event `maintenance.retention_run` with the
counts.

| Data | Policy | Variable (worker) | Default |
|---|---|---|---|
| `TaskLogs` (Claude stream, stdout/stderr, system lines) | rows older than N days are deleted | `LOG_RETENTION_DAYS` | 30 |
| `GitOperations` | rows older than N days are deleted | `GITOPS_RETENTION_DAYS` | 30 |
| `McpIndexOperations` | rows older than N days are deleted; the latest succeeded `project_index` of each project is kept | `MCPOPS_RETENTION_DAYS` | 90 |
| Patch bodies (`ChangedFiles.Patch`, `AttemptPatches.ContentGzip`) | set to NULL for tasks settled more than N days ago; the API then reports `patchPurged: true`, and `/patch` answers `404 patch_unavailable` | `PATCH_RETENTION_DAYS` | 90 |
| Offline `WorkerNodes` | deleted after 7 days | (fixed) | 7 d |
| DLQ jobs (`orc-tasks-dlq`) | deleted after 30 days | (fixed) | 30 d |

## Workspaces and branches (worker job `workspace-cleanup`, every 15 min)

| Data | Policy | Variable (worker) | Default |
|---|---|---|---|
| Attempt worktree, its `.meta` dir, Claude home, per-workspace MCP index | When the task settles, the workspace is `retained` until `now + N hours`. After that it is removed, unless a queued or active attempt still uses it. | `WORKSPACE_RETENTION_HOURS` | 72 |
| Task branches in the bare mirror | deleted N days after the task settled and its workspace was removed | `BRANCH_RETENTION_DAYS` | 14 |
| Archived projects | base snapshot and project index removed; the mirror is kept | - | - |
| Mirrors | `git gc` once a day (`mirror-gc`) | - | - |

## Sessions, idempotency and Redis

| Data | Policy | Variable | Default |
|---|---|---|---|
| Web sessions | idle timeout / absolute lifetime | `SESSION_IDLE_TTL_SECONDS` / `SESSION_ABSOLUTE_TTL_SECONDS` (api) | 7200 / 43200 |
| Expired sessions | deleted 1 day after expiry, by the api `auth-cleanup` timer (every 15 min) | - | - |
| Idempotency keys (`POST /tasks`, `POST /projects`) | deleted after expiry | `IDEMPOTENCY_TTL_SECONDS` (api) | 86400 |
| Task live streams `<prefix>:task:<id>:events` | capped at about 1000 entries; expire 24 h after `end` | (fixed) | 1000 / 86400 s |
| Completed `run-attempt` jobs | removed after 24 h or beyond 5000 jobs | (fixed) | |
| Failed `run-attempt` jobs | removed after 7 days or beyond 5000 jobs | (fixed) | |
| Project sync/index jobs | removed on completion or failure | (fixed) | |
| Maintenance jobs | last 100 completed and 100 failed kept | (fixed) | |

## Audit logs (operator only)

`AuditLogs` are never deleted automatically, and the api and worker database roles are denied
`UPDATE`/`DELETE` on them. To purge them under your own policy, run the CLI as the migrator login:

```bash
docker compose run --rm db-cli purge-audit --before 2025-11-01T00:00:00Z --dry-run   # count only
docker compose run --rm db-cli purge-audit --before 2025-11-01T00:00:00Z
```

The purge itself is recorded as `maintenance.audit_purged`. Take a backup before you purge if your
compliance rules require an archive.

## Container logs and backups

| Data | Policy |
|---|---|
| Docker logs of every service | `json-file` driver: 10 MB × 5 files per container (`docker-compose.yml`, `x-logging`). |
| Backups in the `mssql-backups` volume | Not pruned automatically. Copy them off the host, then prune ([runbook.md](runbook.md#disk-and-workspace-pressure)). |
| Release evidence `docs/operations/evidence/<cli-version>/` | Kept in the repository for every Claude CLI version. |

## Changing a retention setting

Add the variables to the worker (or api) environment in a local `docker-compose.override.yml`:

```yaml
services:
  worker:
    environment:
      LOG_RETENTION_DAYS: '14'
      WORKSPACE_RETENTION_HOURS: '24'
```

Then run `npm run compose:up`. The new values apply from the next scheduled run. Lowering
`PATCH_RETENTION_DAYS` makes diffs of older tasks unavailable in the UI. The file lists and statistics
stay available.
