# ADR-0027: Dependency audit uses the npm registry advisory endpoint

- Status: Accepted (2026-11-02, contract v2.0.0)
- Deciders: Solution Architecture Manager; GPM approval with contract v2.0.0
- Contract: `docs/architecture/contract.md` §18.1, §18.5
- Review finding: F13

## Context
Requirement §15 demands a dependency scan without critical findings, while §3/§13-14 forbid cloud code analysis and external test services. `npm audit` sends the dependency tree (package names and versions, no source code) to the configured registry's advisory endpoint. v1.0.0 did not record this, did not define offline behaviour, ran with `--omit=dev` although web runtime libraries might be declared as devDependencies, and did not cover image contents.

## Decision
- `scripts/dependency-audit.mjs` runs `npm audit --omit=dev --json` against the configured npm registry; this is the only external call any test command makes and carries the same trust as `npm install` (no source code leaves the machine). Exit 1 on any critical finding.
- A network or registry error exits 3 with `dependency audit UNAVAILABLE - gate NOT passed`; the gate is never treated as passed silently.
- Every runtime library of a bundled app, including apps/web (`react`, `react-dom`, `react-router`, `@tanstack/react-query`), is declared in `dependencies`.
- Image contents (Debian packages, Claude CLI, codebase-memory-mcp, nginx, mssql, redis) are covered by the "Image CVE review" procedure in `docs/operations/runbook.md` before each release; no external scanner service is mandated.

## Consequences
The gate needs registry connectivity (or an internal registry mirror that serves advisories). Results are reproducible per lockfile.

## Alternatives considered
An offline advisory database (extra tooling and update process for the same data); skipping the scan (violates §15).

## Rollback path
Point `npm_config_registry` at an internal mirror; the script and gate semantics stay unchanged.
