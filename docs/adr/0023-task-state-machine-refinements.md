# ADR-0023: Task state machine refinements

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
The brief's transitions leave open how test failures, artefacts on failures, retries that continue work, and recoveries interact.

## Decision
(1) Test failures, timeouts and spawn errors continue to `reviewing` so diffs and patches are stored, then end `failed` with the test reason. (2) Failed, timed-out and cancelled attempts get a best-effort artefact capture (commit, changed files, patch; 60 s). (3) User retry has modes `fresh` (new worktree from base) and `continue` (reuse workspace with `--resume --fork-session`, or a new worktree from the previous head). (4) Infra recovery uses mode `resume` in the same workspace with a fixed continuation prompt and a full per-attempt timeout, bounded by `MAX_AUTO_RECOVERIES`. (5) Attempt statuses include `interrupted`; exactly one live attempt per task (filtered unique index). (6) Worker-side writes use status compare-and-set; a lost CAS marks the attempt superseded. (7) Projects have their own status (`validating|ready|invalid|archived`); tasks require `ready`. (8) The brief's "orphan-process sweep" maintenance job is split: process-level sweeps run as a per-worker local timer and at startup (processes are local to a container), while the queue scheduler `stale-attempt-recovery` handles DB-level orphans (attempts whose worker stopped heart-beating).

## Consequences
Users always see what changed; recovery is automatic and bounded; the transition table in contract §5.1 keeps the brief's edges.

## Alternatives considered
Fail directly from `testing` (loses diff visibility); no artefacts on failure (continue-retry impossible).

## Rollback path
Change the pipeline's next-stage selection; schema and transitions stay compatible.
