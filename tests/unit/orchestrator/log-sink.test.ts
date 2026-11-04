// AttemptLogSink (§13.1, §7): chunking, ordering, masking across chunks, buffering on DB failure, drop marker,
// partial-line force flush and `log` publication per row.
import { describe, expect, it } from 'vitest';
import { createAttemptLogSink, splitChunks, LOG_CHUNK_MAX_CHARS } from '@orc/orchestrator';
import {
  manualClock,
  orchestratorTestConfig,
  recordingPublisher,
  silentLogger,
  taskLogDb,
  testSecrets,
} from '../../helpers/worker/fakes';
import type { FakeTaskLogs } from '../../helpers/worker/fakes';

const TASK = '0b6f6f1e-0000-4000-8000-000000000001';
const ATTEMPT = '0b6f6f1e-0000-4000-8000-000000000002';

function setup(o: { bufferMax?: number; secrets?: string[] } = {}) {
  const state: FakeTaskLogs = { rows: [], failNext: 0, calls: 0 };
  const publisher = recordingPublisher();
  const clock = manualClock();
  const sink = createAttemptLogSink(
    { taskId: TASK, attemptId: ATTEMPT, startSeq: 0 },
    {
      db: taskLogDb(state),
      publisher,
      secrets: testSecrets(...(o.secrets ?? [])),
      logger: silentLogger(),
      clock,
      config: orchestratorTestConfig({ logBufferMaxBytes: o.bufferMax ?? 8_388_608, logFlushBytes: 1_000_000 }),
    },
  );
  return { state, publisher, clock, sink };
}

describe('splitChunks', () => {
  it('never exceeds the chunk size and never splits a surrogate pair', () => {
    const text = `${'a'.repeat(LOG_CHUNK_MAX_CHARS - 1)}😀${'b'.repeat(10)}`;
    const chunks = splitChunks(text);
    expect(chunks.every((c) => c.length <= LOG_CHUNK_MAX_CHARS)).toBe(true);
    expect(chunks.join('')).toBe(text);
    expect(chunks[0]?.endsWith('a')).toBe(true);
    expect(chunks[1]?.startsWith('😀')).toBe(true);
  });
});

describe('createAttemptLogSink', () => {
  it('writes ordered rows of <= 4000 chars from seq 0 and publishes non-claude rows', async () => {
    const { state, publisher, sink } = setup();
    sink.write('system', 'orchestrator', '[orc] one\n');
    sink.write('stdout', 'test', `${'x'.repeat(9000)}\n`);
    sink.write('claude', 'claude', '{"type":"system"}\n');
    await sink.close();
    expect(state.rows.map((r) => r.seq)).toEqual([...state.rows.keys()]);
    expect(state.rows.every((r) => r.content.length <= LOG_CHUNK_MAX_CHARS)).toBe(true);
    expect(state.rows.filter((r) => r.stream === 'stdout').map((r) => r.content).join('')).toBe(`${'x'.repeat(9000)}\n`);
    expect(state.rows.every((r) => r.byteLength === Buffer.byteLength(r.content))).toBe(true);
    const logEvents = publisher.events.map((e) => e.event).filter((e) => e.type === 'log');
    expect(logEvents).toHaveLength(state.rows.filter((r) => r.stream !== 'claude').length);
    expect(sink.nextSeq).toBe(state.rows.length);
  });

  it('masks a registered secret split across chunks', async () => {
    const secret = 'S3cretValue-ABCDEFGH-123456';
    const { state, sink } = setup({ secrets: [secret] });
    sink.write('stderr', 'claude', `token is ${secret.slice(0, 10)}`);
    sink.write('stderr', 'claude', `${secret.slice(10)} end\n`);
    await sink.close();
    const all = state.rows.map((r) => r.content).join('');
    expect(all).not.toContain(secret);
    expect(all).toContain('[REDACTED]');
  });

  it('force-flushes a partial line held longer than 2 s', async () => {
    const { state, clock, sink } = setup();
    sink.write('stdout', 'test', 'no newline yet');
    await sink.flush();
    expect(state.rows).toHaveLength(0);
    clock.advance(2500);
    await sink.flush();
    expect(state.rows.map((r) => r.content)).toEqual(['no newline yet']);
    await sink.close();
  });

  it('keeps rows while the DB fails and writes them later in order', async () => {
    const { state, sink } = setup();
    state.failNext = 2;
    sink.write('system', 'orchestrator', 'a\n');
    await sink.flush();
    sink.write('system', 'git', 'b\n');
    await sink.flush();
    expect(state.rows).toHaveLength(0);
    await sink.flush();
    expect(state.rows.map((r) => r.content)).toEqual(['a\n', 'b\n']);
    expect(state.rows.map((r) => r.seq)).toEqual([0, 1]);
    await sink.close();
  });

  it('drops the oldest output beyond LOG_BUFFER_MAX_BYTES and writes a marker line', async () => {
    const { state, sink } = setup({ bufferMax: 10_000 });
    state.failNext = 1;
    for (let i = 0; i < 6; i++) sink.write('stdout', 'test', `${String(i).repeat(3999)}\n`);
    await sink.flush();
    await sink.close();
    const marker = state.rows.find((r) => r.stream === 'system');
    expect(marker?.content).toMatch(/^\[orc\] \d+ bytes of output dropped\n$/);
    expect(sink.droppedBytes).toBeGreaterThan(0);
    expect(state.rows.some((r) => r.content.startsWith('0'))).toBe(false);
    expect(state.rows.some((r) => r.content.startsWith('5'))).toBe(true);
  });

  it('discard() drops everything and writes nothing afterwards', async () => {
    const { state, sink } = setup();
    sink.write('stdout', 'test', 'x\n');
    sink.discard();
    sink.write('stdout', 'test', 'y\n');
    await sink.flush();
    expect(state.rows).toHaveLength(0);
  });
});
