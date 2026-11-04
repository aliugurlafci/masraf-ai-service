#!/usr/bin/env node
// Dependency scan gate (requirements §15, contract §18.1/§18.5, ADR-0027).
//
// Runs `npm audit --omit=dev --json --audit-level=critical` against the configured npm registry's
// advisory endpoint (the only external call of any test command; it sends package names and
// versions from the lockfile, never source code) and prints one JSON summary line on stdout.
//
// Exit codes: 0 = no critical finding (gate passed); 1 = at least one critical finding;
// 3 = audit UNAVAILABLE (network/registry error, timeout, unreadable report) - never a pass;
// 2 = usage error.
//
//   node scripts/dependency-audit.mjs [--input <npm-audit.json>] [--timeout-ms <n>]
//
// --input evaluates a saved `npm audit --json` report instead of calling the registry (offline
// review of a report produced elsewhere, and the gate's own tests).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..');
const UNAVAILABLE = 'dependency audit UNAVAILABLE - gate NOT passed';
const DEFAULT_TIMEOUT_MS = 180_000;
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

/** npm is a JS CLI; run it with this Node binary (no shell, no npm.cmd on win32). */
function npmInvocation() {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && /npm-cli\.c?js$/.test(fromEnv) && existsSync(fromEnv)) {
    return { cmd: process.execPath, prefix: [fromEnv] };
  }
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { cmd: process.execPath, prefix: [candidate] };
  }
  if (process.platform === 'win32') return null;
  return { cmd: 'npm', prefix: [] };
}

function unavailable(reason, extra = {}) {
  return { gate: 'dependency-audit', status: 'unavailable', message: UNAVAILABLE, reason, ...extra };
}

/** Evaluates an `npm audit --json` report (npm >= 7 format). */
export function evaluateReport(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return unavailable('npm audit output is not JSON');
  }
  if (report === null || typeof report !== 'object') return unavailable('npm audit output is not an object');
  if (report.error && typeof report.error === 'object') {
    // npm 10 reports a failed advisory request as { message, error: { summary: '', detail: '' } }.
    const firstLine = (v) => (typeof v === 'string' ? v.trim().split('\n')[0] : '');
    const summary = firstLine(report.error.summary) || firstLine(report.message);
    const errno = /\b(E[A-Z0-9_]{2,})\b/.exec(summary);
    const code = typeof report.error.code === 'string' ? report.error.code : (errno?.[1] ?? 'unknown');
    return unavailable(`npm audit error ${code}${summary ? `: ${summary}` : ''}`, { code });
  }
  const counts = report.metadata?.vulnerabilities;
  if (counts === null || typeof counts !== 'object') {
    return unavailable('npm audit report has no metadata.vulnerabilities');
  }
  const severities = {};
  for (const s of SEVERITIES) {
    const n = counts[s];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      return unavailable(`npm audit report has an invalid ${s} count`);
    }
    severities[s] = n;
  }
  const vulnerable = report.vulnerabilities && typeof report.vulnerabilities === 'object' ? report.vulnerabilities : {};
  const critical = Object.entries(vulnerable)
    .filter(([, v]) => v && typeof v === 'object' && v.severity === 'critical')
    .map(([name, v]) => ({
      name,
      range: typeof v.range === 'string' ? v.range : undefined,
      advisories: Array.isArray(v.via)
        ? v.via.filter((x) => x && typeof x === 'object').map((x) => ({ title: x.title, url: x.url }))
        : [],
      fixAvailable: Boolean(v.fixAvailable),
    }));
  const dependencies = report.metadata?.dependencies;
  const passed = severities.critical === 0;
  return {
    gate: 'dependency-audit',
    status: passed ? 'passed' : 'failed',
    severities,
    total: typeof counts.total === 'number' ? counts.total : SEVERITIES.reduce((a, s) => a + severities[s], 0),
    dependencies: dependencies && typeof dependencies === 'object' ? dependencies : undefined,
    critical,
  };
}

function runAudit(timeoutMs) {
  const npm = npmInvocation();
  if (npm === null) return unavailable('npm CLI not found next to the Node binary');
  const args = [...npm.prefix, 'audit', '--omit=dev', '--json', '--audit-level=critical'];
  const res = spawnSync(npm.cmd, args, {
    cwd: ROOT,
    shell: false,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error) {
    const code = res.error.code ?? 'spawn_failed';
    return unavailable(code === 'ETIMEDOUT' ? `npm audit timed out after ${timeoutMs} ms` : `npm audit could not run (${code})`);
  }
  if (res.signal) return unavailable(`npm audit killed by ${res.signal}`);
  const out = (res.stdout ?? '').trim();
  if (out.length === 0) {
    const err = (res.stderr ?? '').trim().split('\n').slice(-1)[0] ?? '';
    return unavailable(`npm audit produced no report (exit ${res.status})${err ? `: ${err}` : ''}`);
  }
  return evaluateReport(out);
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: { input: { type: 'string' }, 'timeout-ms': { type: 'string' } },
      strict: true,
    }));
  } catch (err) {
    console.error(`dependency-audit: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const timeoutMs = values['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(values['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    console.error('dependency-audit: --timeout-ms must be an integer >= 1000');
    return 2;
  }
  let summary;
  if (values.input !== undefined) {
    let text;
    try {
      text = readFileSync(resolve(values.input), 'utf8');
    } catch (err) {
      summary = unavailable(`cannot read ${values.input}: ${err instanceof Error ? err.message : String(err)}`);
    }
    summary ??= evaluateReport(text);
  } else {
    summary = runAudit(timeoutMs);
  }
  console.log(JSON.stringify(summary));
  if (summary.status === 'unavailable') {
    console.error(`${UNAVAILABLE} (${summary.reason})`);
    return 3;
  }
  if (summary.status === 'failed') {
    console.error(
      `dependency audit FAILED: ${summary.severities.critical} critical finding(s): ` +
        summary.critical.map((c) => c.name).join(', '),
    );
    return 1;
  }
  console.error(
    `dependency audit passed: 0 critical (high ${summary.severities.high}, moderate ${summary.severities.moderate}, low ${summary.severities.low})`,
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SELF) {
  process.exitCode = main();
}
