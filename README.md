# Claude Code Orchestrator

A self-hosted platform that runs Claude Code tasks on your repositories. Users pick a project in the web
UI and describe a task. The orchestrator then:

1. Queues the task (BullMQ on Redis).
2. Creates an isolated Git worktree from a read-only mirror of the repository.
3. Indexes the code with codebase-memory-mcp.
4. Runs the Claude Code CLI in a separate, sandboxed worker process.
5. Streams the output live over SSE.
6. Runs the project's tests and stores logs, events, diffs, test results and audit records in Microsoft
   SQL Server.

The real repositories are never modified. Each result is a branch in the orchestrator's mirror plus a
downloadable patch. This is production software, not a proof of concept.

## Architecture

```
browser ──HTTPS──▶ web (nginx, TLS) ──▶ api (Express, REST + SSE) ──▶ MSSQL (source of truth)
                                            │                       ▲
                                            ▼                       │
                                      Redis (BullMQ, live streams) ─┤
                                            ▼                       │
                                   worker (pipeline, git only) ─────┘
                                            │ Unix socket (lease + spawn protocol)
                                            ▼
                         runner sandbox: Claude CLI, test command, codebase-memory-mcp
                                            │ CONNECT api.anthropic.com:443 + token
                                            ▼
                                     egress-proxy ──▶ internet (Anthropic API only)
```

| Component | Path | Role |
|---|---|---|
| api | `apps/api` | REST API `/api/v1`, sessions/PATs, RBAC, SSE, OpenAPI 3.1 at `/api/openapi.json`, Swagger UI at `/api/docs` |
| worker | `apps/worker` | BullMQ consumers. Runs the task pipeline (workspace → index → Claude → tests → review), maintenance jobs and heartbeats. Spawns only `git`. |
| runner | `apps/runner` | Execution sandbox. Runs every untrusted process under a per-lease uid, with process limits (ADR-0024). |
| egress-proxy | `apps/egress-proxy` | The only route to the internet: authenticated `CONNECT` to allow-listed hosts. |
| web | `apps/web` | React SPA, served by nginx-unprivileged with TLS termination (ADR-0025). |
| db-cli | `packages/database` (`orc-db`) | bootstrap, migrate, seed, create-admin, backup, purge-audit |

The full technical contract is in [docs/architecture/contract.md](docs/architecture/contract.md). Further
reading: an overview in [docs/architecture/overview.md](docs/architecture/overview.md), failure handling
in [docs/architecture/failure-recovery.md](docs/architecture/failure-recovery.md), decisions in
[docs/adr/](docs/adr/), security in [docs/security/](docs/security/) and operations in
[docs/operations/](docs/operations/).

## Quick start (Docker Compose)

Prerequisites: Docker with Compose v2.24+, Node.js 24.18.0, git, and a Claude subscription (the Claude CLI is needed once for `claude setup-token`). The full
procedure, including remote access and development mode, is in
[docs/operations/installation.md](docs/operations/installation.md).

```bash
npm ci
npm run secrets:generate                                   # passwords, tokens, CAs, TLS certificates → ./secrets
claude setup-token                                         # prints a long-lived subscription token (sk-ant-oat01-...)
node scripts/generate-secrets.mjs --only claude_oauth_token --claude-oauth-token-stdin < /path/to/token-file
git clone <your repo> projects/my-service                  # repositories live under ./projects (mounted read-only)
npm run compose:up                                         # validate secrets, build, start, wait until healthy
docker compose run --rm db-cli create-admin --username admin
```

Then trust `secrets/web_ca_cert.pem` in your browser, open `https://localhost:8443`, register
`my-service` under **Projects** and submit a task.

## Commands

| Command | What it does |
|---|---|
| `npm run lint` | ESLint (typescript-eslint, the import rules of contract §1.2, no `console`) |
| `npm run typecheck` | `tsc --noEmit` for the root project and `apps/web` |
| `npm test` | All standard test projects: unit, integration, api, security, e2e and web. Never calls the real Claude. |
| `npm run test:unit` | Unit tests, with no infrastructure |
| `npm run test:integration` | MSSQL test DB, Redis test instance, temporary git repos, worktrees and file system. Requires `npm run infra:test:up`. Some cases run only on Linux and are skipped elsewhere. |
| `npm run test:api` | HTTP API tests (supertest) |
| `npm run test:security` | Security gates plus the placeholder check and the dependency audit |
| `npm run test:e2e` | End-to-end pipeline with the fake CLI: lifecycle, cancel, timeout, retry, crash recovery, concurrency |
| `npm run test:web` | Web UI component tests (jsdom) |
| `npm run infra:test:up` / `infra:test:down` | Starts or removes the disposable test MSSQL (127.0.0.1:14331, `orchestrator_test`) and Redis (127.0.0.1:16380) |
| `npm run test:report` | Writes JUnit XML (`reports/junit-*.xml`) and an HTML report (`reports/html/`) |
| `npm run test:claude-live` | **The only command that calls the real Claude Code.** Run it explicitly with a key. `-- permission-boundary` is the release gate for every CLI version. |
| `npm run test:compose` | Pre-release gate: builds and starts the full stack as the separate project `orc-smoke` with the fake CLI. It then checks HTTPS health, create-admin, project and index, a task with SSE, diff and tests, cancel, timeout, the sandbox-escape probes, the fork-bomb bound, non-root containers, network isolation, and backup plus restore. Finally it tears the stack down (`--keep` keeps it). Needs Docker and about 15-30 min on the first run. |
| `npm run audit:deps` | npm advisory audit, failing on critical findings (ADR-0027) |
| `npm run build` | Builds api, worker (and runner), egress-proxy and web |
| `npm run dev:api` / `dev:worker` / `dev:web` | Development mode on the host ([installation.md §12](docs/operations/installation.md#12-development-mode-on-the-host)) |
| `npm run secrets:generate` / `certs:generate` | Generates secrets and TLS material ([secrets.md](docs/operations/secrets.md)) |
| `npm run compose:config` / `compose:up` / `compose:down` | Validates secrets and renders the config / builds and starts / stops |
| `npm run compose:backup` / `compose:restore` | Database backup and restore ([backup-restore.md](docs/operations/backup-restore.md)) |
| `npm run db:bootstrap` / `db:migrate` / `db:seed` / `db:create-admin` | `orc-db` on the host (development) |

## Security model

- **Untrusted code runs only in the runner sandbox.** Claude, its tool children, the project test command
  and codebase-memory-mcp all run as one of the sandbox uids 20000-20063, one uid per lease, under
  `prlimit`. Each lease can reach only its own worktree, Claude home and MCP cache. The runner has no
  secrets, no projects mount, and only the internal `sandbox` network. The worker itself runs only
  hardened `git`.
- **Ratified exception (ADR-0024).** The runner *launcher* is the only process that runs as root, so that
  it can switch uids and hand over files. It keeps exactly six capabilities (`SETUID`, `SETGID`, `CHOWN`,
  `FOWNER`, `DAC_READ_SEARCH`, `KILL`), runs with `no-new-privileges` and a read-only root, and never
  executes untrusted code. Every other container (api, worker uid 1000, web uid 101, egress-proxy, redis,
  mssql, db tools) runs non-root with `cap_drop: [ALL]`. `npm run test:compose` checks this on the live
  stack.
- **Network.** Five networks; only the egress proxy has an internet route. The proxy tunnels only
  `CONNECT` to `api.anthropic.com:443`, and only with its token, which only Claude processes receive. Test
  and MCP processes are offline. MSSQL and Redis cannot be reached from the sandbox.
- **No Docker socket, no `~/.ssh` and no host root** is mounted anywhere. Real repositories are mounted
  read-only.
- **Secrets** are compose file secrets read through `*_FILE` variables. They are masked in logs,
  TaskLogs, stderr tails, audit records and error responses.
- **Least-privilege data access.** SQL logins `orc_api`, `orc_worker`, `orc_migrator` and `orc_backup`
  have object-level grants; `sa` is used only by bootstrap and restore. TLS to SQL Server is verified
  against a private CA (ADR-0026). The production and test databases are separated, and a name guard
  enforces this.
- **Web.** HTTPS with HSTS, `__Host-` session cookies (HttpOnly, SameSite=Strict), CSRF token plus Origin
  check, rate limits, RBAC with owner scoping (another user's task answers 404), and an audit log of every
  change.
- **Input handling.** All external input is validated with Zod. Processes are started only as argv arrays
  with `shell: false`. Paths are pinned to their root with `resolveWithin`. SQL is always parameterized.

Details: [docs/security/](docs/security/) and contract §10.11 and §15.

## Repository layout

```
apps/
  api/            REST API + SSE (Express 5)
  worker/         queue consumers and task pipeline
  runner/         execution sandbox launcher (built into the worker image)
  egress-proxy/   authenticated CONNECT proxy
  web/            React SPA (Vite)
packages/
  shared/         types, constants, Zod schemas, config loaders (browser-safe + /node)
  security/       path, argv, ref validation, secret masking
  logger/         Pino logger with redaction and log context
  database/       MSSQL access, migrations, seed, orc-db CLI
  task-manager/   task state machine, queues, live streams
  project-manager/ project registration and index requests
  orchestrator/   attempt pipeline stages
  claude-runner/  Claude CLI invocation, stream-json parsing, init validation
  git-manager/    bare mirrors, worktrees, diffs, patches, retention
  mcp-manager/    codebase-memory-mcp client and index operations
  sandbox/        runner protocol (client + server) and local launcher
docker/           Dockerfile (all images), nginx, mssql config, healthcheck
scripts/          secrets/certs generation, compose-check, backup/restore, compose smoke gate, audits
tests/            unit, integration, api, security, e2e, claude-live, fixtures (fake-claude, fake-mcp), helpers
docs/             architecture contract, ADRs, security, operations, requirements, known issues
projects/         your repositories (gitignored, mounted read-only)
docker-compose.yml        production topology
docker-compose.smoke.yml  test:compose override (fake CLI, alternate ports)
docker-compose.test.yml   disposable test infrastructure
```
