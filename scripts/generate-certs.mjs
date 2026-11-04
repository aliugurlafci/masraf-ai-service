#!/usr/bin/env node
// Private CAs and TLS certificates for the compose stack (contract §19, ADR-0025, ADR-0026).
//
//   node scripts/generate-certs.mjs [--dir <secrets dir>] [--only web|db] [--force]
//        [--web-server-name <host>] [--san <dns-or-ip>]... [--image <image with openssl>]
//
// web set: web_ca_cert.pem / web_ca_key.pem (local CA; import web_ca_cert.pem into the browser
//          trust store) and web_tls_cert.pem / web_tls_key.pem (EC P-256, SAN localhost,
//          127.0.0.1 and WEB_SERVER_NAME) for nginx on 8443.
// db set:  db_ca_cert.pem / db_ca_key.pem (private CA trusted by api, worker, db-bootstrap and
//          migrator via DB_CA_CERT_FILE) and mssql_tls_cert.pem / mssql_tls_key.pem (RSA 3072,
//          SAN mssql) loaded by SQL Server through docker/mssql/mssql.conf.
//
// openssl runs inside an already-pulled image (default: the stack's own SQL Server image, which
// ships OpenSSL 3) with no network, a read-only root, all capabilities dropped and an unprivileged
// uid; key material leaves the container only through its stdout pipe. A complete existing set is
// kept; a partial set or --force regenerates it. Files: 0644 inside a 0700 directory (POSIX) so
// the container users (node 1000, mssql 10001, nginx 101) can read their mounts; CA keys 0600.
import { X509Certificate, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CliError, resolveSecretsDir, run, runCli } from './lib/common.mjs';

export const DEFAULT_OPENSSL_IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest';
const CA_DAYS = 3650;
/** <= 825 days: the longest validity Apple platforms accept for TLS server certificates. */
const LEAF_DAYS = 825;
const HOST_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export const CERT_SETS = {
  web: {
    files: {
      caCert: 'web_ca_cert.pem',
      caKey: 'web_ca_key.pem',
      cert: 'web_tls_cert.pem',
      key: 'web_tls_key.pem',
    },
    caName: 'Orc local web CA',
    keyAlg: 'ec',
  },
  db: {
    files: {
      caCert: 'db_ca_cert.pem',
      caKey: 'db_ca_key.pem',
      cert: 'mssql_tls_cert.pem',
      key: 'mssql_tls_key.pem',
    },
    caName: 'Orc private SQL Server CA',
    // RSA: the certificate type SQL Server on Linux documents for tlscert/tlskey.
    keyAlg: 'rsa',
  },
};

/** Normalizes a SAN entry to openssl syntax (`DNS:name` / `IP:addr`); throws on anything else. */
export function toSan(value) {
  const v = String(value).trim();
  if (isIP(v) !== 0) return `IP:${v}`;
  if (HOST_NAME.test(v)) return `DNS:${v.toLowerCase()}`;
  throw new CliError(`invalid certificate name "${v}" (expected a DNS name or an IP address)`);
}

function caConfig(commonName) {
  return [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    'x509_extensions = v3_ca',
    '[dn]',
    `CN = ${commonName}`,
    '[v3_ca]',
    'basicConstraints = critical,CA:TRUE,pathlen:0',
    'keyUsage = critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid:always',
    '',
  ].join('\n');
}

function leafConfig(commonName, sans, keyAlg) {
  return [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    '[dn]',
    `CN = ${commonName}`,
    '[v3_leaf]',
    'basicConstraints = critical,CA:FALSE',
    `keyUsage = critical,${keyAlg === 'rsa' ? 'digitalSignature,keyEncipherment' : 'digitalSignature'}`,
    'extendedKeyUsage = serverAuth',
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid,issuer',
    `subjectAltName = ${sans.join(',')}`,
    '',
  ].join('\n');
}

// POSIX sh, runs in /work (tmpfs): reads $CA_CNF, $LEAF_CNF and $KEYALG and prints the four PEM
// files framed as "-----ORC-FILE <part>-----" followed by one base64 line each.
const OPENSSL_SCRIPT = `
set -eu
umask 077
cd /work
genkey() {
  if [ "$KEYALG" = ec ]; then
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve -out "$1"
  else
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$1"
  fi
}
emit() {
  printf -- '-----ORC-FILE %s-----\\n' "$1"
  base64 -w0 "$2"
  printf '\\n'
}
printf '%s\\n' "$CA_CNF" > ca.cnf
printf '%s\\n' "$LEAF_CNF" > leaf.cnf
genkey ca.key
openssl req -new -x509 -config ca.cnf -key ca.key -sha256 -days "$CA_DAYS" -set_serial "0x$(openssl rand -hex 16)" -out ca.crt
genkey leaf.key
openssl req -new -config leaf.cnf -key leaf.key -out leaf.csr
openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -set_serial "0x$(openssl rand -hex 16)" -days "$LEAF_DAYS" -sha256 -extfile leaf.cnf -extensions v3_leaf -out leaf.crt
emit caCert ca.crt
emit caKey ca.key
emit cert leaf.crt
emit key leaf.key
`;

function parseFramedOutput(stdout) {
  const files = new Map();
  const lines = stdout.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^-----ORC-FILE ([A-Za-z]+)-----$/.exec(lines[i] ?? '');
    if (match) {
      files.set(match[1], Buffer.from(lines[i + 1] ?? '', 'base64').toString('utf8'));
      i += 1;
    }
  }
  return files;
}

function runOpenssl(image, env) {
  const args = [
    'run',
    '--rm',
    '--pull',
    'never',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/work:rw,noexec,nosuid,nodev,size=16m,mode=1777',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--user',
    '65534:65534',
    '--workdir',
    '/work',
    '--entrypoint',
    '/bin/sh',
  ];
  const childEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    // `-e NAME` (without =value) copies the value from the docker CLI's environment, which keeps
    // multi-line configuration text out of argv.
    args.push('-e', key);
    childEnv[key] = value;
  }
  args.push(image, '-c', OPENSSL_SCRIPT);
  const result = run('docker', args, { env: childEnv });
  if (result.status !== 0) {
    const stderr = String(result.stderr).trim();
    if (/No such image|pull access denied|not found/i.test(stderr)) {
      throw new CliError(
        `image ${image} is not available locally; run "docker pull ${image}" or pass --image <image with openssl>`,
      );
    }
    throw new CliError(
      `openssl in ${image} failed (exit ${result.status}): ${stderr.split('\n').slice(-10).join('\n')}`,
    );
  }
  const files = parseFramedOutput(String(result.stdout));
  for (const part of ['caCert', 'caKey', 'cert', 'key']) {
    if (!files.has(part)) throw new CliError(`openssl output is missing ${part}`);
  }
  return files;
}

/** Validates a generated or existing set with Node's X.509 parser. Returns warnings. */
export function inspectSet(caPem, certPem, names) {
  const ca = new X509Certificate(caPem);
  const cert = new X509Certificate(certPem);
  const warnings = [];
  if (!ca.ca) warnings.push('CA certificate is not a CA');
  if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey))
    warnings.push('certificate is not signed by the CA');
  for (const name of names) {
    const [type, value] = [name.slice(0, name.indexOf(':')), name.slice(name.indexOf(':') + 1)];
    const ok =
      type === 'IP' ? cert.checkIP(value) !== undefined : cert.checkHost(value) !== undefined;
    if (!ok) warnings.push(`certificate does not cover ${value}`);
  }
  const daysLeft = Math.floor((new Date(cert.validTo).getTime() - Date.now()) / 86_400_000);
  if (daysLeft < 30) warnings.push(`certificate expires in ${daysLeft} days (${cert.validTo})`);
  return { warnings, validTo: cert.validTo, fingerprint256: cert.fingerprint256 };
}

function writeAtomic(path, content, mode) {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, content, { mode, flag: 'wx' });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/**
 * Generates the requested certificate sets into `dir`. Options: only ('web'|'db'|undefined),
 * force, webServerName, extraSans (string[]), image, log (function).
 */
export function generateCerts(options) {
  const dir = options.dir;
  const log = options.log ?? ((line) => console.log(line));
  const image = options.image ?? process.env.ORC_OPENSSL_IMAGE ?? DEFAULT_OPENSSL_IMAGE;
  const webServerName = options.webServerName ?? process.env.WEB_SERVER_NAME ?? 'localhost';
  const webSans = [
    ...new Set([
      'DNS:localhost',
      'IP:127.0.0.1',
      toSan(webServerName),
      ...(options.extraSans ?? []).map(toSan),
    ]),
  ];
  const webCn = isIP(webServerName) !== 0 ? webServerName : webServerName.toLowerCase();
  const sans = { web: webSans, db: ['DNS:mssql'] };
  const commonNames = { web: webCn, db: 'mssql' };

  const requested = options.only ? [options.only] : ['web', 'db'];
  for (const set of requested) {
    if (!(set in CERT_SETS)) throw new CliError(`unknown certificate set "${set}" (web or db)`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);

  const toGenerate = [];
  for (const set of requested) {
    const files = Object.values(CERT_SETS[set].files);
    const present = files.filter((f) => existsSync(join(dir, f)));
    if (present.length === files.length && !options.force) {
      const { caCert, cert } = CERT_SETS[set].files;
      const info = inspectSet(
        readFileSync(join(dir, caCert)),
        readFileSync(join(dir, cert)),
        sans[set],
      );
      log(`kept      ${set} certificates (valid until ${info.validTo})`);
      for (const w of info.warnings) log(`  warning: ${w}; regenerate with --only ${set} --force`);
      continue;
    }
    if (present.length > 0 && !options.force) {
      throw new CliError(
        `incomplete ${set} certificate set in ${dir} (found ${present.join(', ')}); pass --only ${set} --force to regenerate it`,
      );
    }
    toGenerate.push(set);
  }
  if (toGenerate.length === 0) return { generated: [] };

  for (const set of toGenerate) {
    const output = runOpenssl(image, {
      CA_DAYS: String(CA_DAYS),
      LEAF_DAYS: String(LEAF_DAYS),
      KEYALG: CERT_SETS[set].keyAlg,
      CA_CNF: caConfig(CERT_SETS[set].caName),
      LEAF_CNF: leafConfig(commonNames[set], sans[set], CERT_SETS[set].keyAlg),
    });
    const info = inspectSet(output.get('caCert'), output.get('cert'), sans[set]);
    if (info.warnings.length > 0)
      throw new CliError(
        `generated ${set} certificates failed validation: ${info.warnings.join('; ')}`,
      );
    const files = CERT_SETS[set].files;
    writeAtomic(join(dir, files.caKey), output.get('caKey'), 0o600);
    writeAtomic(join(dir, files.caCert), output.get('caCert'), 0o644);
    writeAtomic(join(dir, files.key), output.get('key'), 0o644);
    writeAtomic(join(dir, files.cert), output.get('cert'), 0o644);
    log(`generated ${set} certificates: ${sans[set].join(', ')} (valid until ${info.validTo})`);
    log(`          SHA-256 ${info.fingerprint256}`);
  }
  if (toGenerate.includes('web')) {
    log(
      `import ${join(dir, CERT_SETS.web.files.caCert)} into the browser/OS trust store to trust https://${webServerName}:8443`,
    );
  }
  if (toGenerate.includes('db')) {
    log(
      'restart mssql and its clients to load new database certificates (docker compose up -d --force-recreate)',
    );
  }
  return { generated: toGenerate };
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      only: { type: 'string' },
      force: { type: 'boolean', default: false },
      'web-server-name': { type: 'string' },
      san: { type: 'string', multiple: true },
      image: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      'usage: node scripts/generate-certs.mjs [--dir <secrets dir>] [--only web|db] [--force]\n' +
        '         [--web-server-name <host>] [--san <dns-or-ip>]... [--image <image with openssl>]',
    );
    return;
  }
  const dir = resolveSecretsDir(values.dir);
  generateCerts({
    dir,
    only: values.only,
    force: values.force,
    webServerName: values['web-server-name'],
    extraSans: values.san,
    image: values.image,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli(main);
