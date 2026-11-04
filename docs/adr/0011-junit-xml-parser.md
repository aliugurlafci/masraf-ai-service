# ADR-0011: fast-xml-parser for JUnit XML reports

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
The testing stage optionally parses a JUnit XML report produced by the project's own (untrusted) test command; the parser must be safe against entity expansion and XXE.

## Decision
Use fast-xml-parser (pure JS, no native deps, no network or file resolution) with `processEntities: false`, attributes enabled, input capped at `JUNIT_MAX_BYTES` and read via `realpathWithin`; map `testsuite/testcase/failure/error/skipped` to TestResults (max `JUNIT_MAX_CASES`).

## Consequences
Robust parsing of common reporters (Vitest, jest-junit, surefire); malformed reports degrade to exit-code status with `ReportError`.

## Alternatives considered
xml2js (callback API, entity handling less explicit); libxmljs (native build, XXE risk if misconfigured); regex parsing (fragile).

## Rollback path
`parseJUnitXml` is the only consumer; swap the implementation behind it.
