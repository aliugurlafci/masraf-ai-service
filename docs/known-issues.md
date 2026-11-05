# Known issues

## KI-001 — codebase-memory-mcp stdio session disconnects in long Claude Code sessions (development tooling)

- **Detected:** 2026-11-02, during Phase A (architecture). The MCP connection of the orchestrating Claude Code session and of several sub-agents was reported as "failed to connect / disconnected".
- **Diagnosis:**
  - `codebase-memory-mcp cli list_projects` and `cli index_status` work (exit 0).
  - The daemon log (`~/.cache/codebase-memory-mcp/logs/cbm-daemon.log`) shows healthy incremental re-indexing of `C-Workout-masraf-ai-service` (status=indexed) followed by `daemon.runtime_stopping reason=last_committed_client_disconnected`. The stdio MCP client side dropped; the index and the binary are healthy.
  - Configuration: user scope (`codebase-memory-mcp`, `C:/Users/ugur.lafci/.local/bin/codebase-memory-mcp.exe`) plus project `.mcp.json` (same command). The configuration is valid.
- **Workaround (in use):** call the same real tools through the local CLI of the same binary. Tool names and arguments are identical:
  - `codebase-memory-mcp cli --quiet search_graph '{"project":"C-Workout-masraf-ai-service","name_pattern":"resolveWithin"}'`
  - `codebase-memory-mcp cli --quiet index_repository '{"repo_path":"C:/Workout/masraf-ai-service","mode":"moderate"}'`
  - `codebase-memory-mcp cli --quiet detect_changes '{"project":"C-Workout-masraf-ai-service","scope":"impact"}'`
  - From PowerShell, escape the inner quotes (`'{\"project\":\"...\"}'`); from Git Bash, use plain single quotes.
- **Fix for interactive sessions:** run `/mcp` in Claude Code and reconnect `codebase-memory-mcp`, or restart the session.
- **Impact on the product:** none. The platform's `@orc/mcp-manager` starts a fresh stdio client for each operation, with a timeout (contract §12.1). It does not depend on a long-lived session.
- **Policy:** as long as the MCP stdio session is unavailable, no broad refactor is done without graph queries. Agents use the CLI fallback above.

## KI-002 — win32 local mode: test and MCP spawns get the worker's real `APPDATA` and `LOCALAPPDATA` (B-020, partly fixed)

- **Detected:** 2026-11-05, B-017 experiments (finding B-020). The scope of the fix was decided in [ADR-0036](adr/0036-claude-subscription-oauth-auth.md) Decision 4 and Opus K8 8.6.
- **Diagnosis:**
  - On win32, `buildChildEnv` adds `WINDOWS_BASE_ENV` (`packages/security/src/env.ts`) to every child environment. That list contains `APPDATA` and `LOCALAPPDATA`, so the worker's real values are copied.
  - ADR-0036 overrides them only for Claude spawns and the CLI probe: `buildClaudeAppDataEnv` returns per-workspace paths for kinds `claude` and `probe`, and nothing for `test`, `mcp` and `git`.
  - Project test commands (`packages/orchestrator/src/test-runner.ts`) get isolated `HOME`, `USERPROFILE`, `TEMP` and `TMP`, but the real AppData values.
  - codebase-memory-mcp processes that the worker starts itself for indexing and change detection (`packages/mcp-manager/src/manager.ts`) get the real AppData values and the real `USERPROFILE`. The MCP server that Claude starts from `mcp.json` inherits Claude's isolated values.
- **Impact on the product:** development and test only. win32 runs only in `SANDBOX_MODE=local`, which has no OS isolation and is refused with `NODE_ENV=production` ([threat model](security/threat-model.md) R5). Repository-controlled test code and the MCP binary can read and write files under the operator's real roaming and local profile. The platform stores no secret there. The Linux production target has no AppData variables.
- **Workaround:** run untrusted repositories only on Linux in runner mode. On Windows, run the worker under a dedicated OS account whose profile holds nothing else.
- **Policy:** accepted (K8 8.6). Revisit if win32 support goes beyond local development.

## KI-003 — macOS local mode is not supported (B-016)

- **Detected:** cycle 2 (finding B-016, deferred as P3). Recorded here by [ADR-0036](adr/0036-claude-subscription-oauth-auth.md) Decision 12.
- **Diagnosis:**
  - On macOS `os.tmpdir()` is a per-user directory below `/var/folders/` of about 49 bytes. The AF_UNIX socket path limit there is 104 bytes including the NUL.
  - In local mode the codebase-memory-mcp daemon socket lives below `<os.tmpdir()>/orc-cbm-rt-<uid>/<16 hex>`. After the temp directory and the fixed socket suffix (`/cbm-daemon-<uid>/cbm-<16 hex>.sock`), at most about 20 bytes remain for the platform's runtime directory segment, which needs about 32. The daemon socket cannot be created, so MCP operations fail.
  - [ADR-0037](adr/0037-claude-mcp-runtime-precheck.md) item 2 rejects a symlinked `TMPDIR` (fail-closed) and names macOS as an example.
  - Further unverified ground: the fd 3 credential path was proven on Linux only (ADR-0036 D-1); macOS has no Yama, and the worker's `ptrace_scope` warning checks Linux only; the `CLAUDE_REVIEWED_EXTENSIONS` entries for `posix` were recorded on Linux, so a different macOS init set fails closed as an `extension` violation.
  - There is no early refusal: `hostPlatform()` (`packages/shared/src/node/process.ts`) maps macOS to `posix`, and no code path checks for it. Failures appear later (socket creation, `extension`).
- **Impact on the product:** none for the supported targets. Production is Linux in runner mode; local development is supported on Linux and Windows.
- **Workaround:** develop on Linux or Windows, or run the suites in the Linux container (`npm run test:linux`).
- **Policy:** macOS is not a supported platform for `SANDBOX_MODE=local`. A clear early refusal at startup is optional follow-up work for B-016.

## KI-004 — win32 oauth: the token stays in the Claude CLI's environment (local/dev only)

- **Detected:** 2026-11-05, B-017 experiment F1 (the fd path gives "Not logged in" on Windows). Decided in [ADR-0036](adr/0036-claude-subscription-oauth-auth.md) Decision 4 and "Consequences".
- **Diagnosis:**
  - On POSIX the token travels on fd 3, and Claude's environment shows only the variable name `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`. On Windows that path does not work, so `buildClaudeCredentialEnv` (`packages/security/src/env.ts`) puts the token in Claude's env as `CLAUDE_CODE_OAUTH_TOKEN`, and `spawnSupervised` refuses `credentialFd` on win32.
  - The CLI removes the variable from the env it gives its Bash, hook and MCP children (ADR-0036 E1). In local mode those children run as the same Windows user without isolation, so they can still read Claude's process environment. The token therefore reaches Claude's Bash children: the same class of exposure as api_key mode ([threat model](security/threat-model.md) R11, R12).
- **Impact on the product:** development only. Production runs on Linux with fd 3. Only agents with admin-enabled Bash rules run commands.
- **Workaround:** on Windows, run only repositories you trust and keep Bash rules off. Supply the token through `CLAUDE_CODE_OAUTH_TOKEN_FILE`, not the plain variable; the plain variable would also sit in the worker's own environment (threat model R5). If an untrusted repository ran with Bash rules, revoke and renew the token (`docs/operations/runbook.md`, "Claude credential (OAuth token)").
- **Policy:** accepted residual risk R11. Revisit when the CLI offers a credential path on Windows that keeps the value out of the process environment.
- **Related:** on the same platform, the isolated AppData directories get no 0700 protection (KI-007).

## KI-005 — win32: libuv adds `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `USERDOMAIN` and `USERNAME` to every child environment (informational)

- **Detected:** 2026-11-05, Wave 2 gate of B-017 (workspace isolation test on win32).
- **Diagnosis:**
  - On Windows, libuv (the process layer of Node.js) copies a fixed set of variables from the parent process into a child environment when the given environment lacks them.
  - Five of them are in none of `CLAUDE_ENV_ALLOWLIST`, `TEST_ENV_ALLOWLIST` and `WINDOWS_BASE_ENV`: `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `USERDOMAIN`, `USERNAME`. The platform's `buildChildEnv` does not emit them; they are added below it, outside its control.
  - The tests that compare a child's environment with the allowlist exempt exactly these five names on win32 (`tests/integration/claude-runner/run.test.ts`, `tests/security/workspace-isolation.test.ts`).
- **Impact on the product:** none on Linux (production). On Windows local mode the values are not secrets. They reveal the OS account name, the domain, the logon server and the real home drive and path. A tool that resolves the home directory from `HOMEDRIVE` + `HOMEPATH` when `HOME` and `USERPROFILE` are missing would find the real profile; Claude and test spawns set both to isolated directories (worker-started MCP spawns see the real profile anyway, KI-002).
- **Workaround:** none needed.
- **Policy:** informational. The test exemption stays limited to these five names and to win32.

## KI-006 — the full `tests/security` suite is not part of the `test:linux` targets (B-023)

- **Detected:** 2026-11-05, B-017 Wave 3 gate (finding B-023, P2, Platform + Security).
- **Diagnosis:**
  - `DEFAULT_TARGETS` in `scripts/test-linux.mjs` runs only three `tests/security` files, the B-017 ones, as root: `claude-credential-leak.test.ts`, `claude-env.test.ts` and `sandbox-escape.test.ts`.
  - A run of the whole `tests/security` folder as root on Linux shows 5 failures that predate B-017:
    - `tests/security/secret-masking.test.ts` and `tests/security/workspace-isolation.test.ts` need uid 1000 (the worker run), not root;
    - the POSIX expectation at `tests/security/path-traversal.test.ts:71` is out of date.
- **Impact on the product:** none at runtime. The gap is in coverage: the routine gate does not check the Linux behaviour of the remaining security files.
- **Workaround:** run the three files above through `npm run test:linux`, and the rest of `npm run test:security` on the host. The 5 failures do not come from B-017.
- **Policy:** open until B-023 adds the remaining security files to the Linux run with the right uid and fixes the outdated expectation.

## KI-007 — win32: the isolated AppData directories do not get mode 0700 (local/dev only)

- **Detected:** 2026-11-05, B-017 Wave 3 review (Opus K11).
- **Diagnosis:** `ensureClaudeAppDataDirs` (`packages/orchestrator/src/claude-home.ts:20`) creates `<home>\AppData\Roaming` and `<home>\AppData\Local` with `mode: 0o700`. On Windows, Node.js ignores the POSIX mode for `mkdir`, so the directories inherit the ACL of their parent. [ADR-0036](adr/0036-claude-subscription-oauth-auth.md) Decision 4 calls for 0700 directories, but that holds on POSIX only, and there the directories are not created.
- **Impact on the product:** development only. win32 runs only in `SANDBOX_MODE=local`, where all processes run as the same user anyway ([threat model](security/threat-model.md) R5). The per-workspace home is still a separate path, so the B-020 isolation from the operator's real profile holds. Production (Linux) is not affected.
- **Workaround:** keep the worker's `CLAUDE_HOME_ROOT` below a directory whose ACL grants access only to the worker's account.
- **Policy:** local/dev only, accepted.
