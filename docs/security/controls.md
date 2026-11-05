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
| Fail-closed `init` validation (permission mode, MCP servers, cwd, session id; the ADR-0036 rules are listed under "Claude authentication and credentials") | `validateInit` (claude-runner) | `tests/unit/claude-runner/validate-init.test.ts` |
| Per-workspace Claude home/config and MCP cache, `CBM_ALLOWED_ROOT` = worktree | `buildClaudeEnv`, orchestrator | `tests/security/claude-env.test.ts`, `tests/security/workspace-isolation.test.ts` |
| Runner leases: `realpathWithin` against the three roots, no overlap, cwd inside the lease, env allowlist per kind | `@orc/sandbox` validation | `tests/unit/sandbox/validation.test.ts`, `tests/security/sandbox-escape.test.ts` |
| Per-lease uid, 0700 hand-off, prlimit (nproc, nofile, fsize, core) | `@orc/sandbox` lease manager, `apps/runner` | `tests/integration/sandbox/protocol.test.ts` (POSIX), `npm run test:compose` |

## Secrets and masking (§17)

| Control | Implementation | Proof |
|---|---|---|
| Secrets only as files (`*_FILE`), only where needed; sa only in `mssql` + `db-bootstrap`; `claude_oauth_token` and `anthropic_api_key` only in `worker`; runner none | `docker-compose.yml`, config loaders | `tests/security/container-config.test.ts`, `tests/security/sandbox-escape.test.ts`, `tests/unit/shared/config.test.ts` |
| Child environments from allowlists only | `buildChildEnv`, `CLAUDE/GIT/TEST_ENV_ALLOWLIST`, `allowedEnvKeys` | `tests/security/claude-env.test.ts`, `tests/unit/claude-runner/env.test.ts` |
| SecretRegistry + `SECRET_VALUE_PATTERNS` masking, linear time | `maskText` (`packages/security/src/masking.ts`) | `tests/unit/security/masking.test.ts`, `tests/unit/security/masking-linear.test.ts` |
| Chunk-safe stream masking (split secrets, held key blocks, bounded tail) | `createStreamMasker` | `tests/unit/security/stream-masker.test.ts`, `tests/unit/security/masking-linear.test.ts` |
| Masked logs (pino redact paths + registry) | `packages/logger` | `tests/security/secret-masking.test.ts` |
| Masked TaskLogs, Redis task stream (SSE source), session results | orchestrator log sink, claude-runner | `tests/security/secret-masking.test.ts` (worker pipeline) |
| Problem Details: 5xx without internal detail, no query string echo | `apps/api/src/problem.ts` | `tests/security/secret-masking.test.ts` |
| Audit before/after JSON through `maskObject` | `packages/database/src/repositories/common.ts` | `tests/security/secret-masking.test.ts`, `tests/security/audit.test.ts` |

## Claude authentication and credentials (§10.2, §10.3, §10.6, §10.9, §10.11, §17.2; ADR-0036, ADR-0037)

Threats: threat-model.md §3.1, TB5, TB8, TB11 and R11-R16. The single-credential rule is enforced in five independent layers; any layer alone refuses two credentials.

| Control | Implementation | Proof |
|---|---|---|
| Single credential, layer 1 (config): explicit `CLAUDE_AUTH_MODE` (default `oauth`); oauth needs a token matching `CLAUDE_OAUTH_TOKEN_REGEX` and refuses a set `ANTHROPIC_API_KEY`; api_key refuses a set OAuth token and a key starting with `sk-ant-oat`; `CLAUDE_BARE` is a ConfigError; messages name keys, never values | `WorkerConfigSchema`, `loadWorkerConfig` (`packages/shared/src/node/config.ts`) | `tests/unit/shared/config.test.ts`, `tests/security/claude-credential-leak.test.ts` (ConfigError messages and details) |
| Single credential, layer 2 (deployment): exactly one non-empty credential file, matching the rendered mode and format; `generate-secrets` refuses to write one credential while the other is non-empty and never echoes a value | `scripts/lib/claude-credentials.mjs` (regex copied from `@orc/shared`), `scripts/compose-check.mjs`, `scripts/generate-secrets.mjs` | `tests/unit/scripts/claude-credentials.test.ts`, `tests/unit/scripts/generate-secrets.test.ts` |
| Single credential, layer 3 (env builder): `buildClaudeCredentialEnv` emits one credential per mode and platform; `buildChildEnv` and `assertSingleClaudeCredential` refuse two credentials and the never-set keys (`CLAUDE_CODE_SIMPLE`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`) | `packages/security/src/env.ts`, `buildClaudeLaunchEnv` (`packages/claude-runner/src/env.ts`) | `tests/unit/security/env.test.ts`, `tests/unit/claude-runner/env.test.ts`, `tests/security/claude-env.test.ts` |
| Single credential, layer 4 (launcher): `validateSpawnEnv` rejects an env with `ANTHROPIC_API_KEY` plus any `CLAUDE_CODE_OAUTH_TOKEN*`, both OAuth variables, or a never-set key (`env_rejected`, no value echoed); runner and local launcher | `packages/sandbox/src/validation.ts`, `packages/sandbox/src/local.ts` | `tests/unit/sandbox/validation.test.ts`, `tests/unit/sandbox/credential-fd.test.ts`, `tests/integration/sandbox/protocol.test.ts`, `tests/security/claude-credential-leak.test.ts` (Linux: nothing spawned, no process holds the value) |
| Single credential, layer 5 (CLI): `validateInit` rule `auth_source` (`apiKeySource` = `none` in oauth mode, `ANTHROPIC_API_KEY` in api_key mode) catches an `apiKeyHelper` or stray key | `packages/claude-runner/src/init-validation.ts` | `tests/unit/claude-runner/validate-init.test.ts`, `tests/integration/claude-runner/init-validation.test.ts` |
| Hardened argv, identical in both auth modes: `--include-hook-events --restricted --setting-sources user --settings <CLAUDE_HARDENED_SETTINGS>` (frozen JSON passed inline, never a file), then §10.2 rows 8-18; `--bare`, `--safe-mode` never; `mcp === null` drops `--mcp-config` but keeps `--strict-mcp-config`; the probe requires the hardened flags | `buildClaudeArgv` (`packages/claude-runner/src/argv.ts`), `packages/claude-runner/src/constants.ts`, `packages/claude-runner/src/probe.ts` | `tests/unit/claude-runner/argv.test.ts`, `tests/unit/claude-runner/probe.test.ts`, release gate `test:claude-live -- probe-init` |
| Fixed and forbidden Claude env: `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` on every Claude spawn and the probe; probe env without any credential variable or fd 3 | `CLAUDE_FIXED_ENV`, `CLAUDE_NEVER_ENV`, `assertNoClaudeCredential` (`packages/security/src/env.ts`) | `tests/unit/security/env.test.ts`, `tests/unit/claude-runner/env.test.ts` |
| `validateInit` ADR-0036 rules (fail-closed, forced kill, `security_violation`): `tool` (every init tool allowed), `tool_missing` (every requested builtin present, B-019), `extension` (skills, agents, slash commands, plugins against `CLAUDE_REVIEWED_EXTENSIONS` keyed `<cliVersion>/<platform>/<authMode>`; missing entry, unparsable field and an init version other than the probed one fail), `memory` (`memory_paths` absent, null or empty), `auth_source` (layer 5 above) | `validateInit`, `CLAUDE_REVIEWED_EXTENSIONS` (`packages/claude-runner/src/init-validation.ts`, `packages/claude-runner/src/constants.ts`) | `tests/unit/claude-runner/validate-init.test.ts`, `tests/unit/claude-runner/run.test.ts`, `tests/integration/claude-runner/init-validation.test.ts`, release gate `test:claude-live -- probe-init` |
| `validateInit` rule `hook_event`: any `system` line whose subtype starts with `hook_`, at any time and in both modes | `packages/claude-runner/src/run.ts` | `tests/unit/claude-runner/run.test.ts`, `tests/integration/claude-runner/init-validation.test.ts` |
| `credentialFd` only for kind `claude`: only with `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`, the fd variable never without a credential, 1..4096 bytes, no NUL, UTF-8 round trip of the `{b64}` frame; the client refuses a misrouted credential; `spawnSupervised` writes fd 3 and ends the pipe, and refuses `credentialFd` on win32 | `validateSpawnCredential`, `encodeCredentialFd`, `decodeCredentialFd` (`packages/sandbox/src/validation.ts`), `packages/sandbox/src/protocol.ts`, `packages/sandbox/src/server.ts`, `packages/sandbox/src/local.ts`, `spawnSupervised` (`packages/shared/src/node/process.ts`) | `tests/unit/sandbox/credential-fd.test.ts`, `tests/unit/sandbox/validation.test.ts`, `tests/unit/shared/process.test.ts`, `tests/integration/sandbox/protocol.test.ts`, `tests/integration/claude-runner/run.test.ts` (credential transport), `tests/security/claude-credential-leak.test.ts` (refused frames: protocol error frames of 31 malformed, oversized or misrouted `spawn` cases never echo the token or its base64; lease state files and `recoverStale` after a runner crash keep no credential on disk; Linux: a `/proc` scan finds the value in no environ or fd of Claude and its children), release gate `test:claude-live -- credential-leak` |
| Credential log redaction: `sk-ant-oat…` values and their base64 and base64url encodings at byte offsets 0, 1 and 2, without a registry, in messages, fields, child bindings, error messages and stacks; keys `CLAUDE_CODE_OAUTH_TOKEN*` at any depth, `credentialFd` / `credentialB64` fields; the runner takes `credentialFd` out of the request before further handling; the token is registered with the SecretRegistry, which adds encoded variants | `maskSecretText` (`packages/logger/src/oauth-mask.ts`), `packages/logger/src/logger.ts`, `packages/logger/src/serialize-error.ts`, `packages/security/src/masking.ts`, `packages/sandbox/src/server.ts`, `packages/claude-runner/src/runner.ts` | `tests/unit/logger/logger.test.ts`, `tests/security/claude-credential-leak.test.ts` (runner logger without registry, worker logger with registry), `tests/unit/claude-runner/env.test.ts` (registration), `tests/unit/sandbox/credential-fd.test.ts` (env and logs never carry it), `tests/integration/sandbox/protocol.test.ts` |
| Yama `ptrace_scope` check: runner start refused in production when the value is missing, unparsable or 0 (warning in development/test); local mode on Linux: one worker warning `ptrace_scope_unprotected` | `assessPtraceScope` (`apps/runner/src/runtime.ts`), `claudeStartupWarnings` (`apps/worker/src/config.ts`) | `tests/unit/runner/ptrace-scope.test.ts`, `tests/unit/worker/config.test.ts` |
| api_key mode "not recommended": one startup warning `claude_api_key_mode` | `claudeStartupWarnings` (`apps/worker/src/config.ts`) | `tests/unit/worker/config.test.ts` |
| `claudeEnvScrub` (api_key mode only): Claude's `mcp.json` gives the codebase-memory-mcp server `ANTHROPIC_API_KEY: ""`; Zod allows only that name | `McpManagerConfig.claudeEnvScrub` (`packages/mcp-manager/src/manager.ts`, `packages/mcp-manager/src/types.ts`), worker mapping (`apps/worker/src/config.ts`) | `tests/unit/mcp-manager/manager.test.ts`, `tests/unit/worker/config.test.ts`, release gate `test:claude-live -- credential-leak` (api_key mode) |
| B-020 isolated AppData (win32): Claude and the probe get `APPDATA` / `LOCALAPPDATA` below the per-workspace `HOME` (probe: below its own directory); the directories inherit the parent's ACL, since the 0700 mode has no effect on win32 (known-issues KI-007); test, MCP and git spawns unchanged (known-issues KI-002) | `buildClaudeAppDataEnv` (`packages/security/src/env.ts`), `ensureClaudeAppDataDirs` (`packages/orchestrator/src/claude-home.ts`), `packages/claude-runner/src/probe.ts` | `tests/unit/security/env.test.ts`, `tests/unit/claude-runner/env.test.ts`, `tests/unit/orchestrator/claude-home.test.ts` |
| B-015 `ensureClaudeMcpRuntime` before every Claude spawn: local mode runs `prepareLocalRuntimeDir` (runtime dir: directory, not a symlink, owned by the process uid, `mode & 0o077 = 0`; POSIX `os.tmpdir()`: directory, not a symlink, owned by root or the process uid, sticky or not other-writable); runner mode is a no-op (leased paths) | `packages/mcp-manager/src/manager.ts` | `tests/unit/mcp-manager/manager.test.ts` |
| B-015 per-task decision: on failure, `MCP_REQUIRED` or `requireIndex` fails the attempt (`security_violation` for `path_escape`, else `workspace_error`); otherwise a `mcp_runtime_rejected` warning and Claude without `--mcp-config` (tool policy, prompt index and request use `mcpEnabled && mcpRuntimeOk`) | `mcpRuntimeDecision` (`packages/orchestrator/src/mcp-runtime.ts`), `mcpRuntimeStage` (`packages/orchestrator/src/pipeline.ts`) | `tests/unit/orchestrator/mcp-runtime.test.ts`, `tests/integration/worker/pipeline.test.ts`, `tests/unit/claude-runner/argv.test.ts` (`mcp === null`) |
| Auth failure without retry storm: a 401 or "Not logged in" ends the attempt once, the job is not re-enqueued | worker pipeline outcome (ADR-0036 Decision 10) | `tests/integration/worker/auth-failure.test.ts` |

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
