# Release checklist

Complete this list for every release candidate and keep the filled copy with the release notes
(contract §18.5, requirements §14-§16).

## 1. Code gates (developer host)

- [ ] `npm ci` from the lockfile with no changes.
- [ ] `npm run lint`: ESLint, the dependency rules of contract §1.2, no `console`.
- [ ] `npm run typecheck`
- [ ] `npm run infra:test:up`, then `npm test` (unit, integration, api, security, e2e, web). Real Claude
      is never called.
- [ ] `npm run test:security` (the security project plus the placeholder check and the dependency audit).
- [ ] `npm run audit:deps` reports no critical finding (ADR-0027). The status `UNAVAILABLE` does **not**
      count as passed.
- [ ] `npm run test:report` writes `reports/junit-*.xml` and `reports/html/`. Archive them.
- [ ] Linux-only tests (sandbox uid switching, POSIX process groups) pass on a Linux host or in a Linux
      container.

## 2. Stack gate (staging host with Docker)

- [ ] `npm run test:compose` passes. It covers health over HTTPS, create-admin, project registration and
      index status, task to SSE `end` with diff and tests, cancel, timeout, sandbox-escape probes (Claude
      stage and test stage), the fork-bomb bound, non-root containers, no direct internet route, and
      backup plus restore check.
- [ ] Image CVE review completed ([runbook.md](runbook.md#image-cve-review-before-each-release-adr-0027)).
      Base image digests and the pins of the Claude CLI and codebase-memory-mcp are recorded.

## 3. Claude CLI release gate (only when the CLI pin changed)

- [ ] `npm run test:claude-live -- permission-boundary` passes with the new CLI.
- [ ] Evidence (JUnit report and masked transcript) is committed under
      `docs/operations/evidence/<cli-version>/`.

## 4. Documentation review (Platform)

- [ ] `README.md`: commands, quick start and security model match the release.
- [ ] [installation.md](installation.md), [runbook.md](runbook.md), [backup-restore.md](backup-restore.md),
      [upgrade-rollback.md](upgrade-rollback.md), [secrets.md](secrets.md), [retention.md](retention.md)
      and [troubleshooting.md](troubleshooting.md) are current: new variables, secrets, migrations and
      procedures are covered.
- [ ] `docs/known-issues.md` is reviewed. Every open issue has a workaround.
- [ ] The release notes list configuration changes, new migrations (forward only) and the rollback point.

## 5. Rollout

- [ ] Pre-upgrade backup taken, copied off the host, and restore verified ([backup-restore.md](backup-restore.md#restore-verification-do-this-regularly)).
      Record the measured restore time (RTO): ______.
- [ ] `ORC_IMAGE_TAG` and `APP_VERSION` set to the release version. The previous tag is kept for rollback.
- [ ] Upgrade done ([upgrade-rollback.md](upgrade-rollback.md#upgrade-procedure)). All services are
      healthy, and **System** shows the new version on every worker.
- [ ] A smoke task completes on production with the real CLI.

Sign-off: release ______ · date ______ · Platform ______ · Security ______ · QA ______
