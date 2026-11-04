# Backup and restore

## What is backed up

| Data | Where | Backup |
|---|---|---|
| Application database (`orchestrator`): users, projects, agents, tasks, attempts, logs, events, diffs, patches, test results, audit | `mssql-data` volume | **Full SQL Server backup** with `scripts/backup.mjs` |
| Queue state | `redis-data` volume | Not backed up. It is rebuilt from MSSQL by the `queued-reconciler`, and SSE replays from the DB. |
| Mirrors, worktrees, Claude homes, MCP indexes | `workspaces`, `claude-home`, `cbm-cache` volumes | Not backed up. These are caches: mirrors are fetched again from `projects/`, indexes are rebuilt, and the result of every task (diff, patch, tests) is stored in MSSQL. |
| Project repositories | `projects/` on the host (read-only to the stack) | Owned by you. Back them up with your normal git hosting. |
| Secrets | `./secrets` (or `ORC_SECRETS_DIR`) | Keep a protected offline copy. A restore on a new host works with new secrets because restore re-maps the database users. |

## Backup

```bash
npm run compose:backup -- --out ./backups
# same as: node scripts/backup.mjs --out ./backups [--database orchestrator]
```

- The script runs `BACKUP DATABASE [orchestrator] TO DISK = '/var/opt/mssql/backups/orchestrator-<UTC stamp>.bak'
  WITH INIT, CHECKSUM` through `sqlcmd` inside the `mssql` container. It connects as the
  least-privileged login `orc_backup` (`db_backupoperator`). The password goes in on stdin from
  `secrets/db_backup_password.txt`.
- The file is kept in the `mssql-backups` volume. `--out <dir>` also copies it to the host and prints its
  size and SHA-256. Store the copy off the host.
- `node scripts/backup.mjs --list` lists the backups in the volume.
- Options for non-default stacks: `--secrets-dir`, `--compose-file` (repeatable) and `--project-name`.
- Compression is not used, because SQL Server Express (the default `MSSQL_PID`) does not support it.

Schedule the backup on the host. Example for cron, daily at 02:00 UTC:

```cron
0 2 * * * cd /opt/orchestrator && /usr/bin/node scripts/backup.mjs --out /srv/orc-backups >> /var/log/orc-backup.log 2>&1
```

On Windows, use a Task Scheduler action: `node.exe scripts\backup.mjs --out D:\orc-backups`, starting in
the repository directory. Prune old files in the volume after they are copied off the host
([runbook.md](runbook.md#disk-and-workspace-pressure)).

## Restore verification (do this regularly)

A backup counts only once a restore of it has been tested. Restore it next to the live database, into the
scratch database `orchestrator_restore_check`:

```bash
node scripts/restore.mjs --from orchestrator-20261103T020000Z.bak --database orchestrator_restore_check --force
```

`--from` takes either a file name in the `mssql-backups` volume or a host path. A host file is uploaded
into the volume first. `--force` replaces a restore-check database left over from an earlier run. The
restore runs `RESTORE ... WITH CHECKSUM` as `sa` inside the mssql container, using the container's own
secret.

Compare the row counts of the restored database with the live one:

```bash
docker compose exec -T mssql /bin/bash -ec 'export SQLCMDPASSWORD="$(cat /run/secrets/mssql_sa_password)"; /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -b -h -1 -W' <<'SQL'
SET NOCOUNT ON;
SELECT 'live', (SELECT COUNT_BIG(*) FROM orchestrator.orc.Tasks), (SELECT COUNT_BIG(*) FROM orchestrator.orc.TaskLogs), (SELECT COUNT_BIG(*) FROM orchestrator.orc.AuditLogs);
SELECT 'restored', (SELECT COUNT_BIG(*) FROM orchestrator_restore_check.orc.Tasks), (SELECT COUNT_BIG(*) FROM orchestrator_restore_check.orc.TaskLogs), (SELECT COUNT_BIG(*) FROM orchestrator_restore_check.orc.AuditLogs);
SELECT TOP 1 'schema', Version FROM orchestrator_restore_check.orc.SchemaMigrations ORDER BY Version DESC;
GO
SQL
```

The restored counts must equal the live counts at the time of the backup. Rows written after the backup
appear only in the live database. Then drop the scratch database:

```bash
docker compose exec -T mssql /bin/bash -ec 'export SQLCMDPASSWORD="$(cat /run/secrets/mssql_sa_password)"; /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -b' <<'SQL'
ALTER DATABASE orchestrator_restore_check SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
DROP DATABASE orchestrator_restore_check;
GO
SQL
```

`npm run test:compose` runs exactly this procedure (backup, restore into `orchestrator_restore_check`,
row-count comparison of Tasks, TaskLogs and AuditLogs, drop) on every release candidate.

## Restore over the live database

1. Announce downtime. Running tasks are interrupted.
2. Run the restore:

   ```bash
   node scripts/restore.mjs --from orchestrator-20261103T020000Z.bak --force
   # or from a host copy: --from ./backups/orchestrator-20261103T020000Z.bak
   ```

   The script:
   1. Stops `api` and `worker`.
   2. Sets the database `SINGLE_USER` and restores it `WITH REPLACE` onto its current files.
   3. Re-maps the users `orc_migrator`, `orc_api`, `orc_worker` and `orc_backup` to their logins.
   4. Runs `docker compose up -d api worker`. db-bootstrap and the migrator run first, so the logins get
      the current secret passwords and any newer migrations are applied.

   `--no-restart` leaves the services stopped.
3. Optional, but recommended after a point-in-time rollback: reset the queue so that no job refers to a
   task that no longer exists. The reconciler re-enqueues every `queued` attempt of the restored data
   within about 60 s.

   ```bash
   docker compose stop redis && docker compose rm -f redis && docker volume rm orc_redis-data
   npm run compose:up
   ```

4. Verify: `/health/ready`, the **System** page, and a small task.

Effects of a restore:

- Tasks created after the backup are gone. Their worktrees stay in the `workspaces` volume until you
  remove them; they do not affect new tasks.
- Sessions are restored with the database. Users who logged in after the backup must log in again.

## Restore on a new host (disaster recovery)

1. Install the stack ([installation.md](installation.md)), with `secrets:generate` and `compose:up`. This
   creates an empty database.
2. Copy the backup file to the host.
3. Run `node scripts/restore.mjs --from /path/orchestrator-<stamp>.bak --force`.
4. Restore `projects/` from your git hosting, using the same directory names because `repoPath` is
   stored in the database. Then **Sync** each project.

## RPO and RTO

- **RPO** equals the backup interval. Only full backups are taken; there are no transaction log backups.
  The daily schedule above therefore loses up to 24 h of task history. Schedule `backup.mjs` hourly for
  a 1 h RPO; full backups of a database of a few GB take seconds to minutes.
- **RTO** is the restore time (roughly the time to copy and verify the backup file, with a checksum
  pass) plus the restart of api and worker (under 2 min) plus re-indexing on first use. Typical
  databases of 1-10 GB restore in under 15 min on local SSD storage. Measure your own value with the
  restore verification above and record it in the release checklist.
- Data that is not backed up (Redis, worktrees, indexes) is rebuilt automatically. It does not affect
  the RPO.
