# Threat model

Scope: the production topology of `docker-compose.yml` (contract §19), the trust model of the execution sandbox (contract §10.11, ADR-0024) and the data flows of contract §§7-17. Controls are listed in [controls.md](controls.md); the proof of each requirements §15 gate is in [quality-gates.md](quality-gates.md).

Method: assets → trust boundaries → STRIDE per boundary → residual risks. Re-review this document whenever a service, network, volume, secret, Claude CLI flag or tool rule changes. Run the "Image CVE review" in `docs/operations/runbook.md` before each release as well.

## 1. Assets

| # | Asset | Where it lives | Why it matters |
|---|---|---|---|
| A1 | Source code of the managed projects | `PROJECTS_ROOT` (host directory, mounted read-only into the worker only) | Confidentiality and integrity of customer code. The platform must never write to it. |
| A2 | Attempt worktrees, bare mirrors, base snapshots | volume `workspaces` (`.repos/`, `<project>/<task>/a<n>/`) | Each task's work in progress. Must be isolated per task. |
| A3 | Claude homes/transcripts, MCP index caches | volumes `claude-home`, `cbm-cache` (per workspace) | They may contain code excerpts and prompts of other tasks. |
| A4 | Database: users, password hashes, sessions, PATs, tasks, logs, audit | `mssql` (`orchestrator`), volume `mssql-data` | Authentication and the record of who did what. |
| A5 | Secrets: sa / service login passwords, Redis password, `ANTHROPIC_API_KEY`, egress proxy token, TLS keys | `./secrets/*` → compose `secrets:` (`/run/secrets/*`) | They give access to A1-A4 or to the paid Anthropic account. |
| A6 | Queue state, live task streams | `redis` (volume `redis-data`) | Integrity of scheduling; live output can contain code. |
| A7 | Audit log | `orc.AuditLogs` (append-only for app logins) | Accountability and incident forensics. |
| A8 | The host | Docker engine, host filesystem, `~/.ssh`, Docker socket | Full compromise if reached. |

## 2. Actors

- **Operator / admin / auditor** (authenticated users, contract §15.1). Operators are trusted with their own tasks only; admins configure projects, agents and tool rules; auditors read.
- **Anonymous network client** reaching `web` (8443/8088 on `WEB_BIND_ADDRESS`, loopback by default).
- **Untrusted execution**: the Claude CLI with its tool children, every codebase-memory-mcp server and the project test command. They interpret repository-controlled content (CLAUDE.md, package scripts, test code, tool configs) and model output, so they are treated as attacker-controlled (contract §10.11 trust model).
- **Repository content** itself (a malicious commit, a hostile CLAUDE.md, symlinks, git hooks/filters/attributes).
- **Anthropic API** (external; reached only through the egress proxy).

## 3. Trust boundaries

```
 browser ──TLS──▶ web (nginx, uid 101) ──frontend──▶ api (uid 1000)
                                                     │ backend (internal)
                                     mssql ◀─────────┼─────────▶ redis
                                                     │
                                         worker (uid 1000, git only; projects:ro)
                                                     │ Unix socket (runner-sock, 0660 root:1000)
                                                     ▼
                                  runner launcher (root, 6 caps, sandbox net)
                                    └─ untrusted children (uid 20000+n, 0 caps, prlimit)
                                                     │ sandbox (internal)
                                                     ▼
                                     egress-proxy (uid 1000) ──egress──▶ api.anthropic.com:443
```

| ID | Boundary | Crossing data | Enforcement point |
|---|---|---|---|
| TB1 | Internet/LAN → `web` | HTTPS requests | nginx TLS, loopback bind by default, HSTS |
| TB2 | `web` → `api` | HTTP API, SSE | session/PAT auth, CSRF, Origin check, RBAC, Zod validation, rate limits |
| TB3 | `api`/`worker` → `mssql`/`redis` | SQL, Redis commands | least-privilege logins, parameterised SQL only, TLS to MSSQL, Redis password |
| TB4 | `worker` → git / source repositories | git argv, repository content | `spawn` argv arrays, `--end-of-options`, hardened git config (empty hooks dir, `GIT_CONFIG_GLOBAL=/dev/null`), `projects` mounted read-only, `resolveWithin`/`realpathWithin` |
| TB5 | `worker` → `runner` (Unix socket) | lease and spawn requests (NDJSON, Zod) | socket mode 0660 root:1000, schema validation, `realpathWithin` on lease paths, env allowlist per kind, `assertSafeArgv` |
| TB6 | **runner sandbox**: launcher → untrusted children | process start with uid/gid of the lease | per-lease uid without capabilities, 0700 paths handed to that uid only, prlimit, no secrets, no backend network |
| TB7 | Untrusted children → network | HTTPS to Anthropic | `sandbox` network is internal; only `egress-proxy` routes out, only `CONNECT api.anthropic.com:443` with a token that only `claude` processes receive |
| TB8 | Claude CLI → files and tools | tool calls | `--permission-mode dontAsk`, worktree-scoped allow rules, platform deny rules, fail-closed `init` validation (§10.6) |
| TB9 | Process output → storage, SSE, logs | stdout/stderr, stream-json | `createStreamMasker`/`maskText` before TaskLogs, Redis stream and logs; `maskObject` for audit JSON |
| TB10 | Containers → host | volumes, capabilities, namespaces | no Docker socket, no `~/.ssh`, no host root, `cap_drop: [ALL]`, `no-new-privileges`, `read_only`, non-root users, resource limits |

## 4. STRIDE

| Threat | Boundary | Scenario | Mitigation (see controls.md) | Residual |
|---|---|---|---|---|
| **S**poofing | TB2 | Stolen session cookie or PAT reused | `__Host-` cookie, HttpOnly, SameSite=Strict, Secure; idle/absolute TTL; SHA-256 stored tokens; revocation on password change/disable; PAT scopes (read-only, no token/user management) | A stolen live cookie works until expiry or logout |
| Spoofing | TB2 | Password guessing | scrypt (N=2^17), per-IP and per-username throttling, lockout, constant-cost dummy verify | Low |
| Spoofing | TB5 | A sandboxed process connects to the runner socket to start processes as another lease | socket `0660 root:1000`; sandbox uids are not in group 1000 | None known |
| Spoofing | TB7 | Untrusted test/MCP process uses the egress proxy | proxy demands `Proxy-Authorization` (407 otherwise); token only in the env of `claude` processes | Bash children of Claude inherit it (ratified, ADR-0024) |
| **T**ampering | TB4 | Task writes to the real repository | `projects` mounted read-only into the worker only; worktrees are created from a bare mirror; source hash checked by tests | None known |
| Tampering | TB4 | Repository-controlled git hooks, filters, `core.fsmonitor`, attributes execute code in the worker | image-owned empty `core.hooksPath`, `GIT_CONFIG_GLOBAL=/dev/null`, hardened `-c` options (contract §11.3); worker runs only git | Depends on git hardening options staying complete (tests in git-manager isolation suite) |
| Tampering | TB8 | Claude edits outside its worktree (siblings, mirror, `.git`) | worktree-scoped allow rules + deny rules; per-lease uid with 0700 dirs (production) | Real-CLI rule semantics are proven only by the release gate `test:claude-live -- permission-boundary` |
| Tampering | TB2 | CSRF on state-changing endpoints | `X-CSRF-Token` equals session token (timing-safe), Origin must equal `PUBLIC_ORIGIN` | None known |
| Tampering | TB3 | SQL injection | parameterised `mssql` inputs only (lint + review rule), DDL denied to app logins | None known |
| **R**epudiation | TB2/TB9 | A user denies having cancelled/created a task | `AuditLogs` row per state change and auth event with actor, IP, request id; app logins cannot UPDATE/DELETE audit | Audit retention purge is an explicit db-cli action (`maintenance.audit_purged`) |
| **I**nformation disclosure | TB2 | Operator reads/streams another operator's task | resource-level visibility (`findVisible`), 404 for invisible tasks on every endpoint incl. SSE (re-validated every 60 s) | None known |
| Information disclosure | TB9 | Secrets appear in logs, TaskLogs, SSE, Problem Details, audit JSON | SecretRegistry + `SECRET_VALUE_PATTERNS` (linear-time), chunk-safe stream masker, pino redact paths, 5xx details never exposed | Secrets in shapes no pattern knows and not registered (e.g. a third-party token in a repository file) are not masked |
| Information disclosure | TB6 | Untrusted code reads `/run/secrets`, other worktrees, transcripts or indexes | runner has no compose secrets; lease paths owned by the lease uid with 0700; parents 0711 (cbm-cache `{p,w}` parents `root:<WORKER_GID>` 1775: listable, not writable, ADR-0034) | Command lines of other leases are visible in `/proc` (argv carries no secrets) |
| Information disclosure | TB7 | Exfiltration of code to arbitrary hosts | internal networks; proxy allowlist `api.anthropic.com:443`, private IPs denied | Exfiltration to the Anthropic API itself (by design the model sees the code) |
| Information disclosure | TB4 | Path traversal (`../`, absolute, NUL, symlink/junction) in repoPath, JUnit path, CLAUDE.md, workspace removal, API params | `resolveWithin`/`realpathWithin`, `normalizeRepoRelativePath`, `normalizeWorktreeRelativePath`, GUID-only route ids, `parseWorktreeRelPath` | None known |
| **D**enial of service | TB2 | Huge prompts, request floods | JSON body limit, `TASK_PROMPT_MAX_CHARS`, `TASK_TEXT_MAX_BYTES`, rate-limit classes, login throttling | Distributed floods need an upstream proxy |
| Denial of service | TB9 | Pathological output (one 64 KiB+ line without separators) stalls masking | `maskText` and the stream masker are linear-time (regression test: 1 MiB line < 1 s) | None known |
| Denial of service | TB6 | Fork bomb, disk fill, memory exhaustion by untrusted code | prlimit nproc/nofile/fsize/core, runner `pids_limit` 8192 and `mem_limit`, workspace quotas, output limit 50 MiB | OOM restart of the runner interrupts all running attempts (`worker_lost` recovery) |
| **E**levation of privilege | TB10 | Container escape via Docker socket, host mounts, capabilities | no socket, no host root/`.ssh`, `cap_drop: [ALL]`, `no-new-privileges`, `read_only`, non-root users | The runner launcher runs as root (see §5) |
| Elevation of privilege | TB8 | Prompt injection makes Claude run shell commands | `Bash` only with admin-enabled `Bash(<cmd>:*)` rules from a fixed vocabulary; deny list (`curl`, `ssh`, `git push`, ...); hostile text fenced in nonce DATA blocks, `<<<ORC:` removed | Agents with Bash rules execute repository scripts by design (still inside the sandbox) |
| Elevation of privilege | TB4/TB5 | Command injection via titles, prompts, refs, test commands, tool rules | no shell anywhere (`spawn(cmd, argv, {shell:false})`), validators (`isSafeRefName`, `validateTestCommand`, `validateAgentToolRules`, `assertSafeArgv`), prompt via stdin | None known |
| Elevation of privilege | TB3 | App login abused for DDL or reading other tables | per-service logins with GRANT matrix, no sysadmin/db_owner; sa only in `mssql` and `db-bootstrap` | `db-bootstrap` holds sa for its one-shot run |

## 5. Residual risks (accepted)

| ID | Risk | Rationale / compensating controls | Owner |
|---|---|---|---|
| R1 | **Root runner launcher** (`user: "0:0"`, caps SETUID, SETGID, CHOWN, FOWNER, DAC_READ_SEARCH, KILL). Ratified exception, ADR-0024. | Needed to run each lease under its own uid and to hand off/reclaim paths. The launcher executes no untrusted code; it accepts only Zod-validated frames over a 0660 root:1000 socket; children get zero capabilities (`spawn` with uid/gid, libuv drops supplementary groups); `no-new-privileges`, `read_only`, sandbox network only, no secrets, no projects mount. Statically enforced by `tests/security/container-config.test.ts` and `sandbox-escape.test.ts`. | Security + Worker Platform |
| R2 | Bash children of Claude inherit `ANTHROPIC_API_KEY` and proxy credentials. | Only for agents with admin-enabled Bash rules (audited `agent.updated`); no seeded agent has one. | Security |
| R3 | Command lines of other leases visible through `/proc` inside the runner. | argv never carries secrets (prompt on stdin, keys via env). | Worker Platform |
| R4 | Real-CLI permission semantics can change with a CLI version. | Release gate `npm run test:claude-live -- permission-boundary` and the frozen init tool list (§10.6) are re-run on every CLI bump. | QA |
| R5 | `SANDBOX_MODE=local` (development/test, incl. win32) has no OS isolation. | Refused when `NODE_ENV=production`. | Worker Platform |
| R6 | Unknown secret formats in repository content are not masked. | Registry covers all platform secrets; patterns cover common provider tokens. Operators must not store secrets in repositories. | Security |
| R7 | Dependency audit needs registry connectivity (ADR-0027). | Exit 3 "UNAVAILABLE - gate NOT passed" is never treated as a pass; image contents follow the runbook CVE review. | Platform |
| R8 | A stolen session cookie is valid until idle/absolute expiry. | HttpOnly/SameSite/Secure cookie, TLS, 2 h idle / 12 h absolute TTL, logout revokes. | Backend |
| R9 | Stream masker trade-offs: a single pattern match is never split, so an endless token-shaped run is held until it ends; the log sink force-flushes a partial line after `PARTIAL_LINE_MAX_AGE_MS` (2 s), and a private-key block that stays open beyond `maxHoldChars` (64 KiB) is released in pieces. A token suffix that arrives after such a flush, or the body of a > 64 KiB key block, is not recognised by any pattern. | Held text is bounded by the run's total output budget (`countOutput`) and the 2 s flush; real keys are < 4 KiB; registered platform secrets are matched by value regardless of shape. | Security |
| R10 | Untrusted code can enumerate project/workspace GUIDs that have an MCP cache; names are not secrets and grant no access (ADR-0034). | `<CBM_CACHE_DIR>` and `{p,w}` are root-owned 1775 anchors (listable, not writable by sandbox uids); each cache entry is 0700 of its owner uid. | Security + Worker Platform |
