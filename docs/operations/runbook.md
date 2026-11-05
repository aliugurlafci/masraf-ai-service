# Operations runbook

Day-2 operations of the Compose deployment (contract §14, §17, §19). In the commands below,
`docker compose` means `docker compose` run from the repository root. That root holds
`docker-compose.yml` and, if you use one, your local `docker-compose.override.yml`.

## Start and stop

| Action | Command | Notes |
|---|---|---|
| Start or update | `npm run compose:up` | Runs compose-check, then `up -d --build --wait`. The one-shots db-bootstrap and migrator run again on every `up`; both are idempotent. |
| Stop (keep data) | `npm run compose:down` | Grace periods: worker 45 s, runner 30 s, api 20 s. |
| Restart one service | `docker compose restart api` | |
| Stop the worker for maintenance | `docker compose stop worker` | The worker drains (see below). |
| Status | `docker compose ps` | Long-running services must be `healthy`. db-bootstrap and migrator must show `exited (0)`. |
| Remove everything including data | `docker compose down -v` | **Destroys** the database, backups volume, Redis, worktrees and indexes. Take a backup first. |

What happens when the worker gets SIGTERM: readiness turns false and the worker node is marked
`draining`. The BullMQ workers stop taking jobs. Running attempts are stopped with the kill sequence and
marked `interrupted`. A new attempt is enqueued (`worker_shutdown`, bounded by `MAX_AUTO_RECOVERIES` = 2).
The node is then reported `offline`. The hard deadline is `SHUTDOWN_TIMEOUT_MS` = 30 s, within the 45 s
compose grace. A second signal force-kills every process tree.

## Health and readiness

| Endpoint | Where | Meaning |
|---|---|---|
| `GET https://<host>:8443/health/live` | web (nginx) | nginx is up. Used by the web container healthcheck. |
| `GET https://<host>:8443/health/ready` | web → api | The API is ready: DB ping, Redis ping, and schema version ≥ expected. |
| `GET /api/v1/health/live`, `/api/v1/health/ready` | api :4000 (internal) | Same checks. `checks` lists each dependency with its latency and detail. |
| `GET http://127.0.0.1:4100/health/ready` | worker (inside the container) | Startup done, not draining, DB/Redis ok, CLI probe ok, MCP check reported. |
| `node dist/runner.js healthcheck` | runner | `hello` over the runner socket. |
| `GET http://127.0.0.1:3128/healthz` | egress-proxy | |

Commands that check health from the host:

```bash
curl --cacert secrets/web_ca_cert.pem https://localhost:8443/health/ready
docker compose exec -T worker node /opt/orc/healthcheck.mjs http://127.0.0.1:4100/health/ready && echo worker ready
docker compose exec -T runner node dist/runner.js healthcheck && echo runner ok
docker inspect -f '{{.Name}} {{.State.Health.Status}}' $(docker compose ps -q)
```

A Redis check that reports `ok` with detail `memory_high` means Redis is above 90 % of `maxmemory`
(400 MB). See [Queue and DLQ](#queue-and-dlq).

## Logs (local only)

Logging is local only. There is no external log, metrics or monitoring service (contract §17).

- Container logs are Pino JSON lines that go to the Docker `json-file` driver, with rotation at
  10 MB × 5 files per container:
  `docker compose logs -f --tail 200 api worker runner egress-proxy web`.
- Every response carries `X-Request-Id` and `X-Correlation-Id`, and Problem details include `requestId`.
  To trace one request or task: `docker compose logs --no-color api worker | grep <correlationId>`.
- Task output and history live in MSSQL. Tables `TaskLogs`, `TaskEvents`, `GitOperations`,
  `McpIndexOperations` and `AuditLogs` are visible in the UI: task detail, **System** and **Audit**.
  `GET /tasks/:id/logs?stream=claude&format=text` returns the raw Claude stream.
- Secrets are masked before anything is logged or stored. If you find an unmasked secret, rotate it
  ([secrets.md](secrets.md)) and report the leak as a security incident.
- Pretty printing (`LOG_PRETTY`) is honored only in development.

## Queue and DLQ

- `GET /api/v1/system/queue` (UI: **Dashboard** and **System**) shows the counts per queue, the DLQ count
  and the Redis memory.
- The DLQ (`orc-tasks-dlq`, UI **System → DLQ**, needs `system:manage`) is a read-only record of
  `run-attempt` jobs that exhausted their retries (`QUEUE_JOB_ATTEMPTS` = 3, exponential backoff from
  5 s) or carried invalid data. When the job lands in the DLQ, the task is already `failed` with reason
  `queue_exhausted` or `invalid_job`.
- To handle a DLQ entry:
  1. Read the failure reason in the entry and the worker logs around its time.
  2. Fix the cause. Typical causes are a dependency outage, an invalid project state, or a full disk.
  3. Retry the task from the task page (**Retry**, mode `fresh`) or with `POST /api/v1/tasks/:id/retry`.
  DLQ entries are never consumed again. Retention trims them after 30 days.
- Redis is the queue only; MSSQL is the source of truth. If Redis lost data or was flushed, the
  `queued-reconciler` (every 60 s) re-enqueues `queued` attempts whose job is missing, and SSE falls back
  to replaying from the DB. Redis runs with `noeviction`: when it is full, writes fail rather than drop
  jobs. Find the large keys with
  `docker compose exec redis sh -c 'REDISCLI_AUTH="$(cat /run/secrets/redis_password)" redis-cli --no-auth-warning --bigkeys'`.
  Settled task streams expire after 24 h.

## Stuck and orphan tasks

| Symptom | Automatic handling | Operator action |
|---|---|---|
| Task stays `queued` | `queued-reconciler` (60 s) re-enqueues attempts with no job. Projects stuck in `validating` for over 10 min get their sync job again. | Check that a worker is `ready` (**System**) and the queue counts. Look for `blocked` tasks caused by disk space. |
| Task stays active and its worker is dead | `stale-attempt-recovery` (30 s) acts once the heartbeat is older than `ATTEMPT_STALE_MS` (60 s) and the worker heartbeat key is gone. It recovers the attempt as `worker_lost` (at most `MAX_AUTO_RECOVERIES` = 2), then fails the task with `recovery_limit_reached`. | Usually none. Cancel the task if needed. |
| Task stays active and its worker is alive | The task timeout (`timeoutSeconds`, at most `CLAUDE_MAX_TIMEOUT_SECONDS`) ends it as `timed_out`. | **Cancel** in the UI or `POST /tasks/:id/cancel`. It returns 202 while the worker stops the process tree. |
| Processes left in the runner | Releasing a lease kills every process of the lease uid. Expired leases (`RUNNER_LEASE_TTL_MS` = 40 s without renewal) are released by the runner. The worker sweeps its own registry every `ORPHAN_SWEEP_INTERVAL_MS`. | List the sandbox processes: `docker top $(docker compose ps -q runner) -o uid,pid,etime,comm`. Uids 20000-20063 must belong to active attempts or index operations. If they do not, run `docker compose restart runner`. All leases are released, and active attempts become `worker_lost` and are recovered. |
| Index operation stays `running` | `stale-attempt-recovery` fails MCP operations older than 2 × `MCP_INDEX_TIMEOUT_MS`. | Start the index again from the project page once it has failed. |

## Worker scaling

- One worker container runs `WORKER_CONCURRENCY` attempts in parallel (default 2, maximum 16).
  To scale horizontally on the same host, run `docker compose up -d --scale worker=2`. The worker
  publishes no host ports, and each replica gets a unique `WORKER_ID` (its container host name).
- All replicas share the volumes and the **single runner** (multi-host deployment is out of scope).
  Keep these constraints:
  - Total concurrency (replicas × `WORKER_CONCURRENCY`) plus concurrent project operations must stay
    below `RUNNER_MAX_LEASES` (64).
  - The runner `mem_limit` must be at least total concurrency × 2 GiB + 512 MiB. The default 4608m fits
    2 attempts. Raise it in `docker-compose.override.yml` (`services.runner.mem_limit`) before you
    scale. For example, 4 attempts need 8704m.
  - Each worker opens up to `DB_POOL_MAX` = 5 connections, and each API process up to 10.
- To scale down, run `docker compose up -d --scale worker=1`. Removed replicas drain as described in
  [Start and stop](#start-and-stop).

## Rotating secrets

The procedures for each secret are in [secrets.md](secrets.md#rotation). In short: generate the new value
with `scripts/generate-secrets.mjs --only <name> --force`, apply it, then recreate the consumers.

## Claude credential (OAuth token)

- **Expired or revoked token:** tasks fail with an authentication error (401, "Not logged in"). The worker
  log shows the failure once per attempt; there is no automatic retry.
- **Renew (401 step):** run `claude setup-token` on a logged-in machine, install the token with
  `node scripts/generate-secrets.mjs --only claude_oauth_token --force --claude-oauth-token-stdin`, run
  `docker compose up -d --force-recreate worker`, then resubmit the failed tasks. Revocation and details:
  [secrets.md](secrets.md#claude-oauth-token).
- **Revoke (leak suspected, person left, or before decommissioning):**
  1. Revoke the token in your Claude account settings (claude.ai, Settings; the `setup-token` entry). Tasks fail
     with an authentication error from then on.
  2. Create the replacement with `claude setup-token` and install it as in the renewal step above.
  3. Delete every temporary copy of the old and new token (shell history, files, clipboard managers).
  4. Check `docker compose logs worker runner | grep -c sk-ant-oat` prints `0` (logs are masked; any hit is a bug to report).
- **Permissions:** the worker (uid 1000) reads `secrets/claude_oauth_token.txt` through the bind mount. Keep
  the file at mode `0400` or `0600` owned by uid 1000 and the directory at `0700`; `npm run compose:config`
  warns about a world-readable credential file.
- **Auth failure steps (until B-022 gives it a dedicated outcome):** the attempt fails once and is not retried.
  1. Confirm in the worker log that the failure is an authentication error (401, "Not logged in", quota).
  2. Check the token has not been revoked or expired; renew it as above (`claude setup-token`,
     `generate-secrets --only claude_oauth_token --force --claude-oauth-token-stdin`).
  3. Restart the worker: `docker compose up -d --force-recreate worker` (the file is read at startup only).
  4. Resubmit the failed tasks. A quota error needs no new token; wait for the limit to reset.
- **Mode switch:** [secrets.md](secrets.md#switching-the-auth-mode).
- **`ptrace_scope` (Linux Docker host):** the protection of `/proc/<claude>/mem` needs Yama
  `kernel.yama.ptrace_scope >= 1`, a host kernel setting that compose cannot set. Check with
  `cat /proc/sys/kernel/yama/ptrace_scope`. Persist with
  `echo 'kernel.yama.ptrace_scope = 1' | sudo tee /etc/sysctl.d/10-orc-ptrace.conf && sudo sysctl --system`.
  With `NODE_ENV=production` the runner refuses to become healthy when the value is missing or `0`
  (a development or test host only logs a warning).

## Disk and workspace pressure

| Signal | Meaning | Action |
|---|---|---|
| Task `blocked` with `insufficient_disk_space` | The worktree volume has less free space than `WORKSPACES_MIN_FREE_BYTES` (5 GiB). | Free space, then retry the task. |
| Task `failed` with `disk_quota_exceeded` | The worktree exceeded `WORKSPACE_MAX_BYTES` (2 GiB) or the project's lower limit. | Raise the project limit if this is legitimate. Otherwise narrow the task scope. |
| Docker disk full | Images, volumes or logs. | Run `docker system df -v` and `docker image prune` (keep the previous release tag for rollback). |

The commands below show where the space goes:

```bash
docker compose exec -T worker df -h /var/lib/orc/workspaces /var/lib/orc/cbm-cache
docker compose exec -T mssql du -sh /var/opt/mssql/data /var/opt/mssql/backups
```

To relieve pressure:

- Lower `WORKSPACE_RETENTION_HOURS` (default 72). The `workspace-cleanup` job runs every 15 min, so
  the change takes effect within 15 min ([retention.md](retention.md)).
- Prune old backups after you copy them off the host:
  `docker compose exec -T mssql find /var/opt/mssql/backups -name '*.bak' -mtime +14 -delete`.
- MSSQL data grows mostly through `TaskLogs`. Lower `LOG_RETENTION_DAYS` if needed. The SQL Server
  Express default edition stops at 10 GB per database: use `MSSQL_PID` with a licensed edition.

## MCP index issues

- **System → MCP** (`/system/mcp`) and the project index panel (`/projects/:id/index-status`) show the
  last and active operations with their `errorCode` and `errorMessage`.
- `503 mcp_disabled`: `MCP_ENABLED=false` for api or worker.
- `409 index_in_progress`: wait for the active operation. Operations stuck in `running` are failed
  automatically (see the table above).
- An index fails while tasks still run: with `MCP_REQUIRED=false` (the default), tasks continue without
  index context. With `true`, they become `blocked` with reason `index_required_failed`.
- To re-index, click **Index now** on the project page (`POST /projects/:id/index`, needs `project:index`).
  If a cached index looks corrupt, use **Sync** first (it refreshes the base snapshot), then **Index now**.
- After you upgrade codebase-memory-mcp, re-index every project ([upgrade-rollback.md](upgrade-rollback.md#codebase-memory-mcp-pin-upgrade)).
- `stale: true` means the project head moved since the last index. Run a sync and an index.
- KI-001 (MCP sessions dropping in the *development* Claude Code sessions) does not affect the product.
  See [troubleshooting.md](troubleshooting.md#ki-001-codebase-memory-mcp-session-disconnects-development-tooling).

## Image CVE review (before each release; ADR-0027)

The npm dependency gate is `npm run audit:deps`. Image contents are reviewed by hand, with no external
scanner service:

1. Rebuild on fresh bases: `docker compose build --pull`.
2. Record the base images and versions: `docker image inspect` for `node:24.18.0-bookworm-slim`,
   `nginxinc/nginx-unprivileged:1.29-alpine`, `redis:7.4-alpine` and
   `mcr.microsoft.com/mssql/server:2022-latest`, plus the Claude CLI and codebase-memory-mcp pins
   from `docker/Dockerfile`.
3. List the OS packages:
   `docker run --rm --entrypoint dpkg-query orc-worker:<tag> -W -f '${Package} ${Version}\n'`
   (alpine images: `docker run --rm --entrypoint apk orc-web:<tag> info -v`).
4. Check the versions against the Debian, Alpine, Node.js, nginx, Redis, SQL Server and Anthropic
   security advisories. Update the base tag or pin for every critical finding, then rebuild.
5. Record the result in the release checklist ([release-checklist.md](release-checklist.md)).

## Incident checklist

1. **Scope.** Find what is down: `docker compose ps`, `/health/ready` and the **System** page
   (workers, queue, DLQ, MCP).
2. **Contain.** For a suspected sandbox escape or leaked secret, stop intake with
   `docker compose stop worker runner`, rotate the affected secrets ([secrets.md](secrets.md)) and keep
   the volumes for analysis. Do not run `down -v`.
3. **Preserve evidence.** Run `docker compose logs --no-color > incident-<date>.log`, export the
   relevant `AuditLogs` (UI **Audit**), and run `node scripts/backup.mjs --out <dir>`.
4. **Diagnose** with [troubleshooting.md](troubleshooting.md), using correlation ids from logs and
   Problem details.
5. **Recover.** Restart the service, restore a backup ([backup-restore.md](backup-restore.md)) or roll
   back the release ([upgrade-rollback.md](upgrade-rollback.md)).
6. **Verify.** Health is ready, a small task completes end to end, and the DLQ and queue are back to normal.
7. **Follow up.** Write a known issue entry in `docs/known-issues.md`, add a regression test, and update
   this runbook.
