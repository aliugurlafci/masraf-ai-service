#!/usr/bin/env node
// Full SQL Server backup of the application database (contract §4.2 `orc_backup`, §16.5, §19).
//
//   node scripts/backup.mjs [--database <name>] [--out <host dir>] [--secrets-dir <dir>]
//        [--compose-file <file>]... [--project-name <name>]
//   node scripts/backup.mjs --list
//
// Runs `BACKUP DATABASE ... WITH CHECKSUM` through sqlcmd inside the running `mssql` service as
// the least-privileged login orc_backup (db_backupoperator); its password is read from
// <secrets dir>/db_backup_password.txt and handed to sqlcmd over stdin. The backup lands in the
// mssql-backups volume (/var/opt/mssql/backups); --out additionally copies it to a host
// directory. Redis holds only queue state that is rebuilt from MSSQL (§6) and is not backed up.
// Restore: scripts/restore.mjs.
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  COMPOSE_OPTIONS,
  CliError,
  REPO_ROOT,
  assertDbName,
  assertServiceRunning,
  composeArgs,
  fileTimestamp,
  readSecretFile,
  resolveSecretsDir,
  runChecked,
  runCli,
} from './lib/common.mjs';
import { BACKUP_DIR, MSSQL_SERVICE, nLiteral, sqlcmd } from './lib/mssql.mjs';

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')));
  });
}

export function listBackups(compose) {
  const result = runChecked(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      MSSQL_SERVICE,
      'find',
      BACKUP_DIR,
      '-maxdepth',
      '1',
      '-type',
      'f',
      '-name',
      '*.bak',
      '-printf',
      '%TY-%Tm-%TdT%TH:%TM:%.2TSZ %s %f\n',
    ],
    { what: 'listing backups' },
  );
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .sort();
}

async function main() {
  const { values } = parseArgs({
    options: {
      ...COMPOSE_OPTIONS,
      database: { type: 'string' },
      out: { type: 'string' },
      'secrets-dir': { type: 'string' },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      'usage: node scripts/backup.mjs [--database <name>] [--out <host dir>] [--secrets-dir <dir>]\n' +
        '         [--compose-file <file>]... [--project-name <name>]\n' +
        '       node scripts/backup.mjs --list',
    );
    return;
  }
  const compose = composeArgs(values);
  assertServiceRunning(compose, MSSQL_SERVICE);
  if (values.list) {
    const lines = listBackups(compose);
    console.log(lines.length > 0 ? lines.join('\n') : `no backups in ${BACKUP_DIR}`);
    return;
  }

  const database = assertDbName(values.database ?? process.env.DB_NAME ?? 'orchestrator');
  const password = readSecretFile(
    join(resolveSecretsDir(values['secrets-dir']), 'db_backup_password.txt'),
  );
  const stamp = fileTimestamp();
  const fileName = `${database}-${stamp}.bak`;
  const containerPath = `${BACKUP_DIR}/${fileName}`;

  // COMPRESSION is not used: SQL Server Express (the default MSSQL_PID) does not support it.
  const sql = [
    'SET NOCOUNT ON;',
    `IF DB_ID(${nLiteral(database)}) IS NULL THROW 50010, N'database ${database} does not exist', 1;`,
    `BACKUP DATABASE [${database}] TO DISK = ${nLiteral(containerPath)}`,
    `  WITH INIT, CHECKSUM, NAME = ${nLiteral(`${database} full ${stamp}`)}, STATS = 25;`,
    'GO',
    '',
  ].join('\n');

  console.log(`backing up ${database} to ${MSSQL_SERVICE}:${containerPath} as orc_backup ...`);
  const output = sqlcmd(compose, { login: 'orc_backup', password, sql, what: 'BACKUP DATABASE' });
  for (const line of output) console.log(`  ${line}`);
  const listed = listBackups(compose).find((line) => line.endsWith(` ${fileName}`));
  if (!listed) throw new CliError(`backup file ${containerPath} not found after BACKUP DATABASE`);
  console.log(`backup written: ${listed}`);

  if (values.out) {
    const outDir = isAbsolute(values.out) ? values.out : resolve(REPO_ROOT, values.out);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const target = join(outDir, fileName);
    runChecked('docker', [...compose, 'cp', `${MSSQL_SERVICE}:${containerPath}`, target], {
      what: 'docker compose cp',
    });
    const size = statSync(target).size;
    console.log(`copied to ${target} (${size} bytes, sha256 ${await sha256File(target)})`);
  }
  console.log(`restore with: node scripts/restore.mjs --from ${fileName} [--database <target>]`);
}

runCli(main);
