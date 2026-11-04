// Project test command runner (contract §13.5): launcher spawn (kind 'test'), bounded output, timeout,
// cancellation and JUnit report parsing into TestRuns/TestResults.
import { readFile, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { systemClock, toIso } from '@orc/shared';
import type { SupervisedProcess } from '@orc/shared/node';
import {
  TEST_ENV_ALLOWLIST,
  buildChildEnv,
  normalizeWorktreeRelativePath,
  realpathWithin,
} from '@orc/security';
import { serializeError } from '@orc/logger';
import { parseJUnitXml } from './junit.js';
import { errorMessage } from './util.js';
import type { OrchestratorDeps, TestRunOutcome, TestRunner } from './types.js';

const STREAM_END_AFTER_EXIT_MS = 2000;
const REPORT_ERROR_MAX = 2000;

export function testProcessKey(attemptId: string): string {
  return `test-${attemptId}`;
}

function waitEnd(stream: NodeJS.ReadableStream, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const s = stream as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean; destroy?: () => void };
    if (s.readableEnded === true || s.destroyed === true) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      s.destroy?.();
      resolve();
    }, ms);
    const done = (): void => {
      clearTimeout(t);
      resolve();
    };
    stream.once('end', done);
    stream.once('close', done);
    stream.once('error', done);
  });
}

export function createTestRunner(deps: OrchestratorDeps): TestRunner {
  const clock = deps.clock ?? systemClock;
  const cfg = deps.config;
  const { db, logger } = deps;

  return {
    async run(i) {
      const startedMs = clock.nowMs();
      const run = await db.repos.testRuns.start({
        attemptId: i.attemptId,
        taskId: i.taskId,
        command: [...i.command],
        junitPath: i.junitPath,
      });
      const counts = { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 };
      const finish = async (
        status: TestRunOutcome['status'],
        exit: { exitCode: number | null; signal: string | null },
        report: { parsed: boolean; error: string | null },
      ): Promise<TestRunOutcome> => {
        const durationMs = Math.max(0, Math.round(clock.nowMs() - startedMs));
        await db.repos.testRuns.finish(run.id, {
          status,
          exitCode: exit.exitCode,
          signal: exit.signal,
          durationMs,
          ...counts,
          reportParsed: report.parsed,
          reportError: report.error,
        });
        return { status, exitCode: exit.exitCode, signal: exit.signal, durationMs, testRunId: run.id, counts: { ...counts } };
      };

      const cmd = i.command[0];
      if (cmd === undefined || i.signal.aborted) {
        return finish(i.signal.aborted ? 'cancelled' : 'error', { exitCode: null, signal: null }, { parsed: false, error: null });
      }
      const overrides: Record<string, string> = {
        HOME: i.tmpDir,
        TMPDIR: i.tmpDir,
        CI: '1',
        FORCE_COLOR: '0',
        LANG: 'C.UTF-8',
        ORC_ATTEMPT_ID: i.attemptId,
      };
      if (cfg.platform === 'win32') {
        overrides.TEMP = i.tmpDir;
        overrides.TMP = i.tmpDir;
        overrides.USERPROFILE = i.tmpDir;
      }
      const env = buildChildEnv(TEST_ENV_ALLOWLIST, process.env, overrides, cfg.platform);

      let proc: SupervisedProcess;
      try {
        proc = await deps.launcher.spawn(i.lease, {
          kind: 'test',
          cmd,
          args: i.command.slice(1),
          cwd: i.cwd,
          env,
        });
      } catch (err) {
        logger.warn({ err: serializeError(err), attemptId: i.attemptId }, 'test command could not be started');
        i.sink.write('system', 'orchestrator', `[orc] test command could not be started: ${errorMessage(err)}\n`);
        return finish('error', { exitCode: null, signal: null }, { parsed: false, error: null });
      }

      const key = testProcessKey(i.attemptId);
      const local = deps.launcher.mode === 'local';
      if (local) {
        const p = cfg.platform === 'win32' ? win32 : posix;
        await deps.registry
          .add({
            key,
            kind: 'test',
            pid: proc.pid,
            pgid: proc.pgid,
            attemptId: i.attemptId,
            workerId: cfg.workerId,
            startedAt: toIso(proc.startedAt),
            command: p.basename(cmd),
          })
          .catch((err: unknown) => logger.warn({ err: serializeError(err) }, 'test process registry add failed'));
      }

      let outputBytes = 0;
      let limitNoted = false;
      const pipe = (stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr'): void => {
        const decoder = new StringDecoder('utf8');
        stream.on('data', (chunk: Buffer | string) => {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
          if (outputBytes >= cfg.testOutputMaxBytes) return;
          const room = cfg.testOutputMaxBytes - outputBytes;
          const part = buf.length > room ? buf.subarray(0, room) : buf;
          outputBytes += part.length;
          i.sink.write(name, 'test', decoder.write(part));
          if (outputBytes >= cfg.testOutputMaxBytes && !limitNoted) {
            limitNoted = true;
            i.sink.write(name, 'test', decoder.end());
            i.sink.write('system', 'orchestrator', `[orc] test output exceeded ${cfg.testOutputMaxBytes} bytes; further output dropped\n`);
          }
        });
        stream.on('end', () => {
          if (!limitNoted) i.sink.write(name, 'test', decoder.end());
        });
      };
      pipe(proc.stdout, 'stdout');
      pipe(proc.stderr, 'stderr');
      proc.stdin.on('error', () => undefined);
      proc.stdin.end();

      let timedOut = false;
      let cancelled = false;
      const stopping: { p: Promise<unknown> | null } = { p: null };
      const stop = (): void => {
        stopping.p ??= proc.stop({ graceMs: cfg.testKillGraceMs }).catch((err: unknown) => {
          logger.warn({ err: serializeError(err) }, 'test process stop failed');
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, Math.max(0, i.timeoutMs));
      const onAbort = (): void => {
        cancelled = true;
        stop();
      };
      i.signal.addEventListener('abort', onAbort, { once: true });
      if (i.signal.aborted) onAbort();

      const exit = await proc.exited;
      clearTimeout(timer);
      i.signal.removeEventListener('abort', onAbort);
      if (stopping.p !== null) await stopping.p;
      await Promise.all([waitEnd(proc.stdout, STREAM_END_AFTER_EXIT_MS), waitEnd(proc.stderr, STREAM_END_AFTER_EXIT_MS)]);
      if (local) await deps.registry.remove(key).catch(() => undefined);

      if (cancelled) return finish('cancelled', exit, { parsed: false, error: null });
      if (timedOut) return finish('timed_out', exit, { parsed: false, error: null });

      let status: TestRunOutcome['status'] = exit.exitCode === 0 && exit.signal === null ? 'passed' : 'failed';
      let report = { parsed: false, error: null as string | null };
      if (i.junitPath !== null) {
        try {
          if (i.beforeReport) await i.beforeReport();
          const rel = normalizeWorktreeRelativePath(i.junitPath);
          const file = await realpathWithin(i.cwd, ...rel.split('/'));
          const st = await stat(file);
          if (!st.isFile()) throw new Error('JUnit report is not a regular file');
          if (st.size > cfg.junitMaxBytes) throw new Error(`JUnit report exceeds ${cfg.junitMaxBytes} bytes`);
          const parsed = parseJUnitXml(await readFile(file, 'utf8'), { maxCases: cfg.junitMaxCases });
          Object.assign(counts, parsed.counts);
          if (parsed.cases.length > 0) await db.repos.testRuns.insertResults(run.id, parsed.cases);
          report = { parsed: true, error: parsed.truncated ? `report truncated to ${cfg.junitMaxCases} cases` : null };
          if (status === 'passed' && parsed.counts.failed + parsed.counts.errored > 0) status = 'failed';
        } catch (err) {
          report = { parsed: false, error: errorMessage(err).slice(0, REPORT_ERROR_MAX) };
          i.sink.write('system', 'orchestrator', `[orc] JUnit report not parsed: ${report.error}\n`);
        }
      }
      return finish(status, exit, report);
    },
  };
}
