# ADR-0033: safe.directory for the local-transport upload-pack via a per-call global config file

- Status: Accepted (2026-11-04, contract v2.1.1; ratified by GPM); amends ADR-0015/ADR-0024 for `mirror_fetch` only
- Deciders: Source Control Manager; ratified by GPM
- Contract: `docs/architecture/contract.md` §11.1 (F1 sentence, directory layout), §11.3 (environment); §11.4 `mirror_fetch` argv unchanged; §10.11 item 4 (modes)

## Context
`npm run test:compose` failed at project sync: `git mirror_fetch failed with exit code 128`, worker stderr `fatal: detected dubious ownership in repository at '/var/lib/orc/projects/smoke-sample/.git'`. The projects bind mount is owned by a uid other than the worker's 1000 (root on Docker Desktop; any uid on Linux hosts), so this breaks every such installation. Reproduced in the worker image (git 2.39.5-0+deb12u3), root-owned source, fetch as uid 1000:

1. `fetch` from the source git dir as a plain path or `file://` URL, protocol v0 or v2, with `-c safe.directory=<src>/.git` (and with `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`): dubious ownership.
2. The local transport starts `git-upload-pack '<path>'` with git's `local_repo_env` removed; that list contains `GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_COUNT`, the carriers of `-c`. upload-pack's environment (dumped in the experiment) has `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, `GIT_PROTOCOL`, no `GIT_CONFIG_PARAMETERS`.
3. upload-pack itself checks ownership (2.39.4+, CVE-2024-32004 fix): `git -c safe.directory=<gd> upload-pack --advertise-refs <gd>` succeeds, the same without `-c` fails.
4. `GIT_CONFIG_GLOBAL=<file with [safe] directory = <src>/.git>` makes the fetch succeed (path and `file://`). An entry with the worktree path `<src>` does not: upload-pack compares the git dir.

`validate_source` (in-process, `-c` applies) is unaffected; `mirror_fetch` is the only operation that uses a transport.

## Decision
For `mirror_fetch` only, the git executor writes a per-call file `<WS>/.orc/git-config/<workerId>/mirror_fetch-<uuid>.gitconfig` and sets `GIT_CONFIG_GLOBAL` to it for that spawn:
- Content: only `[safe]` `directory = "<exact source git dir>"` (realpath from `realpathWithin(PROJECTS_ROOT, ...)`; quoted, `\` and `"` escaped; relative paths and control characters rejected, so `*`, other keys, sections or includes can never be produced).
- Created exclusively (`O_CREAT|O_EXCL`, never follows an existing entry), mode 0400, in a 0700 worker-owned directory below `.orc` (unreachable for sandbox uids, §10.11 item 4).
- Removed in `finally` on every path (success, non-zero exit, spawn error, timeout, abort); `ensureRuntimeDirs` deletes and recreates the worker's own subdirectory at startup (crash leftovers); other worker ids are untouched.
- Unchanged: the §11.3 argv prefix (incl. `-c safe.directory` for mirror and source), `GIT_CONFIG_NOSYSTEM=1`, `HOME`, the env allowlist. Every other git spawn keeps `GIT_CONFIG_GLOBAL=/dev/null`.

Proposed contract text: §11.1 F1 sentence "... and `GIT_CONFIG_GLOBAL=/dev/null` (`mirror_fetch`: a per-call worker-written file containing only `safe.directory=<source git dir>`, ADR-0033); nothing writable by an untrusted process is ever used as hooks or global config"; §11.1 layout adds `.orc/git-config/<workerId>/`; §11.3 environment notes the `mirror_fetch` exception.

## Consequences
Projects owned by any uid sync again. The trust scope is unchanged (the same exact path already named in argv), it only reaches upload-pack now; no wildcard, system config stays off, no user config is read (`GIT_CONFIG_GLOBAL` set => `~/.gitconfig` and XDG config ignored). The file is writable only by the worker uid, which is trusted (F1 targets untrusted writers). As before, upload-pack reads the source repository's own config (the trust that safe.directory grants) without the `-c` hardening flags; it runs no hooks, and `uploadpack.packObjectsHook` is honoured only from protected config, which is now just this file. Cost: one small file write and unlink per fetch. Tests: `tests/unit/git-manager/transport-config.test.ts`, `tests/integration/git-manager/foreign-owner.test.ts` (Linux as root; in the `npm run test:linux` defaults).

## Alternatives considered
`--upload-pack` / `remote.origin.uploadpack` = `git -c safe.directory=... upload-pack`: the local transport runs that value through `sh -c`, i.e. a shell string built by us (forbidden). `file://` or protocol v2: same spawn path and environment scrubbing. `GIT_CONFIG_COUNT` variables: scrubbed too. `safe.directory=*` or a `PROJECTS_ROOT/*` pattern: forbidden, and prefix patterns need git 2.46. An image-owned static global config: project paths are dynamic. Matching mount ownership: deployment dependent, impossible for Docker Desktop bind mounts. `clone --no-local` or bundles: same upload-pack.

## Rollback path
Drop `transportSafeDirectories` from `fetchMirror` (one line): `GIT_CONFIG_GLOBAL` is `/dev/null` everywhere again and foreign-owned sources fail as before. A leftover `.orc/git-config/` directory is harmless.
