# Tests

Projects, scripts and infrastructure: `docs/architecture/contract.md` §18 and the root `README.md`.

## Leak guard (B-005)

The infrastructure projects (integration, api, security, e2e, claude-live) register
`tests/setup/global-teardown.ts` after `tests/setup/global-infra.ts`, plus the setupFile
`tests/setup/leak-worker.ts`. One guard window per Vitest process: a snapshot after the database reset, a diff
after the last project, written to `tests/reports/leaks.json` (gitignored, rewritten on every run).

| Variable | Effect |
|---|---|
| (none) | Report only. Nothing is deleted or killed. Leaks and failed scans are printed by the Vitest logger. |
| `ORC_TEST_REAP=1` | Also removes this run's leaked temp dirs and kills this run's leaked fake-claude processes. Database rows are never deleted. |
| `ORC_TEST_LEAK_STRICT=1` | A leak or a failed scan sets exit code 1. Warnings do not. |

What counts as a leak (`tests/setup/leak-ledger.ts`):

- Temp dir: new in this run, a direct child of `realpath(os.tmpdir())` (pinned with `resolveWithin`), name
  `<listed prefix>` + the 6 mkdtemp characters (`LEAK_DIR_PREFIXES`, an explicit list, no `orc-*` pattern: `orc-cbm-rt-<uid>` and `orc-test-home` are never leaks), a real directory by `lstat`. The report lists the `orc/task-*` branches and linked worktrees inside.
  If another Vitest run is active on the host, new dirs are only warnings and are never removed. A dir containing a
  link, or a `.git` pointer leading outside the temp root, is never removed.
- Process: new in this run, carries the absolute path of `tests/fixtures/fake-claude/fake-claude.mjs`, and
  belongs to this run. Proof is one of: its parent chain reaches the Vitest main process; on Windows, its exited
  parent was one of this run's workers while that worker held the PID; on Linux, `/proc/<pid>/environ` has this
  run's `ORC_TEST_RUN_ID`. Other fake-claude processes are only warnings and are never killed. Only the matched
  process is killed, after it is checked again against a fresh process table.
- Database: per-table row-count changes in `orchestrator_test`. These are reported only.

Process tables come from one fixed PowerShell/CIM query on Windows and from `/proc` on Linux. A scan that fails is
reported as `scanUnavailable` and never counts as clean.

Every temp-dir prefix of the tests must be in `LEAK_DIR_PREFIXES`; `tests/unit/architecture/test-prefixes.test.ts` scans `tests/**` and fails on an unlisted or run-time-built prefix. Exclusions are listed there with reasons.
