// The two script gates wired into `npm run test:security` (contract §18.1, ADR-0027, requirements §16):
// scripts/check-placeholders.mjs and scripts/dependency-audit.mjs. The audit's registry call itself
// runs in `test:security` / `audit:deps`; here its decision logic runs offline on saved reports.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/security/deployment';
import { makeTempDir, removeTempDir } from '../helpers/git/fixtures';

const PLACEHOLDERS = path.join(REPO_ROOT, 'scripts', 'check-placeholders.mjs');
const AUDIT = path.join(REPO_ROOT, 'scripts', 'dependency-audit.mjs');

function node(script: string, args: readonly string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', shell: false, timeout: 60_000, windowsHide: true });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

let tmp: string;
beforeAll(() => {
  tmp = makeTempDir('orc-sec-scripts-');
});
afterAll(() => {
  removeTempDir(tmp);
});

describe('scripts/check-placeholders.mjs', () => {
  function tree(name: string, files: Record<string, string>): string {
    const root = path.join(tmp, name);
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, ...rel.split('/'));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    return root;
  }

  it('passes on the repository production sources', () => {
    const r = node(PLACEHOLDERS, []);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/0 finding\(s\) - gate passed/);
  });

  it.each([
    ['TODO', 'packages/x/src/a.ts', '// TODO: finish\nexport const a = 1;\n'],
    ['FIXME', 'apps/api/src/b.ts', 'export const b = 1; // FIXME later\n'],
    ['XXX', 'scripts/c.mjs', '/* XXX hack */\n'],
    ['placeholder', 'docker/Dockerfile', 'RUN echo placeholder\n'],
    ['not implemented', 'packages/y/src/d.ts', "throw new Error('Not implemented');\n"],
    ['not implemented', 'apps/worker/src/e.ts', "throw new Error('not_implemented');\n"],
  ])('fails on %s in a production source', (marker, rel, content) => {
    const root = tree(`bad-${marker.replace(/\W/g, '')}-${rel.replace(/\W/g, '')}`, { [rel]: content });
    const r = node(PLACEHOLDERS, ['--root', root, '--json']);
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { passed: boolean; findings: { path: string; marker: string; line: number }[] };
    expect(out.passed).toBe(false);
    expect(out.findings).toEqual([expect.objectContaining({ path: rel, marker, line: expect.any(Number) as number })]);
  });

  it('ignores tests, non-production directories, the inline allow marker and web input placeholders', () => {
    const root = tree('allowed', {
      'packages/x/src/a.test.ts': '// TODO in a test file\n',
      'packages/x/src/test/helper.ts': '// TODO in a test helper dir\n',
      'tests/unit/x.test.ts': '// TODO outside production roots\n',
      'docs/notes.md': 'TODO in docs\n',
      'packages/x/src/b.ts': '// check-placeholders: allow - documents the TODO keyword\nconst k = "TODO";\n',
      'apps/web/src/Form.tsx': 'export const F = () => <input placeholder="Search" />;\n',
      'apps/web/src/style.css': 'input::placeholder { color: gray; }\n',
    });
    const r = node(PLACEHOLDERS, ['--root', root, '--json']);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { findings: unknown[] }).findings).toEqual([]);
  });

  it('rejects unknown options (exit 2)', () => {
    expect(node(PLACEHOLDERS, ['--nope']).code).toBe(2);
  });
});

describe('scripts/dependency-audit.mjs (ADR-0027 decision logic, offline)', () => {
  function report(name: string, body: unknown): string {
    const file = path.join(tmp, `${name}.json`);
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  }
  const counts = (critical: number, high = 0) => ({ info: 0, low: 1, moderate: 2, high, critical, total: 3 + high + critical });

  it('passes (exit 0) with zero critical findings, printing a JSON summary', () => {
    const r = node(AUDIT, ['--input', report('clean', { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: counts(0, 4), dependencies: { prod: 10, total: 20 } } })]);
    expect(r.code).toBe(0);
    const summary = JSON.parse(r.stdout) as { status: string; severities: { critical: number; high: number } };
    expect(summary).toMatchObject({ status: 'passed', severities: { critical: 0, high: 4 } });
  });

  it('fails (exit 1) on any critical finding and names the package', () => {
    const r = node(AUDIT, [
      '--input',
      report('critical', {
        auditReportVersion: 2,
        vulnerabilities: {
          'evil-pkg': { name: 'evil-pkg', severity: 'critical', range: '<1.2.3', via: [{ title: 'RCE', url: 'https://example.invalid/GHSA' }], fixAvailable: true },
          'meh-pkg': { name: 'meh-pkg', severity: 'moderate', via: ['evil-pkg'] },
        },
        metadata: { vulnerabilities: counts(1) },
      }),
    ]);
    expect(r.code).toBe(1);
    const summary = JSON.parse(r.stdout) as { status: string; critical: { name: string }[] };
    expect(summary.status).toBe('failed');
    expect(summary.critical.map((c) => c.name)).toEqual(['evil-pkg']);
    expect(r.stderr).toMatch(/FAILED.*evil-pkg/);
  });

  it.each([
    ['network error report', { error: { code: 'ENOTFOUND', summary: 'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed' } }],
    ['registry error report', { error: { code: 'E503', summary: 'Service Unavailable' } }],
    ['not JSON', 'npm ERR! network'],
    ['no metadata', { vulnerabilities: {} }],
    ['bad counts', { metadata: { vulnerabilities: { critical: 'x' } } }],
  ])('exits 3 "UNAVAILABLE - gate NOT passed" on %s (never a pass)', (name, body) => {
    const r = node(AUDIT, ['--input', report(name.replace(/\W/g, '-'), body)]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'unavailable', message: 'dependency audit UNAVAILABLE - gate NOT passed' });
    expect(r.stderr).toContain('dependency audit UNAVAILABLE - gate NOT passed');
  });

  it('exits 3 when the live npm audit cannot reach the registry (unreachable loopback port, no external call)', () => {
    const r = spawnSync(process.execPath, [AUDIT, '--timeout-ms', '60000'], {
      encoding: 'utf8',
      shell: false,
      timeout: 90_000,
      windowsHide: true,
      env: {
        ...process.env,
        npm_config_registry: 'http://127.0.0.1:9/',
        npm_config_fetch_retries: '0',
        npm_config_fetch_timeout: '5000',
        npm_config_audit: 'true',
      },
    });
    expect(r.status, r.stderr).toBe(3);
    const summary = JSON.parse(r.stdout) as { status: string; reason: string; code: string };
    expect(summary).toMatchObject({ status: 'unavailable', message: 'dependency audit UNAVAILABLE - gate NOT passed' });
    expect(summary.code).toMatch(/^E[A-Z0-9_]+$/);
    expect(r.stderr).toContain('dependency audit UNAVAILABLE - gate NOT passed');
  }, 120_000);

  it('exits 3 when the report cannot be read and 2 on usage errors', () => {
    expect(node(AUDIT, ['--input', path.join(tmp, 'missing.json')]).code).toBe(3);
    expect(node(AUDIT, ['--timeout-ms', '5']).code).toBe(2);
    expect(node(AUDIT, ['--bogus']).code).toBe(2);
  });

  it('is wired into the root scripts (test:security and audit:deps)', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:security']).toContain('vitest run --project security');
    expect(pkg.scripts['test:security']).toContain('node scripts/check-placeholders.mjs');
    expect(pkg.scripts['test:security']).toContain('node scripts/dependency-audit.mjs');
    expect(pkg.scripts['audit:deps']).toBe('node scripts/dependency-audit.mjs');
  });
});
