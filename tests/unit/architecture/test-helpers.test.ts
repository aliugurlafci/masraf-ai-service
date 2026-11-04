// Unit tests for tests/helpers/common (temp dirs, waitFor, process liveness) and the
// test:report runner configuration.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WaitForTimeoutError,
  aliveProcesses,
  createTempDir,
  isProcessAlive,
  pendingTempDirs,
  useTempDir,
  waitFor,
  waitForProcessExit,
  withTempDir,
} from '../../helpers/common';
import {
  HTML_REPORT_DIR_ENV as REPORTER_DIR_ENV,
  htmlReportDirFromEnv,
} from '../../helpers/common/html-reporter';
import {
  HTML_REPORTER_MODULE,
  HTML_REPORT_DIR,
  HTML_REPORT_DIR_ENV,
  REPORT_DIR,
  STANDARD_PROJECTS,
  htmlReportDir,
  junitReportPath,
  renderHtmlIndex,
  selectProjects,
  vitestArgs,
  vitestEnv,
} from '../../helpers/common/test-report';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TEMP_DIR_MODULE = join(ROOT, 'tests/helpers/common/temp-dir.ts');
// Cold imports, temp-dir I/O on Windows and spawned node processes (which load TypeScript helpers) have exceeded
// the 5 s default on a busy host; every suite in this file gets an explicit budget.
const HELPER_TEST_TIMEOUT_MS = 60_000;

function runNode(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('createTempDir / withTempDir', { timeout: HELPER_TEST_TIMEOUT_MS }, () => {
  it('creates a canonical directory under os.tmpdir() and removes it idempotently', async () => {
    const dir = await createTempDir('orc-helper-');
    expect(isAbsolute(dir.path)).toBe(true);
    expect(dir.path).toBe(realpathSync.native(dir.path));
    expect(dirname(dir.path)).toBe(realpathSync.native(tmpdir()));
    expect(basename(dir.path)).toMatch(/^orc-helper-/);
    writeFileSync(join(dir.path, 'file.txt'), 'x');
    expect(pendingTempDirs().length).toBeGreaterThan(0);
    await Promise.all([dir.cleanup(), dir.cleanup()]);
    await dir.cleanup();
    expect(existsSync(dir.path)).toBe(false);
  });

  it('rejects prefixes that are not a plain name', async () => {
    await expect(createTempDir('../escape-')).rejects.toThrow(/invalid temp dir prefix/);
    await expect(createTempDir('a/b')).rejects.toThrow(/invalid temp dir prefix/);
  });

  it('removes the directory when the callback succeeds and when it throws', async () => {
    let first = '';
    await expect(
      withTempDir((dir) => {
        first = dir;
        writeFileSync(join(dir, 'a.txt'), 'a');
        return 42;
      }),
    ).resolves.toBe(42);
    expect(existsSync(first)).toBe(false);

    let second = '';
    await expect(
      withTempDir((dir) => {
        second = dir;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(second).not.toBe('');
    expect(existsSync(second)).toBe(false);
  });

  it('sweeps directories a process never cleaned up when it exits', async () => {
    const script = [
      `const { createTempDir } = await import(${JSON.stringify(pathToFileURL(TEMP_DIR_MODULE).href)});`,
      "const { writeFileSync } = await import('node:fs');",
      "const dir = await createTempDir('orc-helper-exit-');",
      "writeFileSync(dir.path + '/left-behind.txt', 'x');",
      'process.stdout.write(dir.path);',
      'process.exit(0);',
    ].join('\n');
    const result = await runNode(['--input-type=module', '-e', script]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/orc-helper-exit-/);
    expect(existsSync(result.stdout)).toBe(false);
  });
});

describe('useTempDir (scope: each)', { timeout: HELPER_TEST_TIMEOUT_MS }, () => {
  const dir = useTempDir({ prefix: 'orc-helper-each-' });
  let previous = '';

  it('provides an existing directory inside a test', () => {
    previous = dir();
    expect(existsSync(previous)).toBe(true);
  });

  it('removes it after the test and provides a fresh one', () => {
    expect(previous).not.toBe('');
    expect(existsSync(previous)).toBe(false);
    expect(dir()).not.toBe(previous);
  });
});

describe('useTempDir (scope: all)', { timeout: HELPER_TEST_TIMEOUT_MS }, () => {
  const dir = useTempDir({ scope: 'all', prefix: 'orc-helper-all-' });
  let first = '';

  it('shares one directory across the suite', () => {
    first = dir();
    expect(existsSync(first)).toBe(true);
  });

  it('keeps it until the suite ends', () => {
    expect(dir()).toBe(first);
    expect(existsSync(first)).toBe(true);
  });
});

describe('waitFor', { timeout: HELPER_TEST_TIMEOUT_MS }, () => {
  it('resolves with the first truthy value, retrying falsy results and thrown errors', async () => {
    let calls = 0;
    const value = await waitFor(
      () => {
        calls += 1;
        if (calls === 1) throw new Error('not yet');
        return calls >= 3 ? { calls } : null;
      },
      { intervalMs: 1, timeoutMs: 2000 },
    );
    expect(value).toEqual({ calls: 3 });
  });

  it('accepts async probes', async () => {
    let calls = 0;
    await expect(
      waitFor(() => Promise.resolve(++calls === 2 ? 'ready' : ''), { intervalMs: 1 }),
    ).resolves.toBe('ready');
  });

  it('times out with the description, attempt count and last error as cause', async () => {
    const failure = new Error('still booting');
    const error: unknown = await waitFor(
      () => {
        throw failure;
      },
      { timeoutMs: 60, intervalMs: 5, description: 'the server' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaitForTimeoutError);
    const timeout = error as WaitForTimeoutError;
    expect(timeout.message).toMatch(/timed out after 60 ms waiting for the server/);
    expect(timeout.message).toContain('still booting');
    expect(timeout.attempts).toBeGreaterThan(1);
    expect(timeout.cause).toBe(failure);
  });

  it('bounds a probe that never settles', async () => {
    const started = performance.now();
    await expect(
      waitFor(() => new Promise<boolean>(() => undefined), {
        timeoutMs: 50,
        description: 'a hung probe',
      }),
    ).rejects.toThrow(/did not settle/);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('makes one attempt even with a zero timeout', async () => {
    await expect(waitFor(() => 'now', { timeoutMs: 0 })).resolves.toBe('now');
    await expect(waitFor(() => false, { timeoutMs: 0 })).rejects.toBeInstanceOf(
      WaitForTimeoutError,
    );
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const pending = waitFor(() => false, {
      timeoutMs: 10_000,
      intervalMs: 5,
      signal: controller.signal,
    });
    controller.abort(new Error('test aborted'));
    await expect(pending).rejects.toThrow('test aborted');
  });

  it('rejects invalid durations', async () => {
    await expect(waitFor(() => true, { timeoutMs: -1 })).rejects.toBeInstanceOf(RangeError);
    await expect(waitFor(() => true, { intervalMs: Number.NaN })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe('isProcessAlive / waitForProcessExit', { timeout: HELPER_TEST_TIMEOUT_MS }, () => {
  it('reports the current process alive and invalid pids dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    for (const pid of [0, -1, 1.5, Number.NaN])
      expect(isProcessAlive(pid), String(pid)).toBe(false);
  });

  it('tracks a child from running to exited', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 60_000)'], {
      shell: false,
      stdio: 'ignore',
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error('child did not start');
    try {
      expect(isProcessAlive(pid)).toBe(true);
      expect(aliveProcesses([pid, 0])).toEqual([pid]);
      child.kill('SIGKILL');
      await waitForProcessExit(pid, { timeoutMs: 10_000 });
      expect(isProcessAlive(pid)).toBe(false);
      expect(aliveProcesses([pid])).toEqual([]);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('times out while the process keeps running', async () => {
    await expect(waitForProcessExit(process.pid, { timeoutMs: 30 })).rejects.toThrow(
      new RegExp(`process ${process.pid} to exit`),
    );
  });
});

describe('test:report runner', { timeout: HELPER_TEST_TIMEOUT_MS }, () => {
  it('runs exactly the projects of `npm test`, never claude-live', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const testProjects = [...(manifest.scripts.test ?? '').matchAll(/--project (\S+)/g)].map(
      (m) => m[1],
    );
    expect([...STANDARD_PROJECTS]).toEqual(testProjects);
    expect(STANDARD_PROJECTS).not.toContain('claude-live');
    expect(manifest.scripts['test:report']).toBe('node tests/helpers/common/test-report.ts');
  });

  it('writes one JUnit file per project under reports/ with the built-in reporter', () => {
    expect(REPORT_DIR).toBe('reports');
    expect(junitReportPath('unit')).toBe('reports/junit-unit.xml');
    expect(vitestArgs('api')).toEqual([
      'run',
      '--project',
      'api',
      '--reporter=dot',
      '--reporter=junit',
      '--outputFile.junit=reports/junit-api.xml',
      '--reporter=./tests/helpers/common/html-reporter.ts',
      '--includeTaskLocation',
    ]);
  });

  it('writes the HTML report under reports/html with the @vitest/ui reporter', () => {
    expect(HTML_REPORT_DIR).toBe('reports/html');
    expect(htmlReportDir('web')).toBe('reports/html/web');
    expect(existsSync(join(ROOT, HTML_REPORTER_MODULE))).toBe(true);
    expect(HTML_REPORT_DIR_ENV).toBe(REPORTER_DIR_ENV);
    const env = vitestEnv('unit', { PATH: 'p' });
    expect(env).toEqual({ PATH: 'p', [HTML_REPORT_DIR_ENV]: 'reports/html/unit' });
    expect(htmlReportDirFromEnv(env)).toBe('reports/html/unit');
    expect(() => htmlReportDirFromEnv({})).toThrow(HTML_REPORT_DIR_ENV);
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    expect(manifest.devDependencies['@vitest/ui']).toBeDefined();
  });

  it('renders an overview linking every project report of the run', () => {
    const html = renderHtmlIndex([
      { project: 'unit', code: 0 },
      { project: 'web', code: 1 },
    ]);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<a href="./unit/index.html">unit</a> - passed');
    expect(html).toContain('<a href="./web/index.html">web</a> - FAILED (exit 1)');
    expect(html).toContain('reports/junit-web.xml');
    expect(html).not.toContain('claude-live');
  });

  it('accepts a subset of standard projects and rejects anything else', () => {
    expect(selectProjects([])).toEqual([...STANDARD_PROJECTS]);
    expect(selectProjects(['unit', 'web'])).toEqual(['unit', 'web']);
    expect(() => selectProjects(['claude-live'])).toThrow(/non-standard project "claude-live"/);
  });

  it('does not start runs when imported (only when executed directly)', () => {
    expect(import.meta.main).not.toBe(true);
  });
});
