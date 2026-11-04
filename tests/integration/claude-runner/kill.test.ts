// Timeout, cancel and output-limit kill sequences of fake-claude through the local launcher
// (contract §10.7, §10.8, §18.3): every PID (CLI and grandchildren) must be dead afterwards.
import { describe, expect, it } from 'vitest';
import type { ClaudeRunResult } from '@orc/claude-runner';
import type { ParsedClaudeLine } from '@orc/shared';
import { isProcessAlive } from '../../helpers/common';
import { makeRunRequest, recordingHandlers, systemSubtype, type RequestOptions } from '../../helpers/claude/fake-claude';
import { useRunnerEnv, type RunnerEnv } from '../../helpers/claude/integration';

const env = useRunnerEnv();
const posixOnly = process.platform === 'win32';
const linuxOnly = process.platform !== 'linux';

interface RunOutcome {
  res: ClaudeRunResult;
  rec: ReturnType<typeof recordingHandlers>['rec'];
}

/** Runs fake-claude; `abortWhen` aborts the run with `reason` once a matching line arrives. */
async function runFake(
  e: RunnerEnv,
  o: Omit<RequestOptions, 'lease' | 'signal'> & {
    abortWhen?: (p: ParsedClaudeLine) => boolean;
    reason?: string;
    killGraceMs?: number;
    maxOutputBytes?: number;
  },
): Promise<RunOutcome> {
  const ac = new AbortController();
  const { handlers, rec } = recordingHandlers({
    onLine(p) {
      if (o.abortWhen?.(p) === true && !ac.signal.aborted) ac.abort(o.reason ?? 'cancel');
    },
  });
  const runner = e.runner({
    ...(o.killGraceMs !== undefined ? { killGraceMs: o.killGraceMs } : {}),
    ...(o.maxOutputBytes !== undefined ? { maxOutputBytes: o.maxOutputBytes } : {}),
  });
  const res = await runner.run(makeRunRequest(e.layout, { ...o, lease: e.lease, signal: ac.signal }), handlers);
  e.trackPids(rec.spawn?.pid, ...rec.fakePids);
  return { res, rec };
}

function expectAllDead(rec: RunOutcome['rec']): void {
  const pids = [rec.spawn?.pid ?? 0, ...rec.fakePids];
  expect(pids.every((p) => p > 0)).toBe(true);
  expect(pids.filter((p) => isProcessAlive(p))).toEqual([]);
}

const isText = (needle: string) => (p: ParsedClaudeLine): boolean =>
  p.kind === 'assistant' && JSON.stringify(p.event).includes(needle);

describe('claude-runner kill sequences (integration)', () => {
  it('deadline => timeout: the CLI and its grandchild are killed, no survivors', async () => {
    const e = env();
    const { res, rec } = await runFake(e, {
      directives: ['@@fake spawn-grandchild', '@@fake text started', '@@fake hang'],
      deadlineMs: 6_000,
    });
    expect(res.outcome).toBe('timeout');
    expect(rec.fakePids).toHaveLength(1);
    expect(rec.lines.some((l) => isText('started')(l.parsed))).toBe(true);
    expect(res.result).toBeNull();
    expect(res.kill).not.toBeNull();
    expect(res.kill?.survivors).toEqual([]);
    expectAllDead(rec);
  });

  it('timeout with an ignored SIGTERM: graceful step first, then forced kill of the whole tree', async () => {
    const e = env();
    const graceMs = 1_500;
    const { res, rec } = await runFake(e, {
      directives: ['@@fake ignore-sigterm', '@@fake spawn-grandchild', '@@fake text started', '@@fake hang'],
      deadlineMs: 6_000,
      killGraceMs: graceMs,
    });
    expect(res.outcome).toBe('timeout');
    expect(res.kill).toMatchObject({ graceful: false, forced: true, survivors: [] });
    if (process.platform !== 'win32') {
      // POSIX waits the full grace period after SIGTERM before escalating to SIGKILL.
      expect(res.kill?.durationMs).toBeGreaterThanOrEqual(graceMs - 50);
    }
    expectAllDead(rec);
  });

  it('cancel mid-run => cancelled, no orphans', async () => {
    const e = env();
    const { res, rec } = await runFake(e, {
      directives: ['@@fake spawn-grandchild', '@@fake text started', '@@fake hang'],
      abortWhen: isText('started'),
      reason: 'cancel',
    });
    expect(res.outcome).toBe('cancelled');
    expect(rec.fakePids).toHaveLength(1);
    expect(res.kill?.survivors).toEqual([]);
    expectAllDead(rec);
  });

  it('cancel with ignored SIGTERM escalates to a forced kill', async () => {
    const e = env();
    const { res, rec } = await runFake(e, {
      directives: ['@@fake ignore-sigterm', '@@fake spawn-grandchild', '@@fake text started', '@@fake hang'],
      abortWhen: isText('started'),
      reason: 'cancel',
    });
    expect(res.outcome).toBe('cancelled');
    expect(res.kill).toMatchObject({ forced: true, survivors: [] });
    expectAllDead(rec);
  });

  it.each([
    ['worker_shutdown', 'shutdown'],
    ['quota', 'quota'],
  ] as const)('abort reason %s => outcome %s', async (reason, outcome) => {
    const e = env();
    const { res, rec } = await runFake(e, {
      directives: ['@@fake text started', '@@fake hang'],
      abortWhen: isText('started'),
      reason,
    });
    expect(res.outcome).toBe(outcome);
    expectAllDead(rec);
  });

  it('output limit => kill and outcome output_limit', async () => {
    const e = env();
    const limit = 64 * 1024;
    const { res, rec } = await runFake(e, {
      directives: ['@@fake huge-output 4194304', '@@fake hang'],
      maxOutputBytes: limit,
    });
    expect(res.outcome).toBe('output_limit');
    expect(res.outputBytes).toBeGreaterThan(limit);
    expect(res.result).toBeNull();
    expect(res.kill?.survivors).toEqual([]);
    // Output after the limit is discarded: what reached onLine stays near the limit.
    const delivered = rec.lines.reduce((n, l) => n + Buffer.byteLength(l.raw, 'utf8') + 1, 0);
    expect(delivered).toBeLessThanOrEqual(limit + 1024 * 1024);
    expectAllDead(rec);
  });

  it.skipIf(posixOnly)('POSIX: slow-exit-ms on SIGTERM exits gracefully within the grace period', async () => {
    const e = env();
    const { res, rec } = await runFake(e, {
      directives: ['@@fake slow-exit-ms 300', '@@fake text started', '@@fake hang'],
      abortWhen: isText('started'),
      killGraceMs: 5_000,
    });
    expect(res.outcome).toBe('cancelled');
    expect(res.kill).toMatchObject({ graceful: true, forced: false, survivors: [] });
    expect(res.exitCode).toBe(143);
    expectAllDead(rec);
  });

  it.skipIf(linuxOnly)('Linux: a detached (setsid) grandchild is caught by the ORC_ATTEMPT_ID marker sweep', async () => {
    const e = env();
    const { res, rec } = await runFake(e, {
      directives: ['@@fake ignore-sigterm', '@@fake spawn-grandchild detached', '@@fake text started', '@@fake hang'],
      abortWhen: isText('started'),
    });
    expect(res.outcome).toBe('cancelled');
    expect(rec.fakePids).toHaveLength(1);
    expect(res.kill?.survivors).toEqual([]);
    expectAllDead(rec);
  });

  it('records fake_pid events for grandchildren (sanity of the directive protocol)', async () => {
    const e = env();
    const { res, rec } = await runFake(e, {
      directives: ['@@fake spawn-grandchild', '@@fake text started', '@@fake hang'],
      abortWhen: (p) => systemSubtype(p) === 'fake_pid',
    });
    expect(res.outcome).toBe('cancelled');
    expect(rec.fakePids).toHaveLength(1);
    expectAllDead(rec);
  });
});
