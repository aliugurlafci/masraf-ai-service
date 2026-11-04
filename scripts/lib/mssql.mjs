// sqlcmd inside the running `mssql` compose service (contract §19, ADR-0026). SQL text and the
// password travel over stdin, never argv or the container environment. Inside the container
// sqlcmd connects to localhost, so -C (trust the certificate whose SAN is `mssql`) is limited to
// the loopback hop; every network client verifies the private CA instead.
import { CliError, runChecked } from './common.mjs';

export const MSSQL_SERVICE = 'mssql';
export const BACKUP_DIR = '/var/opt/mssql/backups';
const SQLCMD = '/opt/mssql-tools18/bin/sqlcmd';
const SQLCMD_FLAGS = ['-S', 'localhost', '-C', '-b', '-I', '-h', '-1', '-W', '-l', '15'];

/** Backup file names the scripts create or accept inside BACKUP_DIR. */
export const BACKUP_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.bak$/;

function quoteSh(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs `sql` as `login`. With login `sa` the password is read inside the container from the
 * compose secret; any other login needs `password` (sent as the first stdin line).
 */
export function sqlcmd(compose, { login, password, sql, what }) {
  const flags = [...SQLCMD_FLAGS, '-U', login].map(quoteSh).join(' ');
  let script;
  let input;
  if (login === 'sa') {
    script = `SQLCMDPASSWORD="$(cat /run/secrets/mssql_sa_password)"; export SQLCMDPASSWORD; exec ${SQLCMD} ${flags}`;
    input = sql;
  } else {
    if (typeof password !== 'string' || password.length === 0 || /[\r\n]/.test(password)) {
      throw new CliError(`invalid password for ${login}`);
    }
    script = `IFS= read -r SQLCMDPASSWORD; export SQLCMDPASSWORD; exec ${SQLCMD} ${flags}`;
    input = `${password}\n${sql}`;
  }
  const result = runChecked(
    'docker',
    [...compose, 'exec', '-T', MSSQL_SERVICE, '/bin/bash', '-ec', script],
    { input, what: what ?? `sqlcmd as ${login}` },
  );
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

/** N'...' literal for values already validated by a strict pattern (defence in depth). */
export function nLiteral(value) {
  return `N'${value.replace(/'/g, "''")}'`;
}
