# Installation

This guide installs the orchestrator with Docker Compose on a single host (contract §19). It also covers
the development mode on the host. Operations after installation: [runbook.md](runbook.md).

## 1. Prerequisites

| Item | Requirement |
|---|---|
| Host | Linux x86_64 (production target) or Windows/macOS with Docker Desktop (Linux engine) for evaluation. The images ship the `linux-x64` Claude CLI and the `linux-amd64` codebase-memory-mcp binary. |
| Docker | Docker Engine 24+ with Compose v2.24+ (`docker compose version`). The `!override` tag in `docker-compose.smoke.yml` needs v2.24+. |
| CPU / memory | 4+ CPUs and 12+ GB RAM available to Docker. Container limits: mssql 4g, runner 4.5g, worker 2g, api 1g, redis 512m, web, egress-proxy and one-shot tools 128-256m. |
| Disk | 20+ GB free for images, the MSSQL volume, backups and worktrees. The worker refuses new worktrees below `WORKSPACES_MIN_FREE_BYTES` (5 GiB). |
| Node.js | v24.18.0 and npm 11 on the host, for the operator scripts (`scripts/*.mjs`) and the development mode. |
| Git | Any recent git on the host, to place repositories under `projects/`. |
| Network | Outbound HTTPS for the image build (npm registry, Docker Hub, mcr.microsoft.com, GitHub release of codebase-memory-mcp) and at runtime only `api.anthropic.com:443` through the egress proxy. |
| Anthropic | An API key for Claude Code (`CLAUDE_BARE=true` in production). |

## 2. Get the code and install the host tooling

```bash
git clone <repository url> orchestrator
cd orchestrator
npm ci
```

## 3. Generate secrets and certificates

```bash
npm run secrets:generate
```

This writes the passwords, tokens, the local web CA, the private SQL Server CA and both server
certificates into `./secrets` (gitignored). Details and permissions: [secrets.md](secrets.md). Options:

- `-- --web-server-name orc.example.internal --san 10.0.0.15` adds names to the web certificate.
- `ORC_SECRETS_DIR=/srv/orc/secrets` keeps the secrets outside the checkout. Every script and
  `docker-compose.yml` read the same variable.

The Anthropic API key cannot be generated. Provide it on stdin so that it does not appear in shell history:

```bash
node scripts/generate-secrets.mjs --only anthropic_api_key --anthropic-api-key-stdin < /path/to/key-file
```

PowerShell: `Get-Content C:\path\key.txt | node scripts/generate-secrets.mjs --only anthropic_api_key --anthropic-api-key-stdin`.

## 4. Optional settings

`docker compose` reads a `.env` file in the repository root for interpolation. The supported variables
are listed in the header of `docker-compose.yml`:

| Variable | Default | Purpose |
|---|---|---|
| `WEB_BIND_ADDRESS` | `127.0.0.1` | Host address for the published web ports 8443 (HTTPS) and 8088 (redirect only). |
| `WEB_SERVER_NAME` | `localhost` | nginx `server_name`; regenerate the web certificate when you change it. |
| `PUBLIC_ORIGIN` | `https://localhost:8443` | Origin that browsers use. It must be `https:` unless the host is a loopback address. Login and CSRF compare it with `Origin`. |
| `ORC_SECRETS_DIR` / `ORC_PROJECTS_DIR` | `./secrets` / `./projects` | Locations of the secrets and of the repositories. |
| `ORC_IMAGE_TAG` / `APP_VERSION` | `local` / `0.1.0` | Image tag and the version reported by `/health` (see [upgrade-rollback.md](upgrade-rollback.md)). |
| `WORKER_CONCURRENCY` | `2` | Parallel attempts per worker (see the scaling notes in [runbook.md](runbook.md#worker-scaling)). |
| `CLAUDE_ALLOWED_MODELS` / `CLAUDE_DEFAULT_MODEL` | `sonnet,opus,haiku` / `sonnet` | Models accepted by the API; the seed gives agents the default model. |
| `EGRESS_ALLOWED_HOSTS` | `api.anthropic.com` | Hosts that the egress proxy tunnels. |
| `MCP_ENABLED` / `MCP_REQUIRED` | `true` / `false` | codebase-memory-mcp indexing; when it is required, a failed index blocks the task. |
| `MSSQL_PID` | `Express` | SQL Server edition. Express limits a database to 10 GB; set your licensed edition for larger data. |
| `LOG_LEVEL` | `info` | Log level of all Node services. |

Any other setting from contract §16 (for example the retention variables in [retention.md](retention.md))
goes into a local `docker-compose.override.yml` under `services.<name>.environment`. That file is loaded
automatically by `npm run compose:up` and `compose:config`. Keep it local and never put secrets in it.

## 5. Place the project repositories

Every project is a git repository in a directory under `projects/` (or `ORC_PROJECTS_DIR`):

```bash
git clone https://git.example.com/team/service-a.git projects/service-a
```

The directory is mounted read-only into the worker. The orchestrator never writes to it. It fetches the
repository into its own bare mirror and runs every task in a separate worktree. To pick up new commits,
update the checkout under `projects/` with `git pull`. Then use **Sync** in the UI (`POST /projects/:id/sync`).

## 6. Build and start

```bash
npm run compose:config   # renders the configuration and validates every secret file
npm run compose:up       # compose-check + docker compose up -d --build --wait
```

The startup order is enforced by `depends_on`:

1. mssql becomes healthy. It uses TLS with the private CA.
2. `db-bootstrap` creates the database, the logins `orc_migrator`, `orc_api`, `orc_worker` and
   `orc_backup`, and the users, then exits.
3. `migrator` applies the forward-only migrations, seeds the teams and agents, then exits.
4. redis, egress-proxy and runner become healthy, then api and worker, then web.

`--wait` returns when every long-running service is healthy. Check the result with `docker compose ps`.
Both one-shot services must show `exited (0)`.

## 7. Create the first administrator

```bash
docker compose run --rm db-cli create-admin --username admin --display-name "Administrator"
```

The password is read from the terminal without echo. It is never accepted as an argument and must be at
least 12 characters. For automation, pipe it on stdin with `-T`, for example
`docker compose run --rm -T db-cli create-admin --username admin < password-file`.

## 8. Open the web UI

1. Trust the local CA: import `secrets/web_ca_cert.pem` into the browser or OS trust store. For remote
   users, install a certificate for your host name instead (see [secrets.md](secrets.md#web-tls-certificate)).
2. Browse to `https://localhost:8443`. Plain `http://localhost:8088` only redirects to HTTPS.
3. Log in as the administrator. Then create users and teams under **Teams** and personal access tokens
   under **Account**.

## 9. Register a project

In the UI, open **Projects** and choose **New project**:

| Field | Example | Notes |
|---|---|---|
| Name | `service-a` | `^[A-Za-z0-9][A-Za-z0-9 ._-]{1,99}$` |
| Repository path | `service-a` | Relative to `projects/`. No `..` and no absolute paths. |
| Test command | `["npm","test"]` | An argv array, never a shell string. It runs inside the sandbox with no network. |
| JUnit report path | `reports/junit.xml` | Optional, relative to the worktree. |
| Auto index | on | Builds the codebase-memory-mcp index after the sync. |

The project starts as `validating` and becomes `ready` after the sync. It becomes `invalid` if the
repository is invalid; the status detail gives the reason. The index panel on the project page shows the
index status.

The same request with a personal access token (PAT authentication needs no CSRF token):

```bash
curl --cacert secrets/web_ca_cert.pem -H "Authorization: Bearer $ORC_TOKEN" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"name":"service-a","repoPath":"service-a","testCommand":["npm","test"],"autoIndex":true}' \
  https://localhost:8443/api/v1/projects
```

## 10. Run the first task

In the UI, open **Tasks**, choose **New task**, then pick the project and the agent and describe the work.
The task detail page streams the output live over SSE. When the task finishes, the **Changes**, **Diff**,
**Tests**, **Session** and **Impact** tabs show the results. With the API:

```bash
curl --cacert secrets/web_ca_cert.pem -H "Authorization: Bearer $ORC_TOKEN" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"projectId":"<id>","title":"Add health endpoint","prompt":"Add GET /health returning 200."}' \
  https://localhost:8443/api/v1/tasks
curl -N --cacert secrets/web_ca_cert.pem -H "Authorization: Bearer $ORC_TOKEN" \
  https://localhost:8443/api/v1/tasks/<taskId>/stream
```

The orchestrator never merges a task. The result is a branch in its mirror and a patch: download it from
**Diff → patch** (`GET /tasks/:id/patch`) and apply it through your normal review process.

## 11. Verify the installation

- `docker compose ps`: every service is `healthy` and both one-shots show `exited (0)`.
- `curl --cacert secrets/web_ca_cert.pem https://localhost:8443/health/ready` returns `{"status":"ok",...}`.
- On the **System** page, the worker is `ready` and shows the CLI and MCP versions.
- Pre-release gate on a staging host: `npm run test:compose`. It builds and starts a separate `orc-smoke`
  stack with the fake CLI and removes it at the end (see the [README](../../README.md#commands)).

## 12. Development mode on the host

Development runs the apps with `tsx watch` on the host, against a development SQL Server and Redis. In
development, `SANDBOX_MODE=local` is the default: Claude, tests and MCP run as **your own user with no
isolation**. Use development mode only with repositories that you trust.

Never use the test containers (`npm run infra:test:up`, database `orchestrator_test`) for development.
The test global setup drops that database.

### Quick path (Windows, macOS, Linux)

```bash
npm run dev:setup                                   # once; safe to repeat
npm run dev:create-admin -- --username admin        # once; asks for the password interactively
npm run dev:api                                     # :4000, each in its own terminal
npm run dev:worker                                  # :4100
npm run dev:web                                     # http://127.0.0.1:5173
```

`dev:setup` generates the development passwords once and keeps them in `~/.orc-dev/dev.env` (outside the
repository; never printed). It starts or reuses `orc-dev-mssql` (127.0.0.1:14330) and `orc-dev-redis`
(127.0.0.1:16379), runs `db:bootstrap`, `db:migrate` and `db:seed` as the migrator login, and creates
`projects/`, `workspaces/` and `~/.orc-dev/{claude,cbm-cache,empty-hooks}`. `dev:api` and `dev:worker` merge
`dev.env` with the application-specific values of steps 2 and 4 below and start `tsx watch`. A variable that
is already set in your shell wins over `dev.env`; extra `KEY=VALUE` lines in `dev.env` (for example
`ANTHROPIC_API_KEY`) are forwarded. If `dev.env` is missing, the commands tell you to run `dev:setup`.
Ctrl+C stops the whole process tree. The manual steps below do the same by hand.

### Manual path

1. Start a development SQL Server and Redis, bound to loopback:

   ```bash
   node -e "import('./scripts/generate-secrets.mjs').then((m) => console.log(m.generatePassword()))"   # run once per password
   docker run -d --name orc-dev-mssql -e ACCEPT_EULA=Y -e MSSQL_PID=Developer \
     -e MSSQL_SA_PASSWORD="$DEV_SA_PASSWORD" -p 127.0.0.1:14330:1433 mcr.microsoft.com/mssql/server:2022-latest
   docker run -d --name orc-dev-redis -p 127.0.0.1:16379:6379 redis:7.4-alpine \
     redis-server --maxmemory 400mb --maxmemory-policy noeviction --appendonly yes
   ```

2. Export the development configuration in your shell. In PowerShell, use `$env:NAME = 'value'`.

   ```bash
   export NODE_ENV=development DB_HOST=127.0.0.1 DB_PORT=14330 DB_NAME=orchestrator_dev \
          DB_TRUST_SERVER_CERTIFICATE=true REDIS_HOST=127.0.0.1 REDIS_PORT=16379 LOG_PRETTY=true \
          CLAUDE_ALLOWED_MODELS=sonnet,opus,haiku CLAUDE_DEFAULT_MODEL=sonnet
   ```

   `DB_TRUST_SERVER_CERTIFICATE=true` and `COOKIE_SECURE=false` are accepted only when `NODE_ENV` is
   `development` or `test`. A `DB_NAME` that ends in `_test` is rejected outside `test`.

3. Create, migrate and seed the database, then create an admin. Each command runs as the migrator login:

   ```bash
   export DB_USER=orc_migrator DB_PASSWORD="$DEV_MIGRATOR_PASSWORD" MSSQL_SA_PASSWORD="$DEV_SA_PASSWORD" \
          DB_MIGRATOR_PASSWORD="$DEV_MIGRATOR_PASSWORD" DB_API_PASSWORD="$DEV_API_PASSWORD" \
          DB_WORKER_PASSWORD="$DEV_WORKER_PASSWORD" DB_BACKUP_PASSWORD="$DEV_BACKUP_PASSWORD"
   npm run db:bootstrap && npm run db:migrate && npm run db:seed
   npm run db:create-admin -- --username admin
   unset MSSQL_SA_PASSWORD
   ```

4. Start the apps, each in its own terminal and with the variables from step 2:

   ```bash
   DB_USER=orc_api DB_PASSWORD="$DEV_API_PASSWORD" COOKIE_SECURE=false npm run dev:api        # :4000
   DB_USER=orc_worker DB_PASSWORD="$DEV_WORKER_PASSWORD" \
     PROJECTS_ROOT="$PWD/projects" WORKSPACES_ROOT="$PWD/workspaces" \
     CLAUDE_HOME_ROOT="$HOME/.orc-dev/claude" CBM_CACHE_DIR="$HOME/.orc-dev/cbm-cache" \
     GIT_HOOKS_DIR="$HOME/.orc-dev/empty-hooks" CLAUDE_BARE=false npm run dev:worker          # :4100
   npm run dev:web                                                                             # http://127.0.0.1:5173
   ```

   `GIT_HOOKS_DIR` must be an empty, read-only directory: `mkdir -p ~/.orc-dev/empty-hooks && chmod 0555 ~/.orc-dev/empty-hooks`.
   With `CLAUDE_BARE=false`, the worker uses your local Claude Code login. To use an API key instead,
   set `ANTHROPIC_API_KEY` and leave `CLAUDE_BARE` unset. The Claude CLI 2.1.316 and codebase-memory-mcp
   0.12.0 must be on `PATH`. Otherwise, set `CLAUDE_BIN` and `CODEBASE_MEMORY_MCP_BIN`.
   The Vite dev server proxies `/api` to `VITE_API_PROXY_TARGET` (default `http://127.0.0.1:4000`).

5. Tests use their own containers: `npm run infra:test:up`, then `npm test` (see the [README](../../README.md#commands)).
