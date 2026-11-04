# Architecture Decision Records

| ADR | Title |
|---|---|
| [0001](0001-monorepo-npm-workspaces-source-first.md) | npm workspaces monorepo with source-first packages |
| [0002](0002-shared-browser-safe-node-subpath.md) | @orc/shared is browser-safe; node helpers live in @orc/shared/node |
| [0003](0003-tsup-app-bundling.md) | tsup bundles deployable entry points |
| [0004](0004-tsx-dev-runner.md) | tsx for development and CLI scripts |
| [0005](0005-ioredis-redis-client.md) | ioredis as the Redis client |
| [0006](0006-mcp-typescript-sdk-client.md) | @modelcontextprotocol/sdk for the codebase-memory-mcp client |
| [0007](0007-react-router.md) | react-router for SPA routing |
| [0008](0008-tanstack-react-query.md) | @tanstack/react-query for server state |
| [0009](0009-zod-to-openapi.md) | @asteasolutions/zod-to-openapi generates OpenAPI 3.1 |
| [0010](0010-swagger-ui-express.md) | swagger-ui-express serves interactive docs |
| [0011](0011-junit-xml-parser.md) | fast-xml-parser for JUnit XML reports |
| [0012](0012-nginx-unprivileged-web.md) | nginx-unprivileged serves the SPA and proxies /api |
| [0013](0013-egress-proxy.md) | In-house CONNECT allow-list egress proxy |
| [0014](0014-server-side-sessions-scrypt.md) | Server-side sessions, PATs and scrypt password hashing |
| [0015](0015-bare-mirror-git-design.md) | Per-project bare mirror with per-attempt worktrees |
| [0016](0016-claude-runner-bare-mode.md) | Claude runner uses --bare with an isolated config directory |
| [0017](0017-redis-streams-live-output.md) | Redis Streams plus MSSQL chunks for live output |
| [0018](0018-custom-migration-runner.md) | Custom SQL migration runner and raw mssql repositories |
| [0019](0019-api-never-touches-repositories.md) | API never touches repositories or workspaces; diffs and patches live in MSSQL |
| [0020](0020-api-middleware-libraries.md) | helmet, pino-http, cookie and rate-limiter-flexible in the API |
| [0021](0021-dev-and-test-tooling.md) | Development and test tooling |
| [0022](0022-per-workspace-mcp-index-cache.md) | Per-workspace codebase-memory-mcp cache directories |
| [0023](0023-task-state-machine-refinements.md) | Task state machine refinements |
| [0024](0024-execution-sandbox-runner.md) | Untrusted processes run in a separate `runner` sandbox container (GPM ratification required) |
| [0025](0025-tls-termination-at-web.md) | TLS is terminated by the web container |
| [0026](0026-sql-server-tls-private-ca.md) | SQL Server connections use TLS verified against a private CA |
| [0027](0027-dependency-audit-npm-registry.md) | Dependency audit uses the npm registry advisory endpoint |
| [0028](0028-cbm-embedded-sqlite-cache.md) | codebase-memory-mcp's embedded SQLite store is a disposable cache |
| [0029](0029-contract-2-review-hardening.md) | Contract 2.0.0 interface hardening from the A7 review |
| [0030](0030-phase-b-deviations.md) | Phase B deviations: no DENY CONTROL, project_index always full, actual test paths, runner logger service |
| [0031](0031-phase-c-deviations.md) | Phase C deviations: workspace-busy hand-off to infra recovery, fence with kill grace, in-process API auth-cleanup, SSE d-id resume, index stale rule |
| [0032](0032-local-mode-single-worker-per-namespace.md) | Local sandbox mode assumes one worker per uid and PID namespace |
| [0033](0033-local-transport-safe-directory.md) | safe.directory reaches the local-transport upload-pack through a per-call global config file |
| [0034](0034-cbm-cache-anchor-dirs.md) | Runner anchors the codebase-memory-mcp cache structure dirs as root:worker-gid 1775 |
| [0035](0035-diff-seeded-impact-analysis.md) | Impact analysis is seeded from the worker's diff (no git in the sandbox); CBM socket path length is validated |

New ADRs: next free number, same section layout (Status, Context, Decision, Consequences, Alternatives considered, Rollback path).
