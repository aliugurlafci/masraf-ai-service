# ADR-0015: Per-project bare mirror with per-attempt worktrees

- Status: Accepted (2026-11-02); amended by ADR-0024 (image-owned hooks dir, `GIT_CONFIG_GLOBAL=/dev/null`, worktree ops via `--git-dir`/`--work-tree`)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
Claude must never modify the real repository (read-only mount), every task needs an isolated worktree and branch, multiple worker replicas share a host, and patches/branches must survive the worktree. The brief specified `clone --bare` with a `refs/remotes/origin/*` refspec.

## Decision
`<WORKSPACES_ROOT>/.repos/<projectId>.git` is created with `git init --bare` plus `config remote.origin.url/fetch` (refspec `+refs/heads/*:refs/remotes/origin/*`) and filled by `fetch --prune --no-tags`. This is equivalent to the brief's clone but does not duplicate source heads under `refs/heads/*`, which are reserved for `orc/task-*` branches (brief refinement recorded here). The mirror is fetched before each attempt under a Redis mirror lock. Worktrees `<projectId>/<taskId>/a<n>` are added locked with branch `orc/task-<key>-a<n>`. Every git call uses an empty hooks path, `core.fsmonitor=false`, `protocol.allow=never` (`protocol.file.allow=always` only for fetch), exact `safe.directory`, isolated HOME and global config, and no system config.

## Consequences
Real repository untouched; cheap worktrees; branches retained for continue-retries and patches; one object store per project. The shared volume ties replicas to one Docker host.

## Alternatives considered
Worktree directly on the real repository (writes into its .git, forbidden); full clone per attempt (slow, disk heavy); literal `clone --bare` (duplicate heads namespace).

## Rollback path
Switch mirror creation to `clone --bare --no-local` plus post-clone ref cleanup; worktree layout unchanged.
