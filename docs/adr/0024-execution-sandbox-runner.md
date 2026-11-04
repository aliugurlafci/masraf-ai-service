# ADR-0024: Untrusted processes run in a separate `runner` sandbox container

- Status: Accepted by Architecture with contract v2.0.0 (2026-11-02); **Ratified by GPM 2026-11-02** (the runner launcher is the only root process, with 6 capabilities, no secrets and only the sandbox network; worker, api, web, egress-proxy and every untrusted process run non-root. This trade-off must be stated in docs/security and in the final report)
- Deciders: Solution Architecture Manager; GPM
- Contract: `docs/architecture/contract.md` §10.3, §10.4, §10.11, §11.3, §12.1, §13.5, §19
- Review findings: F1 (critical), T-C1 (critical), F17, parts of F2/T-M1

## Context
Contract v1.0.0 spawned Claude, its Bash tool children, codebase-memory-mcp and `Project.TestCommand` inside the worker container under the worker uid. Those processes execute repository-controlled code (package scripts, tool configs, test code). Claude's `Read`/`Edit` deny rules and the env allowlist do not apply to grandchildren, so such code could read `/run/secrets/*` (DB worker password, Redis password, API key), connect to MSSQL and Redis on `backend` (`orc_worker` can read every user's tasks and logs; the single Redis password allows reading streams, publishing cancels and enqueueing jobs), read or write every project's worktree, mirror, Claude transcript and index cache, and plant `post-*` hooks in the writable `.orc/git-empty-hooks` directory that the orchestrator would then run for every task (`--no-verify` does not suppress post-* hooks). A worktree-local `.git` file could also be redirected to a gitdir whose config defines filters executed by the orchestrator's `git add`. Requirement §5.8 forbids access to production secrets and other projects' worktrees; §15 requires workspace isolation.

## Decision
1. A new `runner` service (worker image, entry `dist/runner.js`, package `@orc/sandbox` + app `@orc/runner`, owned by the Worker Platform team) executes every untrusted process. It joins only the internal `sandbox` network (shared with egress-proxy), mounts only `workspaces`, `claude-home`, `cbm-cache` and `runner-sock`, and receives **no** secrets. The worker keeps DB/Redis access and runs only git.
2. The runner's PID 1 is a launcher running as uid 0 with exactly `SETUID, SETGID, CHOWN, FOWNER, DAC_READ_SEARCH, KILL` (everything else dropped, `no-new-privileges`, read-only rootfs). It never executes untrusted code. Children run under a per-lease sandbox uid (pool 20000..20063, zero capabilities, no supplementary groups) inside `prlimit --nproc --nofile --fsize --core=0`.
3. Leases hand the attempt's paths (worktree, `.meta`, per-workspace Claude home, per-workspace cbm cache) to the lease uid and reclaim them to the worker uid on release; all other paths are 0700 of the worker uid, parents 0711. Release kills every process of the lease uid (catches `setsid` escapes). Lease TTL (40 s) gives runner-side fencing.
4. The worker drives the runner over a Unix socket (`0660 root:1000`, so sandbox uids cannot connect) with a Zod-validated NDJSON protocol (`hello`, `lease_*`, `spawn` + stdio/stop/exit frames). The runner re-validates paths, env keys (API key and proxy only for kind `claude`) and argv.
5. The API key stays with the worker and is passed per Claude spawn; egress requires a proxy token that only Claude processes receive, so test and MCP processes are offline and cannot exfiltrate through api.anthropic.com with their own key.
6. Git hardening: `core.hooksPath` points to the image-owned read-only `/opt/orc/git/empty-hooks` (also persisted in mirror config), `GIT_CONFIG_GLOBAL=/dev/null`, and worktree operations use `--git-dir=<mirror>/worktrees/<id> --work-tree=<W>` resolved from the mirror, never the worktree's `.git` file.
7. Bash rules stay an admin-only, audited, per-agent opt-in; no seeded agent has one; `git diff|log|show` patterns are removed.
8. `SANDBOX_MODE=local` (same interface, no isolation) is allowed only outside production (development/test hosts, Windows).

## Consequences
- Secrets, DB and Redis are unreachable from any repository code; cross-task and cross-project file access is blocked by uid ownership; a runaway attempt can exhaust only the runner, never the worker.
- New moving parts: runner service, socket volume, lease handoff (chown walk on lease acquire/release adds seconds for very large trees), per-workspace Claude homes (resume only within the same workspace, which the design already required).
- The worker no longer needs the egress network.
- Residual risks (accepted): Bash children of Claude inherit `ANTHROPIC_API_KEY` and the proxy credentials when an admin enabled Bash rules for that agent; argv of other leases is visible in `/proc` (argv carries no secrets); the launcher holds CHOWN/FOWNER/DAC_READ_SEARCH over the mounted volumes (trusted code, narrow protocol). The runner launcher is uid 0 with six capabilities; the requirement "worker non-root" still holds and every untrusted process is non-root.

## Alternatives considered
- Single shared runner uid (USER 1001): blocks secrets and the backend network but leaves every attempt able to read and modify every other worktree, transcript and index (violates §5.8 "other projects' worktrees").
- Landlock / bubblewrap / gVisor: Landlock support and the Docker default seccomp profile vary across hosts (Docker Desktop kernels); unprivileged user namespaces are blocked in containers; gVisor needs a host runtime change.
- One container per attempt: needs the Docker socket (forbidden).
- Interim "different uid inside the worker container": still shares the backend network with untrusted code.

## Rollback path
Set `SANDBOX_MODE=local` in a non-production deployment and stop the runner service; production cannot roll back without reopening F1/T-C1 (config validation forbids it).
