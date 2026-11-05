import { describe, expect, it } from 'vitest';
import {
  base64DecodedLength,
  checkRunnerHello,
  MAX_CREDENTIAL_FD_BYTES,
  ClientFrameSchema,
  encodeFrame,
  FrameDecoder,
  MAX_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  parseFrame,
  RequestFrameSchema,
  ServerFrameSchema,
  SessionFrameSchema,
  toErrorFrame,
  fromErrorFrame,
  type RunnerHello,
} from '@orc/sandbox';
import { OrcError } from '@orc/shared';
import { ATTEMPT_ID } from '../../helpers/sandbox/fakes';

const LEASE_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const spawnFrame = {
  v: 1,
  type: 'spawn',
  leaseId: LEASE_ID,
  kind: 'test',
  argv: ['npm', 'test'],
  cwd: '/var/lib/orc/workspaces/p/t/a1',
  env: { PATH: '/usr/bin', CI: '1' },
  limits: { nproc: 64 },
};

describe('protocol v1 schemas', () => {
  it('accepts every request type', () => {
    const frames = [
      { v: 1, type: 'hello' },
      {
        v: 1,
        type: 'lease_acquire',
        key: `attempt-${ATTEMPT_ID}`,
        attemptId: ATTEMPT_ID,
        workerId: 'worker-1',
        paths: ['/var/lib/orc/workspaces/p/t/a1'],
      },
      { v: 1, type: 'lease_renew', leaseId: LEASE_ID },
      { v: 1, type: 'lease_release', leaseId: LEASE_ID },
      { v: 1, type: 'lease_measure', leaseId: LEASE_ID, path: '/x/y', maxEntries: 10 },
      { v: 1, type: 'lease_list' },
      spawnFrame,
    ];
    for (const f of frames) expect(RequestFrameSchema.safeParse(f).success, f.type).toBe(true);
  });

  it('rejects unknown types, unknown fields and other protocol versions', () => {
    expect(RequestFrameSchema.safeParse({ v: 1, type: 'exec', argv: ['sh'] }).success).toBe(false);
    expect(RequestFrameSchema.safeParse({ v: 1, type: 'hello', extra: true }).success).toBe(false);
    expect(RequestFrameSchema.safeParse({ ...spawnFrame, uid: 0 }).success).toBe(false);
    expect(RequestFrameSchema.safeParse({ ...spawnFrame, limits: { core: 1 } }).success).toBe(
      false,
    );
    expect(RequestFrameSchema.safeParse({ v: 2, type: 'hello' }).success).toBe(false);
    expect(RequestFrameSchema.safeParse({ type: 'hello' }).success).toBe(false);
  });

  it('validates keys, ids, env names and NUL bytes', () => {
    const bad = [
      { ...spawnFrame, leaseId: 'not-a-guid' },
      { ...spawnFrame, kind: 'git' },
      { ...spawnFrame, argv: [] },
      { ...spawnFrame, env: { 'BAD-KEY': 'x' } },
      { ...spawnFrame, env: { PATH: 'a\0b' } },
      { ...spawnFrame, cwd: '/a\0b' },
      {
        v: 1,
        type: 'lease_acquire',
        key: 'task-1',
        attemptId: null,
        workerId: 'w',
        paths: ['/a/b'],
      },
      {
        v: 1,
        type: 'lease_acquire',
        key: `attempt-${ATTEMPT_ID}`,
        attemptId: null,
        workerId: 'w',
        paths: [],
      },
    ];
    for (const f of bad) expect(RequestFrameSchema.safeParse(f).success).toBe(false);
  });

  it('spawn credentialFd {b64}: optional, strict, 1..4096 decoded bytes (ADR-0036 m.4)', () => {
    const b64 = (n: number): string => Buffer.alloc(n, 0x41).toString('base64');
    const withCred = (credentialFd: unknown) => ({ ...spawnFrame, kind: 'claude', credentialFd });
    expect(RequestFrameSchema.safeParse(spawnFrame).success).toBe(true);
    for (const n of [1, 2, 3, 40, MAX_CREDENTIAL_FD_BYTES - 1, MAX_CREDENTIAL_FD_BYTES]) {
      expect(RequestFrameSchema.safeParse(withCred({ b64: b64(n) })).success, String(n)).toBe(true);
    }
    // The schema does not decide per kind: the runner answers `env_rejected` (validateSpawnCredential).
    expect(
      RequestFrameSchema.safeParse({ ...spawnFrame, credentialFd: { b64: b64(8) } }).success,
    ).toBe(true);
    for (const bad of [
      { b64: b64(MAX_CREDENTIAL_FD_BYTES + 1) },
      { b64: b64(MAX_CREDENTIAL_FD_BYTES + 2) },
      { b64: '' },
      { b64: 'not base64!' },
      { b64: 'QUFB' , fd: 3 },
      'QUFB',
      null,
    ]) {
      expect(RequestFrameSchema.safeParse(withCred(bad)).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ClientFrameSchema.safeParse(withCred({ b64: b64(8) })).success).toBe(true);
    for (const n of [0, 1, 2, 3, 4, 4096, 4097, 4098]) {
      expect(base64DecodedLength(b64(n)), String(n)).toBe(n);
    }
  });

  it('session frames carry bounded base64 only', () => {
    expect(SessionFrameSchema.safeParse({ v: 1, type: 'stdin', b64: 'aGk=' }).success).toBe(true);
    expect(SessionFrameSchema.safeParse({ v: 1, type: 'stdin', b64: 'not base64!' }).success).toBe(
      false,
    );
    const tooBig = Buffer.alloc(MAX_CHUNK_BYTES + 3).toString('base64');
    expect(SessionFrameSchema.safeParse({ v: 1, type: 'stdin', b64: tooBig }).success).toBe(false);
    expect(
      SessionFrameSchema.safeParse({ v: 1, type: 'stop', graceMs: 100, force: false }).success,
    ).toBe(true);
    expect(
      SessionFrameSchema.safeParse({ v: 1, type: 'stop', graceMs: -1, force: false }).success,
    ).toBe(false);
    expect(ClientFrameSchema.safeParse({ v: 1, type: 'stdin_end' }).success).toBe(true);
  });

  it('server frames: hello_ok, error codes from the catalogue only', () => {
    const hello = {
      v: 1,
      type: 'hello_ok',
      protocol: 1,
      uidBase: 20000,
      maxLeases: 64,
      leaseTtlMs: 40000,
      caps: { ok: true, uidSwitch: true, chown: true, kill: true, prlimit: true, procfs: true },
    };
    expect(ServerFrameSchema.safeParse(hello).success).toBe(true);
    expect(ServerFrameSchema.safeParse({ ...hello, caps: { ok: true } }).success).toBe(false);
    expect(
      ServerFrameSchema.safeParse({ v: 1, type: 'error', code: 'nope', message: 'x' }).success,
    ).toBe(false);
    expect(
      ServerFrameSchema.safeParse({
        v: 1,
        type: 'error',
        code: 'process_spawn_failed',
        message: 'busy',
        reason: 'busy',
      }).success,
    ).toBe(true);
  });
});

describe('framing', () => {
  it('splits lines across chunks', () => {
    const d = new FrameDecoder();
    expect(d.push(Buffer.from('{"a":'))).toEqual([]);
    expect(d.push(Buffer.from('1}\n{"b":2}\n{"c"'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(d.buffered).toBe(4);
    expect(d.push(Buffer.from(':3}\n'))).toEqual(['{"c":3}']);
  });

  it('rejects a frame above the limit, terminated or not', () => {
    const d = new FrameDecoder(16);
    expect(() => d.push(Buffer.from('x'.repeat(17)))).toThrow(/size limit/);
    const d2 = new FrameDecoder(16);
    expect(d2.push(Buffer.from(`${'x'.repeat(16)}\n`))).toHaveLength(1);
    expect(() => d2.push(Buffer.from(`${'y'.repeat(10)}`))).not.toThrow();
    expect(() => d2.push(Buffer.from(`${'y'.repeat(7)}\n`))).toThrow(/size limit/);
  });

  it('enforces 1 MiB on encode', () => {
    expect(encodeFrame({ v: 1, type: 'hello' }).toString()).toBe('{"v":1,"type":"hello"}\n');
    expect(() => encodeFrame({ blob: 'x'.repeat(MAX_FRAME_BYTES) })).toThrow(/size limit/);
  });

  it('parseFrame maps JSON and schema failures to a protocol error', () => {
    for (const line of ['{', '{"v":1,"type":"nope"}', '[]']) {
      try {
        parseFrame(RequestFrameSchema, line);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(OrcError);
        expect((e as OrcError).code).toBe('validation_failed');
        expect((e as OrcError).details?.reason).toBe('protocol');
      }
    }
  });

  it('a malformed frame never carries its content (env values) in the error', () => {
    const secret = 'sk-ant-api03-SECRETSECRETSECRETSECRET';
    try {
      parseFrame(
        RequestFrameSchema,
        `{"v":1,"type":"spawn","env":{"ANTHROPIC_API_KEY":"${secret}"`,
      );
      expect.unreachable();
    } catch (e) {
      expect((e as OrcError).cause).toBeUndefined();
      expect(
        JSON.stringify({ m: (e as OrcError).message, d: (e as OrcError).details }),
      ).not.toContain(secret);
    }
  });
});

describe('error frames', () => {
  it('round-trips OrcError code and reason; hides foreign messages', () => {
    const f = toErrorFrame(
      new OrcError('process_spawn_failed', 'busy now', { details: { reason: 'busy' } }),
    );
    expect(f).toEqual({
      v: 1,
      type: 'error',
      code: 'process_spawn_failed',
      message: 'busy now',
      reason: 'busy',
    });
    const back = fromErrorFrame(f);
    expect(back.code).toBe('process_spawn_failed');
    expect(back.details?.reason).toBe('busy');
    const hidden = toErrorFrame(new Error('secret sk-ant-xyz'));
    expect(hidden.code).toBe('internal_error');
    expect(hidden.message).not.toContain('sk-ant');
  });
});

describe('checkRunnerHello', () => {
  const hello: RunnerHello = {
    protocol: 1,
    uidBase: 20000,
    maxLeases: 64,
    leaseTtlMs: 40000,
    caps: { ok: true, uidSwitch: true, chown: true, kill: true, prlimit: true, procfs: true },
  };
  it('accepts a healthy runner and flags TTL and caps problems', () => {
    expect(checkRunnerHello(hello, 40000)).toEqual([]);
    expect(checkRunnerHello(hello, 30000)[0]).toMatch(/leaseTtlMs/);
    const bad = checkRunnerHello(
      { ...hello, caps: { ...hello.caps, ok: false, prlimit: false } },
      40000,
    );
    expect(bad[0]).toMatch(/prlimit/);
  });
});
