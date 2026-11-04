# ADR-0032: Local sandbox mode assumes one worker per uid and PID namespace

- Status: Accepted (2026-11-04, contract v2.1.1)
- Deciders: Solution Architecture Manager; ratified by GPM
- Contract: `docs/architecture/contract.md` Changelog 2.1.1 (§10.8, §10.11; documented constraint, no interface change)
- Requirements: §10.8 (orphan sweep), §10.11 (execution sandbox, `SANDBOX_MODE=local` dev only)

## Context
In `SANDBOX_MODE=local` the worker runs Claude and test processes as the current user (§10.11). Its orphan sweep (§10.8; `sweepOrphans` at startup and every 60 s) kills every process of the same uid whose `/proc/<pid>/environ` carries an `ORC_ATTEMPT_ID` that is not in the worker's active set. Two local workers that share a Linux uid and PID namespace therefore kill each other's live Claude and test processes. In runner mode (production) the sweep only releases the worker's own leases, and each worker runs in its own container, so this does not affect production.

## Decision
Local sandbox mode (development only) assumes at most one worker process per uid and PID namespace. When more than one local worker is needed, each worker MUST run under a separate uid or in a separate PID namespace (separate container). The marker scan and the Claude environment allowlist are unchanged.

## Consequences
- No code, interface or security-surface change; the marker sweep and §10.3 env allowlist stay as specified.
- Local development with several workers on one host must use containers or distinct uids; the integration suite (`tests/integration/worker/fencing.test.ts`) runs both runtimes in one process and disables the periodic sweep, then starts the rescuer after the fence completes.
- Production is not affected because each runner-mode worker sweeps only its own leases.

## Alternatives considered
- Worker-specific marker (`ORC_WORKER_ID`) used by the sweep: rejected. It widens the §10.3 Claude env allowlist and changes the marker scan, which increases the security surface for a development-only issue.

## Rollback path
If several local workers on one uid/PID namespace become a requirement, re-evaluate the worker-specific marker in a new ADR (contract minor bump, §10.3 and §10.8 updated together). Until then this constraint stands.
