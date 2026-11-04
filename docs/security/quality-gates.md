# Security quality gates

Requirements §15 gates → proving test or command (contract §18.5) → result of the last verification run. The `security` Vitest project (`tests/security/**`, MSSQL test + Redis test) and the two script gates run with:

```
npm run test:security   # vitest --project security && check-placeholders && dependency-audit
npm run audit:deps      # dependency audit only (ADR-0027)
```

Gates that need the running compose stack (dynamic sandbox probes, `id -u` inside containers) run in `npm run test:compose`; the real-CLI permission boundary is the release gate `npm run test:claude-live -- permission-boundary`. Neither is part of the standard local suites.

Last verification: 2026-11-03, Windows 11 dev host, Node 24.18.0, test infrastructure `docker-compose.test.yml` (MSSQL 127.0.0.1:14331, Redis 127.0.0.1:16380).

| # | Gate (requirements §15) | Proof | Result |
|---|---|---|---|
| 1 | Command injection | `tests/security/command-injection.test.ts`: static scan (only `spawn` from child_process, no `shell: true`, no `exec*`/`spawnSync`/`eval`), literal argv run of shell payloads, prompt only on stdin, validators (`isSafeRefName`, `validateTestCommand`, `validateAgentToolRules`, `assertSafeArgv`), real git with hostile refs, API (`baseRef`, test command, default branch, agent tool rules, diff `path`) | PASS (security project 248/248) |
| 2 | Path traversal | `tests/security/path-traversal.test.ts`: `resolveWithin`/`realpathWithin` vectors incl. symlink/junction escape and win32 case, repoPath/JUnit path normalisation, git-manager `validateSource`/`syncMirror` link escape, `removeWorktree` confinement, API repoPath/junitReportPath/route ids | PASS (security project 248/248) |
| 3 | Workspace isolation | `tests/security/workspace-isolation.test.ts` (two tasks through the real worker with fake-claude: own worktree, cwd, worktree-scoped allow rules, platform deny rules, per-attempt MCP config, env names, source repository unchanged) + `tests/security/sandbox-escape.test.ts` (runner static checks, lease/cwd/env validation) + `npm run test:compose` (dynamic) + release gate `test:claude-live -- permission-boundary` | PASS (security project 248/248) |
| 4 | Worker runs non-root | `tests/security/container-config.test.ts` (Dockerfile stages `USER node`/`101`/`mssql`, compose `user:`, runner `0:0` the only exception with exactly 6 caps, `cap_drop: [ALL]`, `no-new-privileges`, `read_only`) + `npm run test:compose` (`id -u` = 1000) | PASS (static); dynamic part in test:compose |
| 5 | Docker socket not mounted | `tests/security/container-config.test.ts` (every compose file) | PASS (security project 248/248) |
| 6 | SSH directory not mounted | `tests/security/container-config.test.ts` (every compose file; also no host root, `/proc`, `/etc`, home) | PASS (security project 248/248) |
| 7 | Secret masking | `tests/unit/security/masking.test.ts`, `stream-masker.test.ts`, `masking-linear.test.ts` (linear time: 1 MiB line < 1 s; differential fuzz vs the regex reference), `tests/security/secret-masking.test.ts` (logs, Problem Details, audit JSON, worker pipeline TaskLogs + Redis task stream + session result) | PASS (unit security 350/351 incl. masking-linear; security project 248/248) |
| 8 | MSSQL least privilege | `tests/integration/database/least-privilege.test.ts` (full GRANT matrix, integration project) + `tests/security/db-separation.test.ts` (live probes: no sysadmin/db_owner/ddladmin, DDL denied, worker cannot read identity tables) + `tests/security/audit.test.ts` (audit append-only) | PASS (security project; integration gate owned by Database team) |
| 9 | Production and test DB separated | `tests/security/db-separation.test.ts` (`assertDbNameForEnv`, config loaders, loopback-only infra guard, connected DB is `orchestrator_test`) | PASS (security project 248/248) |
| 10 | Cancel leaves no orphan | `tests/integration/claude-runner/kill.test.ts` ("cancel mid-run => cancelled, no orphans": CLI and grandchild gone), `tests/integration/worker/pipeline.test.ts` ("cancels a running task: cancelled, no surviving processes"), `tests/e2e/cancel.test.ts` (HTTP cancel, stream ends, no orphan processes), `tests/integration/claude-runner/probe-orphans.test.ts` (Linux-only parts skipped on win32); Worker Platform owns the suites | PASS: 5 files, 22 passed, 2 skipped (Linux-only), re-run 2026-11-03 by Security |
| 11 | Timeout leaves no orphan | `tests/integration/claude-runner/kill.test.ts` ("deadline => timeout: the CLI and its grandchild are killed, no survivors"), `tests/integration/worker/pipeline.test.ts` ("times out at the attempt deadline: timed_out and no surviving processes"), `tests/e2e/timeout.test.ts` | PASS (same run as 10) |
| 12 | SSE authorization | `tests/security/authorization.test.ts` (anonymous 401, other operator 404 by session and PAT, owner/auditor/admin 200, unknown id indistinguishable) + `tests/api/sse.test.ts` (revoked session ends the stream) | PASS (security project 248/248) |
| 13 | A user cannot see another user's task | `tests/security/authorization.test.ts` (list, get, logs, events, attempts, tests, results, changed-files, diff, patch, merge-check, session, impact, stream, cancel, retry => 404, nothing changed; auditor read-only; read-only PATs; PATs never manage tokens/users) | PASS (security project 248/248) |
| 14 | Audit records created | `tests/security/audit.test.ts` (auth.login success/failure, logout, token created/revoked, csrf_rejected, authz.denied, task.created/cancel, project.created/updated before/after, user.created without credentials, UPDATE/DELETE denied) + `tests/integration/database/transition-audit.test.ts` | PASS (security project 248/248) |
| 15 | Dependency scan without critical findings | `node scripts/dependency-audit.mjs` (`npm audit --omit=dev --json --audit-level=critical`; exit 1 critical, exit 3 unavailable) in `test:security`; decision logic on saved reports and a live run against an unreachable loopback registry (exit 3) in `tests/security/quality-scripts.test.ts` | PASS: 0 critical, 0 high, 0 moderate, 0 low (654 deps, 261 prod) |
| + | No placeholders in production (requirements §16) | `node scripts/check-placeholders.mjs` in `test:security`; `tests/security/quality-scripts.test.ts` | PASS: 242 files, 0 findings |
| + | Claude env allowlist / argv | `tests/security/claude-env.test.ts`, `tests/security/workspace-isolation.test.ts` | PASS (security project 248/248) |
| + | Prompt size and control characters (requirements §5.8) | `tests/security/prompt-limits.test.ts` | PASS (security project 248/248) |

## Notes

- `maskText` and `createStreamMasker` were quadratic on long separator-free lines (64 KiB of `x`: 4 s / 9 s, event loop blocked). Both are linear now; the regression test masks 1 MiB adversarial lines (11 shapes) and streams 1 MiB in 7-byte chunks well under 1 s. Measured on the dev host: 1 MiB `x` line 4 ms (`maskText`), 8 ms (stream, 4 KiB chunks), 31 ms (stream, 7-byte chunks).
- The stream masker now also holds a private-key block whose END marker arrives before the newline of its line (previously that block could be released up to the preceding line without its END line).
