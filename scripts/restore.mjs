#!/usr/bin/env node
// Restores a full backup made by scripts/backup.mjs (contract §4.2: RESTORE requires sa and is an
// operator procedure).
//
//   node scripts/restore.mjs --from <file.bak in the mssql-backups volume | host path>
//        [--database <target>] [--force] [--no-restart]
//        [--compose-file <file>]... [--project-name <name>]
//
// Target defaults to the live database (DB_NAME or "orchestrator"). Restoring over the live
// database needs --force: api and worker are stopped, the database is set SINGLE_USER, restored
// WITH REPLACE onto its current files, the users orc_migrator/orc_api/orc_worker/orc_backup are
// re-mapped to their logins (backups from another server), and the stopped services are started
// again with `docker compose up -d` (which re-runs db-bootstrap and the migrator first). Any other
// target (for example the scratch database orchestrator_restore_check) is restored next to the
// live one under new file names; an existing target is replaced only with --force.
// sqlcmd runs as sa inside the mssql container with the password from its own compose secret.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import {
  COMPOSE_OPTIONS,
  CliError,
  assertDbName,
  assertServiceRunning,
  composeArgs,
  fileTimestamp,
  runChecked,
  runCli,
  runWithStdinStream,
} from './lib/common.mjs';
import { BACKUP_DIR, BACKUP_FILE_PATTERN, MSSQL_SERVICE, nLiteral, sqlcmd } from './lib/mssql.mjs';

const APP_LOGINS = ['orc_migrator', 'orc_api', 'orc_worker', 'orc_backup'];
const APP_SERVICES = ['api', 'worker'];
const COUNTED_TABLES = ['Tasks', 'TaskLogs', 'AuditLogs'];

/** T-SQL that restores `disk` into `target`; identifiers are pre-validated, values bound. */
export function buildRestoreSql({ target, disk, replace, inPlace }) {
  const t = `[${target}]`;
  const remap = APP_LOGINS.map(
    (login) =>
      `IF SUSER_ID(N'${login}') IS NOT NULL AND EXISTS (SELECT 1 FROM ${t}.sys.database_principals WHERE name = N'${login}')\n` +
      `  EXEC (N'USE ${t}; ALTER USER [${login}] WITH LOGIN = [${login}];');`,
  ).join('\n');
  return [
    'SET NOCOUNT ON;',
    'SET XACT_ABORT ON;',
    `DECLARE @target sysname = ${nLiteral(target)};`,
    `DECLARE @disk nvarchar(4000) = ${nLiteral(disk)};`,
    `DECLARE @replace bit = ${replace ? 1 : 0};`,
    'IF DB_ID(@target) IS NOT NULL AND @replace = 0',
    "  THROW 50020, N'target database exists; pass --force to replace it', 1;",
    'DECLARE @files TABLE (LogicalName nvarchar(128), PhysicalName nvarchar(260), Type char(1),',
    '  FileGroupName nvarchar(128), Size numeric(20,0), MaxSize numeric(20,0), FileId bigint,',
    '  CreateLSN numeric(25,0), DropLSN numeric(25,0), UniqueId uniqueidentifier,',
    '  ReadOnlyLSN numeric(25,0), ReadWriteLSN numeric(25,0), BackupSizeInBytes bigint,',
    '  SourceBlockSize int, FileGroupId int, LogGroupGUID uniqueidentifier,',
    '  DifferentialBaseLSN numeric(25,0), DifferentialBaseGUID uniqueidentifier, IsReadOnly bit,',
    '  IsPresent bit, TDEThumbprint varbinary(32), SnapshotUrl nvarchar(360));',
    "INSERT INTO @files EXEC sys.sp_executesql N'RESTORE FILELISTONLY FROM DISK = @d', N'@d nvarchar(4000)', @d = @disk;",
    "IF NOT EXISTS (SELECT 1 FROM @files) THROW 50021, N'backup contains no files', 1;",
    "DECLARE @dataDir nvarchar(4000) = CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(4000));",
    "DECLARE @logDir nvarchar(4000) = CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(4000));",
    "IF RIGHT(@dataDir, 1) <> N'/' SET @dataDir += N'/';",
    "IF RIGHT(@logDir, 1) <> N'/' SET @logDir += N'/';",
    // Files of an existing target are reused (in-place restore); new targets get <target>_<id>.*.
    'DECLARE @move nvarchar(max) = (',
    "  SELECT STRING_AGG(CAST(N', MOVE N''' + REPLACE(f.LogicalName, N'''', N'''''') + N''' TO N''' +",
    '    REPLACE(COALESCE(mf.physical_name,',
    "      CASE WHEN f.Type = 'L' THEN @logDir ELSE @dataDir END + @target + N'_' + CAST(f.FileId AS nvarchar(20)) +",
    "      CASE WHEN f.Type = 'L' THEN N'.ldf' WHEN f.FileId = 1 THEN N'.mdf' ELSE N'.ndf' END),",
    "      N'''', N'''''') + N'''' AS nvarchar(max)), N'') WITHIN GROUP (ORDER BY f.FileId)",
    '  FROM @files AS f',
    '  LEFT JOIN sys.master_files AS mf ON mf.database_id = DB_ID(@target) AND mf.file_id = f.FileId);',
    `DECLARE @sql nvarchar(max) = N'RESTORE DATABASE ' + QUOTENAME(@target) + N' FROM DISK = @d WITH CHECKSUM, RECOVERY, STATS = 25' +`,
    "  CASE WHEN @replace = 1 THEN N', REPLACE' ELSE N'' END + @move + N';';",
    "DECLARE @singleUser nvarchar(400) = N'ALTER DATABASE ' + QUOTENAME(@target) + N' SET SINGLE_USER WITH ROLLBACK IMMEDIATE;';",
    "DECLARE @multiUser nvarchar(400) = N'ALTER DATABASE ' + QUOTENAME(@target) + N' SET MULTI_USER;';",
    'BEGIN TRY',
    '  IF DB_ID(@target) IS NOT NULL EXEC sys.sp_executesql @singleUser;',
    "  EXEC sys.sp_executesql @sql, N'@d nvarchar(4000)', @d = @disk;",
    'END TRY',
    'BEGIN CATCH',
    "  IF DB_ID(@target) IS NOT NULL AND DATABASEPROPERTYEX(@target, 'Status') = N'ONLINE'",
    '    EXEC sys.sp_executesql @multiUser;',
    '  THROW;',
    'END CATCH;',
    'EXEC sys.sp_executesql @multiUser;',
    'GO',
    ...(inPlace ? [remap, 'GO'] : []),
    ...COUNTED_TABLES.map(
      (table) =>
        `IF OBJECT_ID(N'${t}.dbo.[${table}]', N'U') IS NOT NULL\n` +
        `  EXEC (N'SELECT CONCAT(N''rows ${table}='', COUNT_BIG(*)) FROM ${t}.dbo.[${table}];');`,
    ),
    'GO',
    '',
  ].join('\n');
}

async function uploadBackup(compose, hostPath) {
  if (!statSync(hostPath).isFile()) throw new CliError(`${hostPath} is not a file`);
  const base = basename(hostPath);
  const name = BACKUP_FILE_PATTERN.test(base)
    ? `restore-${fileTimestamp()}-${base}`
    : `restore-${fileTimestamp()}.bak`;
  const containerPath = `${BACKUP_DIR}/${name}`;
  console.log(`uploading ${hostPath} to ${MSSQL_SERVICE}:${containerPath} ...`);
  // Written by the mssql user itself, so SQL Server can read it regardless of host permissions.
  await runWithStdinStream(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      MSSQL_SERVICE,
      '/bin/sh',
      '-ec',
      'umask 077; cat > "$1"',
      'sh',
      containerPath,
    ],
    createReadStream(hostPath),
    { what: 'upload' },
  );
  return containerPath;
}

async function main() {
  const { values } = parseArgs({
    options: {
      ...COMPOSE_OPTIONS,
      from: { type: 'string' },
      database: { type: 'string' },
      'live-database': { type: 'string' },
      force: { type: 'boolean', default: false },
      'no-restart': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help || !values.from) {
    console.log(
      'usage: node scripts/restore.mjs --from <backup.bak | host path> [--database <target>] [--force] [--no-restart]\n' +
        '         [--compose-file <file>]... [--project-name <name>]\n' +
        '       (list backups: node scripts/backup.mjs --list)',
    );
    if (!values.help) process.exitCode = 2;
    return;
  }
  const compose = composeArgs(values);
  const running = assertServiceRunning(compose, MSSQL_SERVICE);
  const live = assertDbName(
    values['live-database'] ?? process.env.DB_NAME ?? 'orchestrator',
    'live database',
  );
  const target = assertDbName(values.database ?? live, 'target database');
  const inPlace = target.toLowerCase() === live.toLowerCase();
  if (inPlace && !values.force) {
    throw new CliError(
      `restoring over the live database ${live} replaces all its data; pass --force`,
    );
  }

  let disk;
  if (BACKUP_FILE_PATTERN.test(values.from) && !existsSync(values.from)) {
    disk = `${BACKUP_DIR}/${values.from}`;
  } else if (existsSync(values.from)) {
    disk = await uploadBackup(compose, values.from);
  } else {
    throw new CliError(
      `${values.from} is neither a host file nor a backup name (${BACKUP_FILE_PATTERN.source})`,
    );
  }

  const stopped = inPlace ? APP_SERVICES.filter((s) => running.includes(s)) : [];
  if (stopped.length > 0) {
    console.log(`stopping ${stopped.join(', ')} ...`);
    runChecked('docker', [...compose, 'stop', ...stopped], {
      what: 'docker compose stop',
      inherit: true,
    });
  }
  console.log(`restoring ${disk} into ${target}${values.force ? ' (replace)' : ''} as sa ...`);
  try {
    const output = sqlcmd(compose, {
      login: 'sa',
      sql: buildRestoreSql({ target, disk, replace: values.force, inPlace }),
      what: 'RESTORE DATABASE',
    });
    for (const line of output) console.log(`  ${line}`);
  } finally {
    if (stopped.length > 0 && !values['no-restart']) {
      console.log(`starting ${stopped.join(', ')} (db-bootstrap and migrator run first) ...`);
      runChecked('docker', [...compose, 'up', '-d', ...stopped], {
        what: 'docker compose up',
        inherit: true,
      });
    }
  }
  console.log(`restore of ${target} completed`);
}

runCli(main);
