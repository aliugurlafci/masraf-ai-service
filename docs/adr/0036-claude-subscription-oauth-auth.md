# ADR-0036: Claude runs non-bare with subscription OAuth by default; one hardened argv for both auth modes

- Status: Accepted (2026-11-05; contract 3.0.0 approved by the user). D-7(a), the offline check of the real token's format, passed (the user's real token matches `CLAUDE_OAUTH_TOKEN_REGEX`; only the boolean was recorded). GPM and the Opus review signed the K8 decisions 8.1-8.8 (`.claude/state/denetim-defteri.md`, "D3 TASARIM-ONAYI").
- Supersedes ADR-0016 (the `--bare` decision). The isolated per-workspace `HOME` and `CLAUDE_CONFIG_DIR` from ADR-0016, as amended by ADR-0024, stay in force.
- Amends ADR-0024 Decision 5 and its residual risks: each Claude spawn now receives its own credential.
- Release: shipped in contract 3.0.0 together with ADR-0037 (B-015). Each ADR has its own changelog subsection.
- Deciders: Solution Architecture Manager (proposal); Security Manager (review); Opus review (K8); GPM; user (3.0.0 MAJOR).
- Contract sections: `docs/architecture/contract.md` §2.2, §2.7, §2.8, §10.1, §10.2, §10.3, §10.6, §10.9, §10.11 items 5 and 8, §16.3, §16.7, §17.2, §18.3, §18.5, §19.
- Findings addressed: B-017 (subscription auth), B-018 (the API key reaches Bash and MCP children), B-019 (`--bare` drops Glob, Grep and Write), B-020 (`APPDATA` and `LOCALAPPDATA` are not isolated on win32).
- Evidence:
  - `.claude/state/tasarim/B-017-deney.md`: CLI 2.1.318 on Windows and 2.1.316 on Linux (`orc-worker:smoke`); ids A*, B*, E*, F*, H*, K*, M*, R*.
  - `.claude/state/tasarim/B-017-D0.md`: acceptance experiments D-1 to D-6.

## Context
The user runs the platform on their own machine with their own Claude subscription. The platform must not ask for an Anthropic API key (requirement of 2026-11-05). The user decided three things:
- The default auth is the long-lived token from `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`).
- `ANTHROPIC_API_KEY` stays available as an optional alternative.
- `npm run compose:up` must start without an API key.

### Contract 2.2.1 cannot support OAuth
- `--bare` is row 4 of §10.2 and is mandatory in production. In bare mode the OAuth token is ignored (A2), and `CLAUDE_CODE_SIMPLE=1` ignores it too (A3).
- The only supported way to pass the token is: no `--bare`, no SIMPLE, and the token in the environment (A1). On Linux a file descriptor also works (F1).
- A4 (`apiKeyHelper` returning the token) and A5 (`ANTHROPIC_AUTH_TOKEN`) send the token without the OAuth beta header. Neither is a supported path.

### ADR-0016's reason for `--bare` no longer holds
- `--strict-mcp-config` blocks user-scope MCP servers (M1).
- `--setting-sources user` blocks the project and local sources: hooks, settings, `.mcp.json`, plugins, skills, agents, commands, project `CLAUDE.md` with `@import`, and `.claude/rules` (B1 compared with K9).

### What non-bare leaves open, and the switches that close it
| Left open (B1) | Verified switch |
|---|---|
| User hooks | `disableAllHooks` (H1) |
| Auto-memory | `autoMemoryEnabled:false` (K2) or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (K3) |
| User `CLAUDE.md` | `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (K4) |
| Attribution (Co-Authored-By) | `attribution` (K6a) with `includeGitInstructions:false` (K7) |

With all four switches on, every harmful input was blocked, and `--include-hook-events` reported zero hook events (H1, H1i). `--restricted` ignores the user `settings.json`, still applies `--settings` and keeps MCP working (R1, R2, B5). It also passed resume and the mid-session settings change test (D-4).

### Current defects
- B-019: under `--bare`, `init.tools` shrinks to `Bash, Edit, Read` on both CLI versions (A2, B2).
- `validateInit` does not detect missing tools and does not look at skills, agents, plugins or memory. Its `hook_event` rule applies only with `--bare`.

### Credential exposure
- The CLI removes the OAuth token from the env of its Bash, hook and MCP children (E1, K0). It does not remove `ANTHROPIC_API_KEY` (E2).
- On Linux a Bash child with the same uid read `CLAUDE_CODE_OAUTH_TOKEN` from `/proc/<claude>/environ` (E3).
- If an API key and an OAuth token are both present, the API key wins (A10).

### The FD path holds up (D0)
- D-1:
  - The CLI reads fd 3 once and keeps the token in memory across three requests.
  - Bash and MCP children do not inherit fd 3.
  - `/proc/<claude>/fd/3` is empty (0 bytes) and environ shows only the variable name.
  - `/proc/<claude>/mem` returns EACCES with `kernel.yama.ptrace_scope=1`.
  - Resume with a fresh fd 3 works.
- D-2: fd 3 survives `prlimit ... --` and the setuid spawn to uid 20000.

### Init sets differ by mode, platform and version (D-6)
- Oauth mode adds the bundled `schedule` skill and `schedule` slash command.
- Plugins on 2.1.316 Linux: `cc-plugin-agents-md` and `cc-plugin-plugin-authoring`. Version 2.1.318 on Windows adds `cc-plugin-privacy`.
- There are 5 agents everywhere, and `memory_paths` is null in every mode.
- `apiKeySource` is `none` for oauth and `ANTHROPIC_API_KEY` for api_key.

### API key leak (D-3)
- A `mcp.json` `env` entry `ANTHROPIC_API_KEY: ""` removes the key value from the MCP child on both platforms.
- No path is known that removes it from Bash children.

### Windows (B-020)
On win32, `buildChildEnv` copies the worker's real `APPDATA` and `LOCALAPPDATA`. The experiments isolated both and all runs worked.

## Decision
1. **Explicit auth mode, fail-closed.**
   - `CLAUDE_AUTH_MODE` takes one of `CLAUDE_AUTH_MODES = ['oauth', 'api_key'] as const` (`@orc/shared`). The default is `oauth` in every `NODE_ENV`. The mode is never inferred from which secret happens to be present.
   - `WorkerConfigSchema` in `oauth` mode:
     - requires `CLAUDE_CODE_OAUTH_TOKEN[_FILE]`, matching `CLAUDE_OAUTH_TOKEN_REGEX = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,500}$/`;
     - fails with ConfigError if `ANTHROPIC_API_KEY` is set (8.2). The error names only the key, never the value. An empty value counts as unset (§16).
   - `WorkerConfigSchema` in `api_key` mode:
     - requires `ANTHROPIC_API_KEY`, which must not start with `sk-ant-oat`;
     - fails with ConfigError if `CLAUDE_CODE_OAUTH_TOKEN` is set.
   - `CLAUDE_BARE` is removed. If it is set, ConfigError says "removed by ADR-0036".
   - The config output is `claudeAuth: {mode:'oauth', oauthToken} | {mode:'api_key', apiKey}`. In `ClaudeRunnerConfig`, `bare` and `apiKey` are replaced by `auth`, using the same union.
   - Defence in depth:
     - the env builder never emits both credentials;
     - the runner's `validateSpawnEnv` rejects a `claude` env that carries both `ANTHROPIC_API_KEY` and any `CLAUDE_CODE_OAUTH_TOKEN*` (`env_rejected`);
     - `validateInit` checks `auth_source` (item 5).
2. **Secrets and compose.**
   - **New secret.** `claude_oauth_token` (`./secrets/claude_oauth_token.txt`) is mounted into `worker` only.
   - **Worker environment.**
     - Added: `CLAUDE_AUTH_MODE: ${CLAUDE_AUTH_MODE:-oauth}` and `CLAUDE_CODE_OAUTH_TOKEN_FILE: /run/secrets/claude_oauth_token`.
     - Unchanged: `ANTHROPIC_API_KEY_FILE`.
     - Removed: `CLAUDE_BARE`.
   - **Credential files.** Both credential files always exist. The unused one is empty (0 bytes), which means "not configured".
   - **`generate-secrets`.**
     - New option: `--only claude_oauth_token --claude-oauth-token-stdin`.
     - It reads the first stdin line, or `CLAUDE_CODE_OAUTH_TOKEN`, checks it against the regex and never echoes it.
     - It creates missing credential files as empty files.
     - It refuses to write one credential while the other file is non-empty. Switching modes is a documented operator step.
   - **`compose-check`.**
     - Exactly one of the two files is non-empty, and it matches the rendered `services.worker.environment.CLAUDE_AUTH_MODE`.
     - The token file matches the regex.
     - The API key file keeps its current rule and must not start with `sk-ant-oat`.
     - Values are never printed.
   - **Where the rule lives.** The rule is in `scripts/lib/claude-credentials.mjs`. A unit test asserts that its regex equals the one in `@orc/shared`.
   - **Smoke test.** The smoke run uses a generated dummy token that matches the regex, with `CLAUDE_AUTH_MODE=oauth`.
3. **One hardened argv for both modes (B-019).**
   - §10.2 becomes, in order:
     1. `-p`
     2. `--output-format stream-json`
     3. `--verbose`
     4. `--include-hook-events`
     5. `--restricted` (8.1, D-4 passed)
     6. `--setting-sources user`
     7. `--settings <CLAUDE_HARDENED_SETTINGS>`
     8. The former rows 6-16, unchanged.
   - `CLAUDE_HARDENED_SETTINGS` is a frozen constant, passed inline:

     ```json
     {"disableAllHooks":true,"autoMemoryEnabled":false,"attribution":{"commit":"","pr":""},"includeGitInstructions":false}
     ```

     It is not passed as a file, because a file in `.meta` would be writable by the lease uid.
   - `--bare`, `--safe-mode` (it disables `--mcp-config`, B4) and `CLAUDE_CODE_SIMPLE` move to the "never used" list. `--settings` leaves that list.
   - `buildClaudeArgv` loses its `bare` option and has no branch per auth mode.
4. **Environment and credential transport.**
   - **Allowlist.** `CLAUDE_ENV_ALLOWLIST` and the runner's `CLAUDE_ONLY_ENV_KEYS` both add:
     - `CLAUDE_CODE_OAUTH_TOKEN`
     - `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`
     - `CLAUDE_CODE_DISABLE_AUTO_MEMORY`
     - `CLAUDE_CODE_DISABLE_CLAUDE_MDS`
   - **Set on every Claude spawn:** `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`.
   - **Never set:** `CLAUDE_CODE_SIMPLE`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`.
   - **oauth on POSIX** (local and runner mode):
     - The env carries `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3` and never the token itself.
     - The token travels in the new optional field `LaunchSpec.credentialFd` (kind `claude` only).
     - `spawnSupervised({credentialFd})` spawns with `stdio: ['pipe','pipe','pipe','pipe']`, writes the token to `stdio[3]` and ends that pipe immediately.
     - The runner protocol `spawn` frame gets an optional `credentialFd {b64}` of at most 4 KiB. The runner accepts it only for kind `claude` and only when the env names FD `3`.
   - **oauth on win32** (local mode only): the token goes in the env as `CLAUDE_CODE_OAUTH_TOKEN`. The FD path does not work on Windows (F1).
   - **api_key mode:** `ANTHROPIC_API_KEY` goes in the env, as today.
   - **Probe env:** no credential variable and no fd 3.
   - **B-020** (8.6), Claude spawns and the probe only, on win32:
     - `APPDATA=<home>\AppData\Roaming` and `LOCALAPPDATA=<home>\AppData\Local`, where `<home>` is the per-workspace `HOME`.
     - The probe uses the same layout under its own directory.
     - The worker creates these directories with mode 0700.
     - Test and MCP spawns are not changed. This is recorded as a known issue in `docs/known-issues.md`.
5. **`validateInit` (§10.6) is tightened.** Every violation still means a forced kill with outcome `security_violation`. The `InitRule` values become: `permission_mode | mcp_server | tool | tool_missing | extension | memory | auth_source | cwd | session_id | hook_event`.
   - `tool`: every init tool must be allowed. That means it is one of the builtins in the request, a MCP resource tool, `mcp__codebase-memory-mcp__*`, `CLAUDE_INTERNAL_TOOL_NAMES` or `CLAUDE_INIT_EXTRA_TOOLS`.
   - `tool_missing` (8.4): every requested builtin must be present in the init (catches B-019).
   - `extension` (8.3):
     - Reviewed constant table: `CLAUDE_REVIEWED_EXTENSIONS`, keyed by `<cliVersion>/<platform>/<authMode>`. Each entry holds the lists `skills`, `agents`, `slashCommands` and `plugins` (by name). There is no operator knob.
     - Lookup key: `cliVersion` is the version found by the probe (§10.9). If `init.claude_code_version` differs from it, that is a violation.
     - What counts as a violation:
       - an init name that is not in the entry;
       - a missing table entry;
       - a field that cannot be parsed.
       A field that is absent counts as empty. The violation detail lists only the unexpected names, or the key that has no entry.
     - Initial keys:
       - `2.1.316/posix/oauth` and `2.1.316/posix/api_key`: two plugins.
       - `2.1.318/win32/oauth` and `2.1.318/win32/api_key`: three plugins, adding `cc-plugin-privacy`.
       - In the oauth entries, `schedule` is added to both `skills` and `slashCommands`.
     - Names are recorded from the init offline (fake token, no network) and frozen by `tests/unit/claude-runner/validate-init.test.ts`.
     - On local mode, a host CLI update without a table entry stops every task, fail-closed, with a clear detail. The runbook describes this case.
   - `memory`: `memory_paths` must be absent, null or empty.
   - `auth_source`: `apiKeySource` must be `none` in oauth mode and `ANTHROPIC_API_KEY` in api_key mode (D-6). This catches a takeover through `apiKeyHelper` or an API key (A10, K9).
   - `hook_event`: with `--include-hook-events`, any `system` line whose subtype starts with `hook_` is a violation, at any time and in both modes.
6. **Probe (§10.9).** Required flags add `--settings`, `--include-hook-events` and `--restricted` (8.1). The conditional `--bare` and `CLAUDE_BARE_FLAG` are removed.
7. **API key mode (B-018, 8.8).**
   - **MCP:** proven mitigation, applied in api_key mode. The codebase-memory-mcp entry of Claude's `mcp.json` gets `ANTHROPIC_API_KEY: ""` in its `env` (D-3: the MCP child sees an empty value).
     - Mechanism: `McpManagerConfig.claudeEnvScrub` (§2.7, additive and optional; the only allowed name is `ANTHROPIC_API_KEY`).
     - The worker sets it from `claudeAuth.mode`.
   - **Bash:** no proven path. The key still reaches the Bash children of agents with admin-enabled Bash rules. This is accepted as residual risk (it exists today).
     - `docs/security/threat-model.md` marks api_key mode as "not recommended".
     - The worker logs one warning at startup in api_key mode.
8. **Credential hygiene in logs (Opus K8 condition).**
   - `@orc/logger` (§17.2) redacts:
     - values matching `sk-ant-oat`;
     - keys `CLAUDE_CODE_OAUTH_TOKEN*` at any depth;
     - the protocol field `credentialFd`, including its b64 payload.
   - The runner and the worker never log a `spawn` frame's `credentialFd`.
9. **`ptrace_scope` check.** The protection of `/proc/<claude>/mem` depends on Yama `ptrace_scope >= 1`. That setting comes from the host kernel, and compose cannot set it (it is not namespaced).
   - In runner mode the runner reads `/proc/sys/kernel/yama/ptrace_scope` at startup.
   - In `NODE_ENV=production`, the runner refuses to become healthy when the value is missing or 0. In development and test it only warns.
   - Local mode on Linux: the worker warns once.
   - The runbook describes how to check and persist the setting on the Docker host.
10. **Auth failures (8.5).**
    - The mapping of 401, "Not logged in" and quota exhaustion to their own outcome is deferred to B-022.
    - This change ships two things now:
      - a test showing that an auth failure ends the attempt once, with no retry storm (no automatic re-enqueue loop);
      - a runbook step for renewing the token.
11. **Tests.**
    - **fake-claude (§18.3)** emulates both modes:
      - It reads fd 3 to EOF and closes it when the FD variable is set, and takes the env value otherwise.
      - `apiKeySource` is `ANTHROPIC_API_KEY` when that variable is set, otherwise `none`.
      - With no credential it prints `Not logged in` and exits 1 (D-6).
      - It accepts `--settings`, `--include-hook-events` and `--restricted`, and lists them in `--help`.
      - `echo-env` reports `authSource`.
      - New directives: `init-extension <kind> <name>`, `init-memory-path <p>`, `init-api-key-source <s>`, `init-tool-missing <t>`, `echo-fds` and `auth-error <401|not-logged-in>`.
    - **Unit tests:**
      - argv is identical in both modes;
      - env transport per platform, credentials never both present, B-020;
      - config mode matrix and `CLAUDE_BARE` rejection;
      - extension table lookup;
      - runner env validation;
      - `claude-credentials.mjs`;
      - logger redaction;
      - `claudeEnvScrub`.
    - **Integration tests:**
      - oauth-fd, oauth-env and api_key runs;
      - violation scenarios;
      - no retry storm on `auth-error`.
    - **Security tests:**
      - the token value appears neither in Claude's environ nor in an `@@fake exec` child's environ or fds (Linux);
      - the runner rejects `credentialFd` for `test` and `mcp`;
      - the runner rejects both credentials together;
      - sandbox-escape adds `CLAUDE_CODE_OAUTH_TOKEN*`.
    - **`test:claude-live`** (user approval, real token, `CLAUDE_LIVE_AUTH_MODE` with default `oauth`):
      - `probe-init` re-verifies the table;
      - `credential-leak`:
        - the MCP child and a `node --test` Bash child see neither the token nor fd 3;
        - no token on disk;
        - in api_key mode the MCP child sees an empty key.
      - `run` and `permission-boundary` run in oauth mode.
12. **Docs.**
    - README: quick start with `claude setup-token`.
    - `docs/operations`:
      - creating the token and installing it with `generate-secrets`;
      - renewing it (write the new token, then restart the worker);
      - revoking it and switching modes;
      - the CLI update note (item 5);
      - the `ptrace_scope` check.
    - `docs/security/threat-model.md`:
      - the OAuth token as an asset;
      - its flow: file, worker, runner socket, fd 3, CLI memory;
      - api_key mode marked "not recommended";
      - the residual risks below.
    - `docs/known-issues.md`: B-020 (test and MCP spawns), and B-016 (macOS is not supported).
13. **Contract 3.0.0 (major, approved by the user; 8.7).**
    - Why it is major:
      - a config key is removed (`CLAUDE_BARE` now fails at startup);
      - the default auth changes;
      - `ClaudeRunnerConfig` changes;
      - the argv and the probe flags change;
      - `validateInit` becomes stricter.
    - ADR-0037 ships in the same release, with its own changelog subsection. 2.2.1 keeps its entry.

## Acceptance criteria and verification
- **D0 (`B-017-D0.md`):** D-1a/b/c, D-2, D-4 and D-6 passed. D-3 passed for MCP but not for Bash (item 7).
- **D-7(a), PASSED (GEÇ):** the user's real token matches `CLAUDE_OAUTH_TOKEN_REGEX` (offline check; only the boolean result was reported).
- **Wave 2 gate (completes D-2):** after `credentialFd` is implemented, the runner and worker logs of `test:compose`, `test:integration` and the security suite contain 0 matches of the dummy token value and of its base64 form.
- **Live, with user approval:**
  - D-5: only `api.anthropic.com:443` is reached, checked with a proxy that logs CONNECT requests.
  - D-7(b): the token's validity period and revocation path, taken from the official Anthropic documentation.
  - D-8: output shapes for quota exhaustion and an expired token. These are input for B-022.

## Consequences
- **What improves.**
  - The user needs no API key. compose:up starts once the token file is filled.
  - Production and development share one argv. B-019 is fixed, and a missing tool now fails closed (`tool_missing`).
- **Isolation now depends on CLI behaviour.**
  - Isolation rests on verified switches. They must be re-verified on every CLI version bump, through `probe-init` and new `CLAUDE_REVIEWED_EXTENSIONS` entries.
  - An unknown version, platform or mode stops tasks, fail-closed, until a reviewed entry ships.
- **Components that cannot be disabled.** These exist in bare mode too, and the proxy limits their egress:
  - the builtin cc-plugin native hooks, which emit no events;
  - the bundled skills and agents;
  - the LSP manager, with 0 servers;
  - the startup prefetch.
- **Credential residual risks.**
  - **fd 3 stays open.** The CLI drains fd 3 but does not close it. Children start after the drain, and D-1b showed they cannot recover the value.
  - **Memory read depends on Yama.** Reading Claude's memory needs `ptrace_scope` at 0; item 9 enforces `ptrace_scope >= 1` in production. In runner mode, tools of one attempt share the lease uid.
  - **Windows env path (development only).** With Windows oauth, the token stays in Claude's process environment as a value. Same-user processes can read it, and there is no isolation.
  - **api_key mode.** The key reaches Bash children (item 7).
  - **Proxy credentials.** They still reach Bash children, as described in ADR-0024.
- **Account exposure.**
  - The token is long-lived and stands for the user's whole subscription. If it leaks, it can be used on the user's account until it is revoked.
  - Parallel attempts share the subscription's rate limits.
  - Sharing one personal token among several users is the operator's responsibility under Anthropic's terms.

## Alternatives considered
- **Infer the mode from which secret is present.** Rejected. A stray `ANTHROPIC_API_KEY` would silently switch billing or override OAuth (A10).
- **Keep `--bare` for API key mode.** Rejected. It means two argv variants and three missing tools (B-019), and it does not reduce the leak (E2).
- **Pass the OAuth token through `apiKeyHelper` or `ANTHROPIC_AUTH_TOKEN` (A4, A5).** Rejected as unsupported paths.
- **Use `--safe-mode`.** Rejected. It disables `--mcp-config` (B4).
- **One extension set, or an operator knob such as `CLAUDE_INIT_EXTRA_*`.** Rejected. One set is wrong per mode and platform (D-6). A knob widens the surface (8.3).
- **Ignore `ANTHROPIC_API_KEY` in oauth mode.** Rejected. It would hide a misconfiguration (8.2).
- **A single `claude_credential` secret.** Rejected. The file name would no longer say what it holds, and compose-check could not catch a token filed as an API key.
- **Pin `ptrace_scope` in compose.** Not possible. The sysctl is not namespaced, so the runner checks it at startup instead (item 9).

## Rollback path
- **Auth.** Set `CLAUDE_AUTH_MODE=api_key`, fill `anthropic_api_key.txt` and empty `claude_oauth_token.txt`. No image change is needed.
- **Argv.** `buildClaudeArgv` is the single place to change. Restoring `--bare` brings B-019 back and makes OAuth impossible. A full rollback means redeploying the contract 2.2.1 images with an API key.
- **Individual switches.** `--restricted`, `--include-hook-events` and the `ptrace_scope` refusal can each be dropped by a contract patch if a CLI bump or a host breaks them. The remaining layers keep protecting.
