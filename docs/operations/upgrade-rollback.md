# Upgrade and rollback

## Versioning

- `APP_VERSION` is baked into the images at build time (`x-build-args`) and reported by `/health` and
  `WorkerNodes.AppVersion`.
- `ORC_IMAGE_TAG` tags every image built by compose: `orc-api`, `orc-worker` (worker and runner),
  `orc-egress-proxy`, `orc-db-cli`, `orc-web` and `orc-mssql`. The default is `local`. For releases, use
  the release version so that the previous images remain available for rollback:

  ```bash
  ORC_IMAGE_TAG=1.3.0 APP_VERSION=1.3.0 npm run compose:up
  ```

  Put both variables in `.env` so that every later `docker compose` command uses the same tag.
- Third-party bases are pinned in `docker/Dockerfile` and `docker-compose.yml`: Node 24.18.0 bookworm-slim,
  nginx-unprivileged 1.29-alpine, redis 7.4-alpine, SQL Server 2022, Claude CLI 2.1.316 (npm integrity
  hash) and codebase-memory-mcp 0.12.0 (release `checksums.txt` and asset SHA-256).

## Database migrations: forward only

- Migrations (`packages/database`) are applied by the `migrator` one-shot on every `up`, under an applock.
  Each migration is recorded in `orc.SchemaMigrations` with its checksum.
- There are **no down migrations**. A changed or missing migration file stops the migrator with
  `MigrationChecksumError` (exit code 2), and nothing is applied.
- api and worker refuse readiness while the schema is older than the version they expect. An older
  image against a newer schema is therefore **not supported**. Roll back with a restore (below).

## Upgrade procedure

1. Read the release notes for configuration changes (contract §16) and new required secrets.
2. Make sure the release gates passed ([release-checklist.md](release-checklist.md)), including
   `npm run test:compose` on the release candidate.
3. Take a backup and copy it off the host:
   `node scripts/backup.mjs --out ./backups/pre-1.3.0`.
4. Record the current tag: `docker compose images` (or the `ORC_IMAGE_TAG` in `.env`).
5. Optional: drain the workers to avoid interrupted attempts. Wait until **Dashboard** shows no active
   tasks, then run `docker compose stop worker`. Interrupted attempts are recovered automatically in any
   case.
6. Upgrade:

   ```bash
   git fetch && git checkout v1.3.0
   npm ci
   ORC_IMAGE_TAG=1.3.0 APP_VERSION=1.3.0 npm run compose:up
   ```

   compose-check validates the secrets, the images are built, db-bootstrap and the migrator run, and then
   the services are recreated in dependency order.
7. Verify: `docker compose ps` shows everything healthy, `/health/ready` passes, **System** shows the new
   `appVersion` on every worker, and a small task completes.

## Rollback procedure

A rollback means **previous images plus a restore of the pre-upgrade backup**, because the migrations
cannot be reversed. Tasks created after the backup are lost; export what you need first.

```bash
git checkout v1.2.0 && npm ci
export ORC_IMAGE_TAG=1.2.0 APP_VERSION=1.2.0      # the restore script restarts api/worker with these
docker compose stop web api worker
node scripts/restore.mjs --from ./backups/pre-1.3.0/orchestrator-<stamp>.bak --force
docker compose stop redis && docker compose rm -f redis && docker volume rm orc_redis-data
npm run compose:up
```

- The restore stops api and worker, restores the database in place, re-maps the users, and starts the
  services again with the old tag. The old migrator sees exactly the schema it knows.
- Resetting Redis removes jobs of tasks that no longer exist. The reconciler re-enqueues the queued
  attempts of the restored data.
- If the upgrade applied **no** migration (the same `SchemaMigrations` version before and after), the
  restore is not needed. Run `ORC_IMAGE_TAG=1.2.0 npm run compose:up` instead.
- Verify as in step 7 of the upgrade procedure.

## Claude CLI pin upgrade

The worker image pins `@anthropic-ai/claude-code-linux-x64` and verifies its npm integrity. The worker
probes the CLI at startup and refuses to start if a required flag or permission mode is missing
(contract §10.9). To upgrade the pin:

1. Find the new version and its integrity:
   `npm view @anthropic-ai/claude-code-linux-x64@<version> dist.integrity`.
2. Update `CLAUDE_CODE_VERSION` and `CLAUDE_CODE_LINUX_X64_INTEGRITY` in `docker/Dockerfile`.
3. Check the CLI flags against contract §10.2/§10.9. If the help text changed, the owning team updates
   the fake CLI fixture (`tests/fixtures/fake-claude`, version string and help file).
4. Run the standard gates and `npm run test:compose`.
5. **Release gate (F2):** run `npm run test:claude-live -- permission-boundary` with the new CLI. Store the
   JUnit report and the masked transcript under `docs/operations/evidence/<cli-version>/`.
6. Roll out with a new `ORC_IMAGE_TAG`. To roll back, use the previous tag; no data migration is involved.

**Fail-closed on a CLI update (ADR-0036).** The runner validates Claude's `init` message against a table of
the extensions, memory paths and tools expected for the pinned version. A CLI that reports anything outside
the table makes the attempt end as `security_violation` (the process is killed). After a pin change,
`test:claude-live` (`probe-init`) must re-verify the table and the owning team updates it; do not roll out
a new pin without that. Rolling back to the previous tag restores the previous table.

**Upgrading from a release that used `CLAUDE_BARE` and the API key.** Remove `CLAUDE_BARE` from every `.env`
and override file (the worker fails at startup otherwise). To keep the API key, set `CLAUDE_AUTH_MODE=api_key`
and keep `anthropic_api_key.txt`; create the new empty `claude_oauth_token.txt` with
`node scripts/generate-secrets.mjs --only claude_oauth_token`. To move to the subscription token, follow
[secrets.md](secrets.md#switching-the-auth-mode). To roll back, use the previous image tag together with the
previous compose file.

## codebase-memory-mcp pin upgrade

1. Update `CBM_VERSION`, `CBM_ASSET`, `CBM_CHECKSUMS_SHA256` (SHA-256 of the release's `checksums.txt`) and
   `CBM_ASSET_SHA256` in `docker/Dockerfile`. The build verifies both.
2. Check the tool names and parameters against contract §12.2. The worker requires `REQUIRED_MCP_TOOLS`
   and reports a missing tool as an MCP error.
3. Run `tests/integration/mcp-manager/mcp-real.test.ts` with the new binary on `PATH`, then
   `npm run test:compose`.
4. After the rollout, re-index every project (**Index now**). Cached indexes from the old version are not
   guaranteed to be compatible.
5. To roll back, use the previous image tag and re-index again.

## Base image updates

Rebuild with `docker compose build --pull`, run the image CVE review
([runbook.md](runbook.md#image-cve-review-before-each-release-adr-0027)) and roll out as a normal upgrade.
SQL Server cumulative updates arrive with `mcr.microsoft.com/mssql/server:2022-latest`. Take a backup
first: SQL Server upgrades the database files on start, and that upgrade cannot be undone.
