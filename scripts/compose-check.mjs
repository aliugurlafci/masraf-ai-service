#!/usr/bin/env node
// Preflight for `npm run compose:config` / `compose:up`: renders docker-compose.yml (docker compose
// config) and checks that every file-based secret it references exists, is non-empty and matches
// the value rule its service enforces at startup, that the PEM files parse and that each server certificate is issued by its CA (ADR-0025, ADR-0026).
// `docker compose config` alone does not look at secret files, and `up` would fail late.
//
//   node scripts/compose-check.mjs [--compose-file <file>]... [--project-name <name>] [--profile <p>]...
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  COMPOSE_OPTIONS,
  CliError,
  composeArgs,
  readSecretFile,
  runChecked,
  runCli,
} from './lib/common.mjs';
import { SQL_LOGIN_PASSWORD_REGEX } from './generate-secrets.mjs';
import { credentialPermissionWarnings, evaluateCredentials } from './lib/claude-credentials.mjs';

/** Credential files may be empty (0 bytes = not configured); evaluateCredentials() checks them as a pair. */
const CREDENTIAL_SECRETS = ['claude_oauth_token', 'anthropic_api_key'];

/** Value rules the services enforce at startup (§4.2, §16), checked here so `up` fails early. */
const PROXY_TOKEN_REGEX = /^[A-Za-z0-9_-]{24,256}$/;
const VALUE_RULES = {
  mssql_sa_password: { pattern: SQL_LOGIN_PASSWORD_REGEX, rule: 'SQL_LOGIN_PASSWORD_REGEX' },
  db_migrator_password: { pattern: SQL_LOGIN_PASSWORD_REGEX, rule: 'SQL_LOGIN_PASSWORD_REGEX' },
  db_api_password: { pattern: SQL_LOGIN_PASSWORD_REGEX, rule: 'SQL_LOGIN_PASSWORD_REGEX' },
  db_worker_password: { pattern: SQL_LOGIN_PASSWORD_REGEX, rule: 'SQL_LOGIN_PASSWORD_REGEX' },
  db_backup_password: { pattern: SQL_LOGIN_PASSWORD_REGEX, rule: 'SQL_LOGIN_PASSWORD_REGEX' },
  egress_proxy_token: { pattern: PROXY_TOKEN_REGEX, rule: '/^[A-Za-z0-9_-]{24,256}$/' },
  // Written into redis.conf as `requirepass <value>`: one printable token without whitespace.
  redis_password: { pattern: /^[\x21-\x7e]{16,512}$/, rule: '16-512 printable characters' },
};

const CERT_PAIRS = [
  { ca: 'db_ca_cert', cert: 'mssql_tls_cert', key: 'mssql_tls_key', host: 'mssql' },
  { ca: null, cert: 'web_tls_cert', key: 'web_tls_key', host: null },
];

async function main() {
  const { values } = parseArgs({
    options: { ...COMPOSE_OPTIONS, profile: { type: 'string', multiple: true } },
    strict: true,
  });
  const compose = composeArgs(values);
  for (const profile of values.profile ?? []) compose.push('--profile', profile);
  const rendered = runChecked('docker', [...compose, 'config', '--format', 'json'], {
    what: 'docker compose config',
  });
  const config = JSON.parse(rendered.stdout);

  const problems = [];
  const warnings = [];
  const files = new Map();
  const credentialFiles = new Map();
  for (const [name, secret] of Object.entries(config.secrets ?? {})) {
    if (typeof secret.file !== 'string') continue;
    if (!existsSync(secret.file) || !statSync(secret.file).isFile()) {
      problems.push(`secret ${name}: ${secret.file} does not exist`);
    } else if (CREDENTIAL_SECRETS.includes(name)) {
      credentialFiles.set(name, secret.file);
      warnings.push(...credentialPermissionWarnings(name, statSync(secret.file)));
    } else if (statSync(secret.file).size === 0) {
      problems.push(`secret ${name}: ${secret.file} is empty`);
    } else {
      files.set(name, secret.file);
      const rule = VALUE_RULES[name];
      // Only the rule is reported, never the value.
      if (rule && !rule.pattern.test(readSecretFile(secret.file))) {
        problems.push(`secret ${name}: ${secret.file} does not match ${rule.rule}`);
      }
      // Compose bind-mounts file secrets with their host mode; the containers run as other uids
      // (node 1000, redis 999, mssql 10001, nginx 101), hence 0644 inside the 0700 directory.
      if (process.platform !== 'win32' && (statSync(secret.file).mode & 0o004) === 0) {
        warnings.push(
          `secret ${name}: ${secret.file} is not world-readable; its container user may fail to read it (chmod 0644, keep the directory 0700)`,
        );
      }
    }
  }

  if (config.services?.worker) {
    const mode = String(config.services.worker.environment?.CLAUDE_AUTH_MODE ?? 'oauth');
    if (credentialFiles.size === CREDENTIAL_SECRETS.length) {
      const read = (name) => readSecretFile(credentialFiles.get(name));
      for (const problem of evaluateCredentials({
        mode,
        oauthToken: read('claude_oauth_token'),
        apiKey: read('anthropic_api_key'),
      })) {
        problems.push(`claude credentials (CLAUDE_AUTH_MODE=${mode}): ${problem}`);
      }
    } else {
      problems.push('claude credentials: the claude_oauth_token and anthropic_api_key secrets must both be defined');
    }
  }

  for (const pair of CERT_PAIRS) {
    if (!files.has(pair.cert) || !files.has(pair.key)) continue;
    try {
      const cert = new X509Certificate(readFileSync(files.get(pair.cert)));
      const key = createPrivateKey(readFileSync(files.get(pair.key)));
      if (!cert.checkPrivateKey(key)) problems.push(`${pair.key} does not belong to ${pair.cert}`);
      if (pair.host && cert.checkHost(pair.host) === undefined) {
        problems.push(`${pair.cert} does not cover host name ${pair.host}`);
      }
      if (pair.ca && files.has(pair.ca)) {
        const ca = new X509Certificate(readFileSync(files.get(pair.ca)));
        if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey)) {
          problems.push(`${pair.cert} is not issued by ${pair.ca}`);
        }
      }
      if (new Date(cert.validTo).getTime() < Date.now())
        problems.push(`${pair.cert} expired on ${cert.validTo}`);
    } catch (err) {
      problems.push(
        `${pair.cert}/${pair.key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (problems.length > 0) {
    throw new CliError(
      `compose preflight failed:\n  ${problems.join('\n  ')}\nrun npm run secrets:generate (see secrets/README.md)`,
    );
  }
  console.log(
    `compose preflight ok: ${Object.keys(config.services ?? {}).length} services, ${files.size} secret files`,
  );
}

runCli(main);
