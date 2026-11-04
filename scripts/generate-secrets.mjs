#!/usr/bin/env node
// Compose secrets for the production stack (contract §19, §16, ADR-0025, ADR-0026).
//
//   node scripts/generate-secrets.mjs [--dir <secrets dir>] [--force] [--only <name>[,<name>...]]
//        [--anthropic-api-key-stdin] [--skip-certs] [--web-server-name <host>] [--san <name>]...
//
// Writes <dir>/<name>.txt for every secret below (default dir: ORC_SECRETS_DIR or ./secrets) and
// then the TLS material of scripts/generate-certs.mjs. Existing files are never overwritten
// unless --force (all) or --only <names> --force (selected) is given.
//   SQL login passwords: 32 characters of SQL_LOGIN_PASSWORD_REGEX's alphabet with upper, lower,
//   digit and symbol (contract §4.2). Tokens: 43 base64url characters (256 bits).
//   anthropic_api_key.txt cannot be generated: it is taken from ANTHROPIC_API_KEY or, with
//   --anthropic-api-key-stdin, from the first line of stdin, and otherwise left for the operator.
import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CliError, resolveSecretsDir, runCli } from './lib/common.mjs';
import { generateCerts } from './generate-certs.mjs';

/** SQL_LOGIN_PASSWORD_REGEX (contract §4.2): no quote, bracket, backslash, `$` or whitespace. */
export const SQL_LOGIN_PASSWORD_REGEX = /^[A-Za-z0-9!#%*+,./:;=?@^_~-]{16,128}$/;
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const SYMBOLS = '!#%*+,./:;=?@^_~-';
const PASSWORD_ALPHABET = UPPER + LOWER + DIGITS + SYMBOLS;
export const TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/;

export const SECRETS = [
  { name: 'mssql_sa_password', kind: 'password' },
  { name: 'db_migrator_password', kind: 'password' },
  { name: 'db_api_password', kind: 'password' },
  { name: 'db_worker_password', kind: 'password' },
  { name: 'db_backup_password', kind: 'password' },
  { name: 'redis_password', kind: 'token' },
  { name: 'egress_proxy_token', kind: 'token' },
  { name: 'anthropic_api_key', kind: 'external' },
];

/** Uniformly random password of `length` characters containing every character class. */
export function generatePassword(length = 32) {
  for (;;) {
    let value = '';
    for (let i = 0; i < length; i += 1)
      value += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    const classes = [UPPER, LOWER, DIGITS, SYMBOLS].every((set) =>
      [...value].some((c) => set.includes(c)),
    );
    if (classes && SQL_LOGIN_PASSWORD_REGEX.test(value)) return value;
  }
}

/** 32 random bytes as 43 base64url characters (matches EGRESS_AUTH_TOKEN's /^[A-Za-z0-9_-]{24,256}$/). */
export function generateToken() {
  return randomBytes(32).toString('base64url');
}

function writeSecret(path, value) {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, value, { mode: 0o644, flag: 'wx' });
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}

function readFirstStdinLine() {
  let data;
  try {
    data = readFileSync(0, 'utf8');
  } catch {
    throw new CliError('--anthropic-api-key-stdin: stdin could not be read');
  }
  return data.split(/\r?\n/)[0]?.trim() ?? '';
}

function validateApiKey(value) {
  if (!/^[\x21-\x7e]{20,512}$/.test(value)) {
    throw new CliError(
      'the Anthropic API key must be 20-512 printable characters without whitespace',
    );
  }
  return value;
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      force: { type: 'boolean', default: false },
      only: { type: 'string' },
      'anthropic-api-key-stdin': { type: 'boolean', default: false },
      'skip-certs': { type: 'boolean', default: false },
      'web-server-name': { type: 'string' },
      san: { type: 'string', multiple: true },
      image: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      'usage: node scripts/generate-secrets.mjs [--dir <secrets dir>] [--force] [--only <name>[,<name>...]]\n' +
        '         [--anthropic-api-key-stdin] [--skip-certs] [--web-server-name <host>] [--san <name>]...\n' +
        `secrets: ${SECRETS.map((s) => s.name).join(', ')}; certificate sets (--only): web, db`,
    );
    return;
  }

  const dir = resolveSecretsDir(values.dir);
  const knownNames = new Set([...SECRETS.map((s) => s.name), 'web', 'db']);
  const only = values.only
    ? values.only
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : null;
  for (const name of only ?? []) {
    if (!knownNames.has(name))
      throw new CliError(`unknown secret "${name}" (known: ${[...knownNames].join(', ')})`);
  }
  const selected = (name) => only === null || only.includes(name);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  console.log(`secrets directory: ${dir}`);

  const apiKeyInput = values['anthropic-api-key-stdin']
    ? validateApiKey(readFirstStdinLine())
    : process.env.ANTHROPIC_API_KEY
      ? validateApiKey(process.env.ANTHROPIC_API_KEY.trim())
      : null;

  let missingApiKey = false;
  for (const secret of SECRETS) {
    if (!selected(secret.name)) continue;
    const path = join(dir, `${secret.name}.txt`);
    const exists = existsSync(path);
    if (exists && !values.force) {
      console.log(`kept      ${secret.name}.txt`);
      continue;
    }
    if (secret.kind === 'external') {
      if (apiKeyInput === null) {
        if (!exists) missingApiKey = true;
        else console.log(`kept      ${secret.name}.txt (no new key supplied)`);
        continue;
      }
      writeSecret(path, apiKeyInput);
    } else {
      writeSecret(path, secret.kind === 'password' ? generatePassword() : generateToken());
    }
    console.log(`${exists ? 'replaced ' : 'generated'} ${secret.name}.txt`);
    if (exists && secret.name === 'mssql_sa_password') {
      console.log(
        '  note: an existing mssql-data volume keeps the old sa password; change it with\n' +
          "  ALTER LOGIN sa WITH PASSWORD = '<new>' (sqlcmd in the mssql container) before restarting.",
      );
    }
    if (exists && /^db_(migrator|api|worker|backup)_password$/.test(secret.name)) {
      console.log(
        '  note: db-bootstrap applies rotated login passwords on the next `npm run compose:up`.',
      );
    }
  }

  if (!values['skip-certs']) {
    const certSets = ['web', 'db'].filter(selected);
    for (const set of certSets) {
      generateCerts({
        dir,
        only: set,
        force: values.force,
        webServerName: values['web-server-name'],
        extraSans: values.san,
        image: values.image,
      });
    }
  }

  if (missingApiKey) {
    console.log(
      `\nmissing   anthropic_api_key.txt: provide the key with\n` +
        `  node scripts/generate-secrets.mjs --only anthropic_api_key --anthropic-api-key-stdin < key-file\n` +
        `  (or write it to ${join(dir, 'anthropic_api_key.txt')}); npm run compose:up refuses to start without it.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli(main);
