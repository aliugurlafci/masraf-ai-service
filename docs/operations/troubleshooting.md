# Troubleshooting

Start with `docker compose ps` and `docker compose logs --tail 200 <service>`. Every API error is an RFC 9457
Problem document with a `code` (catalogue: `GET /api/v1/problems/:code`) and a `requestId` that you can
search for in the logs.

## Installation and startup

| Symptom | Cause | Fix |
|---|---|---|
| `compose-check` reports a missing or invalid secret | The file is absent, empty, or does not match its rule (for example, an Anthropic key containing whitespace). | Run `npm run secrets:generate`, or regenerate one file with `--only <name> --force`. Provide the key with `--anthropic-api-key-stdin`. |
| `generate-secrets` fails in `generate-certs` | openssl runs in `mcr.microsoft.com/mssql/server:2022-latest`, and the image is not pulled yet. | Run `docker pull mcr.microsoft.com/mssql/server:2022-latest`, or pass `--image <image with openssl>`. |
| mssql never becomes healthy | Not enough memory (mssql needs 2 GB or more); the EULA was not accepted; mssql cannot read the TLS key. | Run `docker compose logs mssql`. Raise Docker's memory. Make sure `mssql_tls_key.pem` is readable (`0644`). On a fresh host, regenerate the db set with `--only db --force`. |
| `db-bootstrap` fails with `Login failed for user 'sa'` | An existing `mssql-data` volume was created with a different sa password. | Restore the old `mssql_sa_password.txt`, or change sa as described in [secrets.md](secrets.md#sql-server-sa-password). |
| migrator exits 2 (`MigrationChecksumError`) | An applied migration file was changed, or an applied migration has no file. | Never edit applied migrations. Deploy the matching release ([upgrade-rollback.md](upgrade-rollback.md)). |
| api or worker never ready (`migrations` check fails) | The schema is older than expected (the migrator did not run) or newer than the image (rolled back without a restore). | Check `docker compose ps -a` for migrator `exited (0)`. For a rollback, restore the pre-upgrade backup. |
| api fails at startup with a config error | `PUBLIC_ORIGIN` is not https in production, or `CLAUDE_DEFAULT_MODEL` is not in `CLAUDE_ALLOWED_MODELS`. | Fix `.env` and run `npm run compose:up`. |
| worker not ready: CLI probe failed | The Claude CLI is missing a required flag (pin changed), or the runner is unreachable. | Run `docker compose logs worker runner`. Keep the pinned CLI version ([upgrade-rollback.md](upgrade-rollback.md#claude-cli-pin-upgrade)). |
| worker exits: lease TTL or self-fence check | `RUNNER_LEASE_TTL_MS` is greater than `ATTEMPT_STALE_MS - 2 × HEARTBEAT_INTERVAL_MS`. | Restore the defaults (40000 / 60000 / 10000). |
| worker exits: `GIT_HOOKS_DIR` must be empty and read-only | A custom value or a writable directory. | Use the image default `/opt/orc/git/empty-hooks`. In development, create an empty directory and set it to `0555`. |
| runner unhealthy | The worker image is missing the sandbox users, a capability was dropped by an override, or the runner-sock volume has wrong modes. | Do not change `cap_add` or the runner `user`. If needed, remove the volume with `docker volume rm orc_runner-sock` and run `npm run compose:up`. |
| `up --wait` times out on the first run | The image builds take long (npm ci, CLI download). | Run it again; the build cache makes the next run fast. |

## Web, login and API

| Symptom | Cause | Fix |
|---|---|---|
| The browser warns about the certificate | The local CA is not trusted. | Import `secrets/web_ca_cert.pem`, or install an operator certificate ([secrets.md](secrets.md#web-tls-certificate)). |
| Login returns 403 `csrf_failed`, or unsafe requests fail | The browser origin differs from `PUBLIC_ORIGIN` (host name or port). | Set `PUBLIC_ORIGIN` to the exact origin users type, then run `npm run compose:up`. |
| Login succeeds but the next request is 401 | The site is opened over plain HTTP, or a proxy strips `Set-Cookie`. The `__Host-orc_sid` cookie requires HTTPS. | Use `https://<host>:8443`. An operator proxy must forward HTTPS to 8443 unchanged. |
| 429 `login_throttled` | Too many failures (5 per user / 20 per IP in 15 min). | Wait for `Retry-After`. An admin can unlock the user (`POST /users/:id/unlock`). |
| SSE output arrives in bursts or stops | An extra proxy buffers responses. | Disable buffering for `/api/` (nginx: `proxy_buffering off`; the bundled web container already does this). The client reconnects with `Last-Event-ID` and nothing is lost. |
| 503 `dependency_unavailable` | The DB or Redis is down. | Check `docker compose ps mssql redis` and `/health/ready`. |

## Projects and tasks

| Symptom | Cause | Fix |
|---|---|---|
| Project `invalid`: path or repository error | `repoPath` is not a git repository under `projects/`, or the directory is not readable by uid 1000. | Run `git -C projects/<path> status` on the host. On Linux, make the tree world-readable (`chmod -R a+rX projects/<path>`). Then **Sync**. |
| Project stays `validating` | The sync job is waiting or failing. | Check the worker logs. The reconciler re-enqueues stale syncs after 10 min. |
| Task `blocked` with `insufficient_disk_space` | Free disk space is below `WORKSPACES_MIN_FREE_BYTES`. | See [runbook.md](runbook.md#disk-and-workspace-pressure). |
| Task `failed` with `claude_start_failed` or `claude_protocol_error` | The CLI did not start, or its init event failed the fail-closed validation (unexpected tools, MCP servers or permission mode). | Read the task events and the `security_violation` events. Check the agent's tool rules. Never relax the validation. |
| Task `failed` with `claude_result_error` or `budget_exceeded` | Claude reported an error, or reached the agent's budget. | Read the **Session** tab. Adjust the agent budget or the task. |
| Task `failed` with `test_failed`, `test_command_error` or `test_timeout` | The project test command failed or hung. It runs without network and without credentials. | Run the same argv in a clean checkout. Tests that need network or services do not work inside the sandbox. |
| Task `failed` with `disk_quota_exceeded` | The worktree exceeds the quota. | Raise the project's `workspaceMaxBytes` (up to `WORKSPACE_MAX_BYTES`). |
| Task `failed` with `recovery_limit_reached` | The worker died repeatedly (OOM, or the runner restarted). | Run `docker compose logs runner worker` and check memory limits ([runbook.md](runbook.md#worker-scaling)). |
| Claude cannot reach the API (`ECONNRESET`, 403 from the proxy) | `api.anthropic.com` is not in `EGRESS_ALLOWED_HOSTS`, or the host has no outbound route. | Run `docker compose logs egress-proxy`. Each decision is logged with host, port and allow status. |
| Diff shows "removed by retention" | Patch bodies older than `PATCH_RETENTION_DAYS`. | Expected behavior ([retention.md](retention.md)). |

## MCP

See [runbook.md](runbook.md#mcp-index-issues) for index failures, `mcp_disabled`, `index_in_progress` and
stale indexes.

## KI-001: codebase-memory-mcp session disconnects (development tooling)

This issue affects the **Claude Code sessions used to develop this repository**, not the product. In long
sessions the stdio connection to the local `codebase-memory-mcp` server drops, and the server shows as
"failed to connect". The binary and its index stay healthy. The product's `@orc/mcp-manager` starts a new
stdio client for each operation, with timeouts (contract §12.1), so the product is not affected.

Workaround: call the same tools through the binary's CLI, with identical tool names and arguments. In
Git Bash:

```bash
codebase-memory-mcp cli --quiet search_graph '{"project":"C-Workout-masraf-ai-service","name_pattern":"resolveWithin"}'
codebase-memory-mcp cli --quiet index_status '{"project":"C-Workout-masraf-ai-service"}'
```

In PowerShell, escape the inner quotes: `'{\"project\":\"...\"}'`. In an interactive session, reconnect
with `/mcp`. Full record: `docs/known-issues.md`.

## Windows and Docker Desktop

- Use the **Linux** container engine. The repository and the `projects/` directory must be on a drive
  that Docker Desktop shares; this is the default for the user profile.
- Clone projects with `core.autocrlf=false` (or `input`). Otherwise, Windows line endings show up as
  changed lines in task diffs.
- File modes are not preserved on NTFS bind mounts. The containers read the files through Docker Desktop
  with world-readable permissions, so the POSIX `chmod` steps do not apply.
- Development mode on Windows runs `SANDBOX_MODE=local`: no isolation, for trusted repositories only.

## `npm run test:compose` failures

The script prints the last 60 log lines of api, worker, runner and egress-proxy, then removes the stack.
Run it again with `--keep` to inspect: the containers, volumes and the temporary secrets directory stay
until you run `docker compose -p orc-smoke down -v`. The `orc-smoke` project uses ports 18443 and 18088
and image tag `smoke`, so it does not touch a regular `orc` stack. If ports are taken, use `--https-port`
and `--http-port`. If an earlier `--keep` run still exists, the script refuses to start.

## `npm run test:linux` ve codebase-memory-mcp (CBM)

`npm run test:linux` Linux test imajını (`orc-test-linux:24.18.0-git-cbm<CBM_VERSION>`) ilk kullanımda üretir:
önce `docker build -f docker/Dockerfile --target cbm -t orc-cbm:<CBM_VERSION> .` (checksum doğrulamalı indirme),
sonra ikili `/usr/local/bin/codebase-memory-mcp` olarak test imajına kopyalanır. `<CBM_VERSION>` tek kaynaktan,
`docker/Dockerfile` içindeki `ARG CBM_VERSION` satırından okunur; sürüm değişince etiket değişir ve imaj yeniden üretilir.
Konteynere `CODEBASE_MEMORY_MCP_BIN` ve `ORC_REQUIRE_CBM=1` geçirilir (ikili yoksa `cbm-anchor` ve `mcp-real` testleri FAIL verir).

Kısıt: CBM release asset'i yalnızca linux/amd64 için vardır. arm64 Docker host'ta `--target cbm` build'i başarısız olur
ve `test:linux` bu nedenle çalışmaz; amd64 host veya amd64 emülasyonu gerekir.
