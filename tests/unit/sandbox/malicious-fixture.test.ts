// tests/fixtures/repos/malicious-tests (contract §10.11 item 9): its test command, run outside any sandbox, must
// REPORT every reachable target as a JUnit failure (and blocked/absent targets as passes), so `test:compose` can
// assert that nothing was reachable inside the runner. The command is the one fixture.json declares.
import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseJUnitXml } from '@orc/orchestrator';

const FIXTURE = fileURLToPath(new URL('../../fixtures/repos/malicious-tests', import.meta.url));
const manifest = JSON.parse(readFileSync(join(FIXTURE, 'fixture.json'), 'utf8')) as {
  testCommand: string[];
  junitReportPath: string;
};

let base: string;
let worktree: string;
let server: net.Server;
let openPort: number;
let closedPort: number;

function listen(): Promise<net.Server> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.destroy());
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function runFixture(env: Record<string, string>): Promise<Map<string, string>> {
  const [cmd, ...args] = manifest.testCommand as [string, ...string[]];
  const code = await new Promise<number | null>((resolve, reject) => {
    const p = spawn(cmd === 'node' ? process.execPath : cmd, args, {
      cwd: worktree,
      env,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    p.once('error', reject);
    p.once('exit', (c) => resolve(c));
  });
  const xml = readFileSync(join(worktree, manifest.junitReportPath), 'utf8');
  const parsed = parseJUnitXml(xml, { maxCases: 1000 });
  const byName = new Map(parsed.cases.map((c) => [c.name, c.status]));
  expect(code === 0).toBe(parsed.counts.failed === 0 && parsed.counts.errored === 0);
  return byName;
}

const baseEnv = (): Record<string, string> => {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
};

beforeAll(async () => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'orc-malicious-')));
  const projectDir = join(base, 'ws', 'p1');
  worktree = join(projectDir, 't1', 'a1');
  mkdirSync(worktree, { recursive: true });
  cpSync(FIXTURE, worktree, { recursive: true });
  mkdirSync(join(base, 'ws', '.repos', 'p1.git'), { recursive: true });
  mkdirSync(join(projectDir, 't2', 'a1', 'src'), { recursive: true });
  writeFileSync(join(projectDir, 't2', 'a1', 'src', 'secret.js'), 'export const s = 1;\n');
  server = await listen();
  openPort = (server.address() as net.AddressInfo).port;
  const closed = await listen();
  closedPort = (closed.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  writeFileSync(
    join(worktree, 'orc-smoke-targets.json'),
    JSON.stringify({
      tcp: [
        ['127.0.0.1', openPort],
        ['127.0.0.1', closedPort],
      ],
      dirs: [{ path: join(projectDir, 't2', 'a1'), mustExist: true }],
      files: [
        { path: join(projectDir, 't2', 'a1', 'src', 'secret.js'), mustExist: true },
        { path: join(base, 'absent-secret'), mustExist: false },
      ],
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

describe('malicious-tests fixture', () => {
  it('declares the JUnit test command used by the compose probe', () => {
    expect(manifest.testCommand[0]).toBe('node');
    expect(manifest.testCommand).toContain('--test');
    expect(manifest.junitReportPath).toBe('junit.xml');
  });

  it('reports every reachable target (sibling worktree, .repos, open TCP, credentials in env) as a failure', async () => {
    const env = {
      ...baseEnv(),
      DB_PASSWORD: 'x',
      REDIS_PASSWORD: 'y',
      ANTHROPIC_API_KEY: 'sk-test',
      DB_PASSWORD_FILE: '/run/secrets/x',
    };
    const cases = await runFixture(env);
    const sibling = join(base, 'ws', 'p1', 't2', 'a1');
    expect(cases.get(`list ${sibling} is denied`)).toBe('failed');
    expect(cases.get(`write into ${sibling} is denied`)).toBe('failed');
    expect(cases.get(`read ${join(sibling, 'src', 'secret.js')} is denied`)).toBe('failed');
    expect(cases.get(`list ${join(base, 'ws', '.repos')} is denied`)).toBe('failed');
    expect(cases.get(`TCP 127.0.0.1:${openPort} is unreachable`)).toBe('failed');
    expect(cases.get('environment has no DB_* variables')).toBe('failed');
    expect(cases.get('environment has no REDIS_* variables')).toBe('failed');
    expect(cases.get('environment has no ANTHROPIC_API_KEY')).toBe('failed');
    expect(cases.get('environment has no *_FILE secret paths')).toBe('failed');
    // Blocked or absent targets pass.
    expect(cases.get(`TCP 127.0.0.1:${closedPort} is unreachable`)).toBe('passed');
    expect(cases.get(`read ${join(base, 'absent-secret')} is denied`)).toBe('passed');
    expect(cases.get('list /run/secrets is denied')).toBe('passed');
    expect(cases.get(`list ${join(base, 'ws', '.orc')} is denied`)).toBe('passed');
  }, 60_000);

  it('passes the environment and TCP probes when no credential and no service is reachable', async () => {
    const cases = await runFixture(baseEnv());
    for (const name of [
      'environment has no DB_* variables',
      'environment has no REDIS_* variables',
      'environment has no MSSQL_* / EGRESS_* variables',
      'environment has no *_FILE secret paths',
      'environment has no ANTHROPIC_API_KEY',
      'environment has no proxy credentials (HTTP(S)_PROXY)',
      `TCP 127.0.0.1:${closedPort} is unreachable`,
    ]) {
      expect(cases.get(name), name).toBe('passed');
    }
  }, 60_000);
});
