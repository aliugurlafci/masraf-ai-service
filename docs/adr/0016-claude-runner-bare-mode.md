# ADR-0016: Claude runner uses --bare with an isolated config directory

- Status: Accepted (2026-11-02); amended by ADR-0024 (Claude runs in the runner; HOME/CLAUDE_CONFIG_DIR per workspace)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
Verified on CLI 2.1.316: without `--bare` the CLI loads user hooks, plugins and user-scope MCP servers even with `--strict-mcp-config`, which would let host or repository configuration execute code or add tools.

## Decision
Production runs `claude -p --output-format stream-json --verbose --bare --setting-sources user --permission-mode dontAsk --tools ... --strict-mcp-config [--mcp-config <attempt mcp.json>]` with `CLAUDE_CONFIG_DIR` and `HOME` under `CLAUDE_HOME_ROOT` (isolated from any human user; `settings.json` = `{}`), `ANTHROPIC_API_KEY` auth, the prompt on stdin, an env allow-list, and fail-closed validation of the init event (permission mode, MCP servers, tools, cwd, session id, no hook events). The config directory is shared by worker replicas on the host so `--resume` works after recovery on another replica (refines the brief's per-worker wording: isolated from users, shared by replicas). `CLAUDE_BARE=false` is allowed only with `NODE_ENV=development` for local subscription logins.

## Consequences
Deterministic, auditable tool surface; requires an API key; session transcripts of all tasks share one directory, which Claude cannot read (deny rules, cwd boundary).

## Alternatives considered
Non-bare with only `--strict-mcp-config` (proven insufficient); per-replica config dirs (breaks cross-replica resume); a container per attempt (needs the Docker socket, forbidden).

## Rollback path
Set `CLAUDE_BARE=false` (development only) or drop `--bare` after a CLI upgrade proves equivalent isolation; the argv builder is the single change point.
