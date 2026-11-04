# Security controls

Each control → where it is implemented → which test proves it. Threats: [threat-model.md](threat-model.md). Gate status: [quality-gates.md](quality-gates.md). Contract references are to `docs/architecture/contract.md`.

## Authentication, sessions, RBAC (§15)

| Control | Implementation | Proof |
|---|---|---|
| scrypt password hashing (N=2^17), bounded concurrency, constant-cost dummy verify | `packages/security/src/hashing.ts` | `tests/unit/security/hashing.test.ts` |
| Login throttling per IP and per username, lockout | `apps/api/src/routes/auth.ts`, `packages/database` | `tests/api/auth.test.ts`, `tests/api/rate-limit.test.ts` |
| `__Host-` session cookie (HttpOnly, SameSite=Strict, Secure), idle/absolute TTL | `apps/api/src/auth.ts` | `tests/api/auth.test.ts` |
| CSRF token + Origin check on unsafe methods | `apps/api/src/auth.ts` | `tests/security/authorization.test.ts`, `tests/security/audit.test.ts`, `tests/api/auth.test.ts` |
| PATs: SHA-256 stored, read-only scope, never for tokens/password/users | `apps/api/src/auth.ts`, `generatePat` | `tests/security/authorization.test.ts` |
| Role x permission matrix, route-level `requirePermission` | `packages/task-manager/src/viewer.ts`, `apps/api/src/route.ts` | `tests/unit/security/rbac.test.ts`, `tests/security/authorization.test.ts` |
| Resource-level task visibility (404 for foreign tasks, SSE included, re-validated every 60 s) | `findVisible`, `apps/api/src/sse/stream.ts` | `tests/security/authorization.test.ts`, `tests/api/sse.test.ts` |

## Input validation and injection (§2.3, §10, §11)

| Control | Implementation | Proof |
|---|---|---|
| No shell: every process is `spawn(cmd, argv, {shell:false})` through `@orc/shared/node` | `packages/shared/src/node/process.ts` | `tests/security/command-injection.test.ts` (static scan + literal argv run) |
| Git refs and shas validated; `--end-of-options` before user refs | `isSafeRefName`, `isCommitSha`, `packages/git-manager/src/argv.ts` | `tests/unit/security/argv.test.ts`, `tests/security/command-injection.test.ts` (real git) |
| Test command argv without shell, bounded | `validateTestCommand` | `tests/security/command-injection.test.ts` |
| argv size/NUL limits (Windows command-line limit included) | `assertSafeArgv` | `tests/unit/security/argv.test.ts`, `tests/security/command-injection.test.ts` |
| Agent tool-rule vocabulary; Bash rules admin-only from a fixed command list | `validateAgentToolRules` | `tests/unit/security/tool-policy.test.ts`, `tests/security/command-injection.test.ts` (API) |
| Task prompt reaches Claude on stdin only | `buildClaudeArgv`, `buildLayeredPrompt` | `tests/security/command-injection.test.ts` |
| Task text limits (chars, UTF-8 bytes), whitespace-only refused | `CreateTaskRequestSchema`, `TaskService.create` | `tests/security/prompt-limits.test.ts` |
| Untrusted text sanitised (C0 controls, CRLF, `<<<ORC:` removed), nonce-fenced DATA blocks, prompt budget | `sanitizeUntrustedText`, `buildLayeredPrompt` | `tests/unit/security/prompt.test.ts`, `tests/unit/claude-runner/prompt.test.ts`, `tests/security/prompt-limits.test.ts` |
| Zod validation of every external input (HTTP, env, jobs, stream-json, runner frames) | `packages/shared/src/schemas`, `@orc/sandbox` protocol | API/unit suites |
| Parameterised SQL only | `packages/database` | code rule (CLAUDE.md), `tests/integration/database/*` |

## Paths and workspace isolation (§2.3, §10.4, §10.11, §11)

| Control | Implementation | Proof |
|---|---|---|
| `resolveWithin` / `realpathWithin` on every user/DB path (NUL, absolute, `..`, symlink/junction, case-insensitive on win32) | `packages/security/src/paths.ts` | `tests/unit/security/paths.test.ts`, `tests/security/path-traversal.test.ts` |
| Repository path and JUnit path normalisation | `normalizeRepoRelativePath`, `normalizeWorktreeRelativePath` | `tests/security/path-traversal.test.ts` |
| Worktree paths only `<project>/<task>/a<n>` / `_base`; removal confined | `parseWorktreeRelPath` (git-manager) | `tests/security/path-traversal.test.ts` |
| Source repositories read-only; worktrees from a bare mirror | compose `projects:ro` (worker only), git-manager | `tests/security/workspace-isolation.test.ts`, `tests/security/container-config.test.ts` |
| Worktree-scoped allow rules, platform deny rules, `dontAsk` | `computeToolPolicy`, `PLATFORM_DISALLOWED_RULES` | `tests/unit/security/tool-policy.test.ts`, `tests/security/workspace-isolation.test.ts`, release gate `test:claude-live -- permission-boundary` |
| Fail-closed `init` validation (permission mode, tools, MCP servers, cwd, hooks) | `validateInit` (claude-runner) | `tests/unit/claude-runner/validate-init.test.ts` |
| Per-workspace Claude home/config and MCP cache, `CBM_ALLOWED_ROOT` = worktree | `buildClaudeEnv`, orchestrator | `tests/security/claude-env.test.ts`, `tests/security/workspace-isolation.test.ts` |
| Runner leases: `realpathWithin` against the three roots, no overlap, cwd inside the lease, env allowlist per kind | `@orc/sandbox` validation | `tests/unit/sandbox/validation.test.ts`, `tests/security/sandbox-escape.test.ts` |
| Per-lease uid, 0700 hand-off, prlimit (nproc, nofile, fsize, core) | `@orc/sandbox` lease manager, `apps/runner` | `tests/integration/sandbox/protocol.test.ts` (POSIX), `npm run test:compose` |

## Secrets and masking (§17)

| Control | Implementation | Proof |
|---|---|---|
| Secrets only as files (`*_FILE`), only where needed; sa only in `mssql` + `db-bootstrap`; runner none | `docker-compose.yml`, config loaders | `tests/security/container-config.test.ts`, `tests/security/sandbox-escape.test.ts` |
| Child environments from allowlists only | `buildChildEnv`, `CLAUDE/GIT/TEST_ENV_ALLOWLIST`, `allowedEnvKeys` | `tests/security/claude-env.test.ts`, `tests/unit/claude-runner/env.test.ts` |
| SecretRegistry + `SECRET_VALUE_PATTERNS` masking, linear time | `maskText` (`packages/security/src/masking.ts`) | `tests/unit/security/masking.test.ts`, `tests/unit/security/masking-linear.test.ts` |
| Chunk-safe stream masking (split secrets, held key blocks, bounded tail) | `createStreamMasker` | `tests/unit/security/stream-masker.test.ts`, `tests/unit/security/masking-linear.test.ts` |
| Masked logs (pino redact paths + registry) | `packages/logger` | `tests/security/secret-masking.test.ts` |
| Masked TaskLogs, Redis task stream (SSE source), session results | orchestrator log sink, claude-runner | `tests/security/secret-masking.test.ts` (worker pipeline) |
| Problem Details: 5xx without internal detail, no query string echo | `apps/api/src/problem.ts` | `tests/security/secret-masking.test.ts` |
| Audit before/after JSON through `maskObject` | `packages/database/src/repositories/common.ts` | `tests/security/secret-masking.test.ts`, `tests/security/audit.test.ts` |

## Audit (§15.6)

| Control | Implementation | Proof |
|---|---|---|
| Audit rows for auth events, denials and state changes | `apps/api/src/audit.ts`, `TaskStateStore` | `tests/security/audit.test.ts`, `tests/integration/database/transition-audit.test.ts` |
| Append-only for application logins | GRANT matrix (migrations) | `tests/security/audit.test.ts`, `tests/integration/database/least-privilege.test.ts` |
| No credentials in audit (password, hashes, tokens, CSRF) | API audit builders, `maskObject` | `tests/security/audit.test.ts` |

## Database (§4)

| Control | Implementation | Proof |
|---|---|---|
| Least-privilege logins (no sysadmin/db_owner, no DDL, worker cannot read identity tables) | migrations / `orc-db bootstrap` | `tests/integration/database/least-privilege.test.ts`, `tests/security/db-separation.test.ts` |
| Production/test DB separation (`_test` guard, loopback-only test infra) | `assertDbNameForEnv`, `tests/setup/test-env.ts` | `tests/security/db-separation.test.ts`, `tests/unit/shared/*` |
| TLS to MSSQL with private CA in production | compose env, ADR-0026 | `tests/security/container-config.test.ts` (env), `scripts/compose-check.mjs` |

## Containers and network (§19, ADR-0024)

| Control | Implementation | Proof |
|---|---|---|
| Non-root users (images `USER node`/`101`/`mssql`, compose `user:`), runner the single root exception | `docker/Dockerfile`, `docker-compose.yml` | `tests/security/container-config.test.ts`, `npm run test:compose` |
| `cap_drop: [ALL]`, `no-new-privileges`, `read_only`, tmpfs `/tmp`, `init`, resource limits | `docker-compose.yml` (`x-hardening`) | `tests/security/container-config.test.ts` |
| No Docker socket, `~/.ssh`, host root, host namespaces, devices, privileged mode (all compose files) | compose files | `tests/security/container-config.test.ts` |
| Internal networks; only egress-proxy reaches the internet; worker/api never on sandbox/egress; runner never on backend | `docker-compose.yml` | `tests/security/container-config.test.ts`, `tests/security/sandbox-escape.test.ts` |
| Egress allowlist `api.anthropic.com:443` with token, private IPs denied | `apps/egress-proxy` | egress-proxy unit/integration suites, `npm run test:compose` |

## Supply chain and code hygiene

| Control | Implementation | Proof |
|---|---|---|
| Dependency audit, zero critical findings; network error = exit 3, never a pass | `scripts/dependency-audit.mjs` (ADR-0027) | `npm run audit:deps`, `npm run test:security`, `tests/security/quality-scripts.test.ts` |
| No TODO/FIXME/XXX/placeholder/not-implemented in production sources | `scripts/check-placeholders.mjs` | `npm run test:security`, `tests/security/quality-scripts.test.ts` |
| Dependency rules (contract §1.2) | `tests/unit/architecture/dependency-rules.test.ts` | unit project |
