# ADR-0034: Root-owned, listable anchors above the codebase-memory-mcp caches in runner mode

- Status: Accepted (2026-11-04, contract v2.1.1; ratified by GPM); relaxes the "no listing" property of §10.11 item 4 for `CBM_CACHE_DIR` and `<CBM_CACHE_DIR>/{p,w}`; amends ADR-0024 for these three directories only
- Deciders: Worker Platform Manager (proposal); Solution Architecture Manager; GPM; ratified by GPM
- Contract: `docs/architecture/contract.md` §10.11 items 4 and 9, §11.1 (layout unchanged), §12.1 (spawn unchanged)

## Context
`npm run test:compose` failed at the first project index: `mcp_unavailable codebase-memory-mcp connection closed (exit code 1, signal null)`; the worker's startup MCP probe failed the same way. Every runner-mode codebase-memory-mcp process (orchestrator operations and the server Claude starts from `mcp.json`) exited about 5 ms after it started. Reproduced in the worker image (codebase-memory-mcp v0.12.0, `linux-amd64-portable`) with the runner's own spawn (uid 20001, `prlimit --nproc=512 --nofile=4096 --fsize=2147483648 --core=0`, env `PATH, CBM_CACHE_DIR, CBM_ALLOWED_ROOT, CBM_LOG_LEVEL, CBM_RUNTIME_DIR`, cwd = scope):

1. prlimit is not the cause: with prlimit as root the server answers `initialize`. Without prlimit as uid 20001 it still exits 1. Stderr shows `codebase-memory-mcp: could not load saved runtime settings`. Adding `HOME`/`XDG_CONFIG_HOME` does not help, and uid 1000 fails the same way.
2. strace shows that the binary resolves `CBM_CACHE_DIR`, then walks it from `/` with `mkdirat(...)` + `openat(parent, comp, O_RDONLY|O_NOFOLLOW|O_DIRECTORY)` + `fstat`. The walk stops with `openat(".../orc", "cbm-cache") = -1 EACCES`, followed by `exit_group(1)`. The binary's own messages state the rule: every ancestor must be owned "by you (uid N) or root ... Use a location whose parent directories are yours or root's". When run as root, the walk fails on the owner check instead (`cbm-cache` is owned by 1000).
3. Ancestor matrix for a leased `p/<id>` cache (uid 20001, 0700):
   - root-owned 0755 ancestors: starts.
   - root-owned 0711: fails (no read).
   - 1000-owned 0755: fails (owner).
   - `root:1000 0775`/`1775`: starts (warning `daemon.private_dir_group_writable_ancestor`).
   - root 0777: fails.
   `CBM_RUNTIME_DIR` is subject to the same rule ("secure daemon endpoint could not be created"). `CBM_ALLOWED_ROOT`/`repo_path` is not: indexing a repository below the 0711, 1000-owned `WORKSPACES_ROOT` chain works.

§10.11 item 4 makes `CBM_CACHE_DIR` and `<CBM_CACHE_DIR>/{p,w}` 0711 and owned by the worker uid, so they fail both checks for every sandbox uid. The layout cannot be kept while codebase-memory-mcp runs as a sandbox uid with a cache below it. The leased cache dir's ancestors must be openable (`r`) by that uid, which means they can be listed. Claude's own MCP server shares the attempt uid with Claude's Bash children, so no uid or group split can separate "the MCP server can list `w/`" from "untrusted code can list `w/`".

## Decision
At every start in uid-switching mode, before it serves requests, the runner anchors `<CBM_CACHE_DIR>`, `<CBM_CACHE_DIR>/p` and `<CBM_CACHE_DIR>/w` (it creates `p`/`w` when missing) as `root:<WORKER_GID>` with mode `1775` (`anchorCbmCacheDirs`, `packages/sandbox/src/cbm-anchor.ts`, called from `apps/runner/src/runtime.ts`):
- Owner root: codebase-memory-mcp trusts the chain.
- Group = worker gid with write: the worker still creates and removes `probe`, `p/<projectId>` and `w/<workspaceId>`.
- Others `r-x`: a sandbox uid can open and list these three directories, but cannot create, rename or delete anything in them.
- Sticky: only an entry's owner can rename or delete it. The worker group can therefore swap neither the root-owned structure dirs nor a cache while a lease uid owns it, which is the concern behind codebase-memory-mcp's group-writable warning.

Each directory is opened `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` and changed through the descriptor (`fchown`, then `fchmod`). A symlink or non-directory is a startup error (`config_invalid`). The step is idempotent and never runs in local mode.

The following stay unchanged:
- Per-scope caches remain 0700 of the worker uid, or of the lease uid while leased; handoff and reclaim do not touch the anchors.
- uid separation, prlimit limits, env allowlist, read-only rootfs, capabilities and networks.
- The §12.1 spawn: argv, `cwd`, the `CBM_*` env, and `CBM_RUNTIME_DIR` = the leased cache.
- `WORKSPACES_ROOT` and `CLAUDE_HOME_ROOT` (0711 chains). codebase-memory-mcp does not need them listable.

Proposed contract text:
- §10.11 item 4: "... `CLAUDE_HOME_ROOT`, `<CLAUDE_HOME_ROOT>/w` = 0711 (traverse only, no listing); `CBM_CACHE_DIR`, `<CBM_CACHE_DIR>/{p,w}` = `root:<WORKER_GID>` 1775, anchored by the runner at startup (codebase-memory-mcp requires root-owned, openable ancestors; ADR-0034) ...". The sentence "A sandbox uid can reach only its own leased paths" stays true. Add: "it can list the GUID-named entries of `<CBM_CACHE_DIR>/{p,w}`".
- §10.11 item 9: "... other `claude-home/w/*` and `cbm-cache/{p,w}/*` neither readable nor writable; `cbm-cache/{p,w}` not writable ...".

## Consequences
- MCP indexing, the startup probe and Claude's MCP server work in runner mode. `npm run test:compose` gets past the index steps (29 checks passed before the probe step, versus 15 before the change).
- Residual risk: untrusted code can enumerate the project and workspace GUIDs that have an MCP cache. These names are not secrets (they appear in URLs and API payloads) and give no access, because every entry is 0700 of another uid.
- codebase-memory-mcp logs `daemon.private_dir_group_writable_ancestor` at warn level on its stderr. That stderr is debug-logged by the worker (§12.1).
- Required follow-up outside the Worker Platform paths: `scripts/compose-smoke.mjs` sandbox-probe targets (lines 1231-1232, `${PATHS.cbmCache}/p` and `/w` with `mustExist: true`) currently assert "list denied". They must assert "write denied", and they keep the per-scope entries 1233-1234. Until then, `npm run test:compose` fails at the claude-stage probes with exactly these two checks.
- Tests:
  - `tests/unit/sandbox/cbm-anchor.test.ts`.
  - `tests/integration/sandbox/cbm-anchor.test.ts` (Linux root): the runner spawn context with the policy walk, plus the real binary when `CODEBASE_MEMORY_MCP_BIN` is set or the binary is on PATH.
  - `tests/integration/sandbox/runner-runtime.test.ts` (anchors set by `start()`).

## Alternatives considered
- Owner root and 0711, or ACL read for the lease uid only: the walk needs `r`, and ACLs would still let the attempt uid (Claude's Bash) list `w/`.
- A shared supplementary group for MCP processes: the contract requires that sandbox children have none, and Claude's MCP child inherits Claude's credentials.
- Symlink or `/proc/self/fd` aliases: the binary realpaths first and walks the target.
- Bind mounts or `chroot`: these need `CAP_SYS_ADMIN`/`CAP_SYS_CHROOT`, which the runner must not hold.
- Moving the attempt cache below `claude-home` or `.meta`: same rule, and those parents are probed as "no listing" too.
- Per-lease rename of the cache into a runner-owned `<CBM_CACHE_DIR>/l/<uid>/` chain at acquire, and back at release: this keeps "no listing" but changes the §11.1 layout, Claude's `CBM_CACHE_DIR`, cleanup and crash recovery. It can be revisited if enumeration of GUIDs is judged unacceptable.
- Pinning a codebase-memory-mcp build without the check: none exists, and the check is a sound defence.

## Rollback path
Remove the `anchorCbmCacheDirs` call from `apps/runner/src/runtime.ts`. Already-anchored directories keep working for the worker through group write. To restore the strict layout, `chown 1000:1000` and `chmod 0711` the three directories. Runner-mode MCP then fails again exactly as described in Context.
