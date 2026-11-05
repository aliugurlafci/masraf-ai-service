// Runner Yama check (contract §10.11 item 10, ADR-0036 m.9): with NODE_ENV=production the runner
// refuses to start (never listens, so never healthy) when ptrace_scope is missing, unparsable or 0;
// in development and test it only warns. The file reader is injected, so this runs on every host.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, type Logger } from '@orc/logger';
import type { DetectedCaps } from '@orc/sandbox';
import { isOrcError, OrcError } from '@orc/shared';
import { loadRunnerConfig, type RunnerConfig } from '@orc/shared/node';
import {
  assessPtraceScope,
  createRunnerRuntime,
  YAMA_PTRACE_SCOPE_PATH,
} from '../../../apps/runner/src/runtime';

const CAPS_OK: DetectedCaps = {
  caps: { ok: true, uidSwitch: true, chown: true, kill: true, prlimit: true, procfs: true },
  prlimitPath: '/usr/bin/prlimit',
};

function captureLogger(): { logger: Logger; records: () => { level: string; msg: string; reason?: string }[] } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const logger = createLogger({ service: 'runner', level: 'trace', version: 'test', env: 'test', destination });
  return {
    logger,
    records: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { level: string; msg: string; reason?: string }),
  };
}

const reasonOf = (e: unknown): string => {
  const reason = isOrcError(e) ? e.details?.reason : undefined;
  return typeof reason === 'string' ? reason : '';
};

function config(nodeEnv: RunnerConfig['nodeEnv']): RunnerConfig {
  // Roots that do not exist: a start that passes the Yama check fails right after it (realpath).
  const missing = join(tmpdir(), 'orc-ptrace-missing-root-0f3c');
  const base = loadRunnerConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WORKSPACES_ROOT: join(missing, 'w'),
    CLAUDE_HOME_ROOT: join(missing, 'c'),
    CBM_CACHE_DIR: join(missing, 'm'),
    RUNNER_SOCKET_PATH: join(missing, 'sock', 'runner.sock'),
    RUNNER_STATE_DIR: join(missing, 'state'),
  });
  return { ...base, nodeEnv };
}

describe('assessPtraceScope', () => {
  it.each([
    [null, { value: null, ok: false, reason: 'missing' }],
    ['0\n', { value: 0, ok: false, reason: 'disabled' }],
    ['1\n', { value: 1, ok: true, reason: 'ok' }],
    ['2', { value: 2, ok: true, reason: 'ok' }],
    [' 3 \n', { value: 3, ok: true, reason: 'ok' }],
    ['', { value: null, ok: false, reason: 'invalid' }],
    ['-1', { value: null, ok: false, reason: 'invalid' }],
    ['1 2', { value: null, ok: false, reason: 'invalid' }],
    ['one', { value: null, ok: false, reason: 'invalid' }],
  ] as const)('%j => %j', (raw, expected) => {
    expect(assessPtraceScope(raw)).toEqual(expected);
  });

  it('reads the host file path of Yama', () => {
    expect(YAMA_PTRACE_SCOPE_PATH).toBe('/proc/sys/kernel/yama/ptrace_scope');
  });

  it.runIf(process.platform === 'linux' && existsSync(YAMA_PTRACE_SCOPE_PATH))(
    'Linux: the real file parses as an integer',
    () => {
      const a = assessPtraceScope(readFileSync(YAMA_PTRACE_SCOPE_PATH, 'utf8'));
      expect(a.reason === 'ok' || a.reason === 'disabled').toBe(true);
      expect(Number.isInteger(a.value)).toBe(true);
    },
  );
});

describe('runner start (Yama check)', () => {
  it.each([
    [null, 'ptrace_scope_missing'],
    ['0\n', 'ptrace_scope_disabled'],
    ['garbage', 'ptrace_scope_invalid'],
  ] as const)('production refuses to start: %j => %s', async (raw, reason) => {
    const log = captureLogger();
    const rt = createRunnerRuntime(config('production'), log.logger, {
      caps: CAPS_OK,
      readPtraceScope: () => Promise.resolve(raw),
    });
    const err = await rt.start().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OrcError);
    expect(err).toMatchObject({ code: 'config_invalid', details: { reason } });
    // Refused before anything else: no identity chosen, no lease manager, no socket.
    expect(rt.identity).toBeNull();
    expect(rt.recovery).toBeNull();
    await rt.stop();
  });

  it('production with ptrace_scope >= 1 passes the check', async () => {
    const log = captureLogger();
    const rt = createRunnerRuntime(config('production'), log.logger, {
      caps: CAPS_OK,
      readPtraceScope: () => Promise.resolve('1\n'),
    });
    // Fails later (the configured roots do not exist), not at the Yama check.
    const err = await rt.start().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(reasonOf(err)).not.toMatch(/^ptrace_scope/);
    expect(rt.ptraceScope).toBe(1);
    expect(log.records().some((r) => r.msg.includes('ptrace_scope'))).toBe(false);
    await rt.stop();
  });

  it.each(['development', 'test'] as const)('%s only warns', async (nodeEnv) => {
    for (const raw of [null, '0\n']) {
      const log = captureLogger();
      const rt = createRunnerRuntime(config(nodeEnv), log.logger, {
        caps: CAPS_OK,
        readPtraceScope: () => Promise.resolve(raw),
      });
      const err = await rt.start().then(
        () => null,
        (e: unknown) => e,
      );
      // It went past the check: the failure (missing roots) is not the Yama refusal.
      expect(err).not.toBeNull();
      expect(reasonOf(err)).not.toMatch(/^ptrace_scope/);
      const warn = log.records().filter((r) => r.level === 'warn' && r.msg.includes('ptrace_scope'));
      expect(warn).toHaveLength(1);
      expect(warn[0]?.reason).toBe(raw === null ? 'missing' : 'disabled');
      expect(rt.ptraceScope).toBe(raw === null ? null : 0);
      await rt.stop();
    }
  });
});
