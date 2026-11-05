import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFileProcessRegistry,
  isGroupAlive,
  isProcessAlive,
  killProcessTree,
  runProcess,
  spawnSupervised,
  sweepOrphans,
  type ProcessRegistryEntry,
} from '@orc/shared/node';

const NODE = process.execPath;
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'),
);
const ATTEMPT = '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-shared-proc-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base = () => ({
  cwd: dir,
  env,
  timeoutMs: 20_000,
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  killGraceMs: 500,
});

const waitFor = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
};

describe('runProcess', () => {
  it('captures stdout/stderr, exit code and stdin without a shell', async () => {
    let spawnedPid = 0;
    const r = await runProcess(
      NODE,
      [
        '-e',
        'process.stdin.on("data", d => process.stdout.write("in:" + d)); process.stdin.on("end", () => { process.stderr.write("err"); process.exit(3); })',
      ],
      { ...base(), stdin: 'hello', onSpawn: (pid) => (spawnedPid = pid) },
    );
    expect(r.exitCode).toBe(3);
    expect(r.stdout.toString()).toBe('in:hello');
    expect(r.stderr.toString()).toBe('err');
    expect(r.timedOut).toBe(false);
    expect(r.spawnError).toBeNull();
    expect(r.pid).toBe(spawnedPid);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes shell metacharacters as literal arguments', async () => {
    const arg = '$(echo pwned) && echo x | y; `z` %PATH%';
    const r = await runProcess(NODE, ['-e', 'process.stdout.write(process.argv[1])', arg], base());
    expect(r.stdout.toString()).toBe(arg);
  });

  it('bounds captured output and flags truncation', async () => {
    const r = await runProcess(NODE, ['-e', 'process.stdout.write("x".repeat(100000))'], {
      ...base(),
      maxStdoutBytes: 1000,
    });
    expect(r.stdout.length).toBe(1000);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it('reports spawn errors without rejecting', async () => {
    const r = await runProcess(join(dir, 'does-not-exist-binary'), [], base());
    expect(r.spawnError).not.toBeNull();
    expect(r.pid).toBeNull();
    expect(r.exitCode).toBeNull();
  });

  it('kills the process tree on timeout', { timeout: 60_000 }, async () => {
    const r = await runProcess(
      NODE,
      [
        '-e',
        'const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio:"ignore"}); console.log(c.pid); setInterval(()=>{},1000)',
      ],
      { ...base(), timeoutMs: 1500, killGraceMs: 300 },
    );
    expect(r.timedOut).toBe(true);
    expect(r.exitCode === 0).toBe(false);
    const grandchild = Number(r.stdout.toString().trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(await waitFor(() => !isProcessAlive(grandchild), 10_000)).toBe(true);
    if (r.pid !== null) expect(isProcessAlive(r.pid)).toBe(false);
  });

  it('aborts on signal (before and during the run)', { timeout: 60_000 }, async () => {
    const pre = new AbortController();
    pre.abort();
    const skipped = await runProcess(NODE, ['-e', ''], { ...base(), signal: pre.signal });
    expect(skipped).toMatchObject({ aborted: true, pid: null });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const r = await runProcess(NODE, ['-e', 'setInterval(()=>{},1000)'], {
      ...base(),
      signal: ac.signal,
      killGraceMs: 200,
    });
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
  });
});

describe('spawnSupervised / killProcessTree', () => {
  it('stops a running process and reports no survivors', { timeout: 60_000 }, async () => {
    const p = spawnSupervised(NODE, ['-e', 'setInterval(()=>{},1000)'], { cwd: dir, env });
    expect(p.pid).toBeGreaterThan(0);
    expect(p.pgid).toBe(process.platform === 'win32' ? null : p.pid);
    const result = await p.stop({ graceMs: 1000 });
    expect(result.survivors).toEqual([]);
    expect(result.graceful || result.forced).toBe(true);
    const exit = await p.exited;
    expect(exit.exitCode === 0).toBe(false);
    expect(await p.stop({ graceMs: 1000 })).toBe(result);
  });

  it('forceImmediately skips the graceful step', { timeout: 60_000 }, async () => {
    const p = spawnSupervised(
      NODE,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(()=>{},1000)'],
      { cwd: dir, env },
    );
    const r = await p.stop({ graceMs: 10_000, forceImmediately: true });
    expect(r.forced).toBe(true);
    expect(r.graceful).toBe(false);
    expect(r.survivors).toEqual([]);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it('throws ProcessSpawnError for a missing executable', () => {
    expect(() => spawnSupervised(join(dir, 'missing-bin'), [], { cwd: dir, env })).toThrow(
      expect.objectContaining({ code: 'process_spawn_failed' }) as Error,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'credentialFd: delivers the value on fd 3 only (never argv or env) and ends the pipe',
    { timeout: 30_000 },
    async () => {
      const secret = 'sk-ant-oat01-fd-transport-0123456789abcdefghij';
      const script =
        'const fs=require("fs");const v=fs.readFileSync(3,"utf8");' +
        'const leaked=JSON.stringify(process.env).includes(v)||process.argv.join(" ").includes(v);' +
        'process.stdout.write(JSON.stringify({v,leaked,fd:process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR}))';
      const child = spawnSupervised(NODE, ['-e', script], {
        cwd: dir,
        env: { ...env, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' },
        credentialFd: secret,
      });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      await child.exited;
      await new Promise((r) => setTimeout(r, 50));
      const out = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      expect(out).toEqual({ v: secret, leaked: false, fd: '3' });
    },
  );

  it('credentialFd: asks for four stdio pipes; without it the spawn options stay unchanged', () => {
    const seen: unknown[] = [];
    const fakeSpawn = ((cmd: string, args: readonly string[], opts: unknown) => {
      seen.push(opts);
      return spawn(NODE, ['-e', ''], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    }) as unknown as typeof spawn;
    const withFd = spawnSupervised(NODE, [], {
      cwd: dir,
      env,
      spawn: fakeSpawn,
      platform: 'posix',
      credentialFd: 'x',
    });
    const without = spawnSupervised(NODE, [], {
      cwd: dir,
      env,
      spawn: fakeSpawn,
      platform: 'posix',
    });
    expect(seen[0]).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe', 'pipe'], shell: false });
    expect('stdio' in (seen[1] as object)).toBe(false);
    void withFd.exited;
    void without.exited;
  });

  it.skipIf(process.platform === 'win32')(
    'credentialFd: kills the already started child (whole group) when fd 3 is missing',
    { timeout: 30_000 },
    async () => {
      let started: ReturnType<typeof spawn> | undefined;
      const fakeSpawn = ((cmd: string, args: readonly string[], opts: object) => {
        // Deliberately no fourth pipe: stdio[3] is undefined.
        started = spawn(cmd, [...args], { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
        return started;
      }) as unknown as typeof spawn;
      const secret = 'sk-ant-oat01-must-not-appear-0123456789abcdef';
      let message = '';
      try {
        spawnSupervised(NODE, ['-e', 'setInterval(()=>{},1000)'], {
          cwd: dir,
          env,
          spawn: fakeSpawn,
          platform: 'posix',
          credentialFd: secret,
        });
      } catch (e) {
        message = JSON.stringify({
          m: (e as Error).message,
          d: (e as { details?: unknown }).details,
        });
      }
      expect(message).toContain('credential_fd_missing');
      expect(message).not.toContain(secret);
      const child = started;
      expect(child?.pid).toBeGreaterThan(0);
      expect(await waitFor(() => !isProcessAlive(child?.pid ?? 0), 10_000)).toBe(true);
    },
  );

  it('credentialFd: refused on win32 before any spawn (the fd path does not work there)', () => {
    let spawned = false;
    const fakeSpawn = (() => {
      spawned = true;
      throw new Error('must not spawn');
    }) as unknown as typeof spawn;
    expect(() =>
      spawnSupervised(NODE, [], {
        cwd: dir,
        env,
        spawn: fakeSpawn,
        platform: 'win32',
        credentialFd: 'x',
      }),
    ).toThrow(expect.objectContaining({ code: 'process_spawn_failed' }) as Error);
    expect(spawned).toBe(false);
  });

  it('killProcessTree on an exited pid is a no-op', { timeout: 30_000 }, async () => {
    const child = spawn(NODE, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid ?? 0;
    await new Promise((r) => child.once('exit', r));
    const r = await killProcessTree(pid, { pgid: null, graceMs: 100 });
    expect(r).toMatchObject({ forced: false, survivors: [] });
  });

  it('liveness probes', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-5)).toBe(false);
    expect(isGroupAlive(0)).toBe(false);
  });
});

describe('file process registry', () => {
  const entry = (key: string, pid: number): ProcessRegistryEntry => ({
    key,
    kind: 'claude',
    pid,
    pgid: null,
    attemptId: ATTEMPT,
    workerId: 'w1',
    startedAt: '2026-11-02T10:00:00.000Z',
    command: 'node',
  });

  it('adds, lists, overwrites and removes entries atomically', async () => {
    const reg = createFileProcessRegistry(join(dir, 'reg1'));
    expect(await reg.list()).toEqual([]);
    await reg.add(entry(`claude-${ATTEMPT}`, 111));
    await reg.add(entry(`claude-${ATTEMPT}`, 222));
    await reg.add(entry('git-op1', 333));
    const listed = await reg.list();
    expect(listed.map((e) => [e.key, e.pid])).toEqual([
      [`claude-${ATTEMPT}`, 222],
      ['git-op1', 333],
    ]);
    await reg.remove('git-op1');
    await reg.remove('git-op1');
    expect((await reg.list()).map((e) => e.key)).toEqual([`claude-${ATTEMPT}`]);
  });

  it('rejects unsafe keys and invalid entries, skips corrupt files', async () => {
    const regDir = join(dir, 'reg2');
    const reg = createFileProcessRegistry(regDir);
    await expect(reg.add(entry('../escape', 1))).rejects.toMatchObject({ code: 'unsafe_argument' });
    await expect(reg.add({ ...entry('ok', 1), pid: 0 })).rejects.toMatchObject({
      code: 'unsafe_argument',
    });
    await expect(reg.remove('a/b')).rejects.toMatchObject({ code: 'unsafe_argument' });
    mkdirSync(regDir, { recursive: true });
    writeFileSync(join(regDir, 'corrupt.json'), '{not json');
    writeFileSync(join(regDir, 'mismatch.json'), JSON.stringify(entry('other', 5)));
    expect(await reg.list()).toEqual([]);
  });
});

/** Minimal fake /proc with one pid directory (environ + cmdline); keeps POSIX sweeps away from real processes. */
function fakeProc(name: string, pid: number, environ: string): string {
  const root = join(dir, name);
  mkdirSync(join(root, String(pid)), { recursive: true });
  writeFileSync(join(root, String(pid), 'environ'), environ);
  writeFileSync(join(root, String(pid), 'cmdline'), `${NODE}\0-e\0`);
  return root;
}

describe('sweepOrphans', () => {
  const platform = process.platform === 'win32' ? 'win32' : 'posix';
  const isWin = platform === 'win32';

  it('removes stale entries of dead processes and keeps active ones', async () => {
    const reg = createFileProcessRegistry(join(dir, 'reg3'));
    const dead = spawn(NODE, ['-e', ''], { stdio: 'ignore' });
    const deadPid = dead.pid ?? 0;
    await new Promise((r) => dead.once('exit', r));
    const mk = (key: string, pid: number): ProcessRegistryEntry => ({
      key,
      kind: 'test',
      pid,
      pgid: null,
      attemptId: null,
      workerId: 'w1',
      startedAt: '2026-11-02T10:00:00.000Z',
      command: 'node',
    });
    await reg.add(mk('test-dead', deadPid));
    await reg.add(mk('test-active', process.pid));
    const report = await sweepOrphans({
      registry: reg,
      activeKeys: new Set(['test-active']),
      activeAttemptIds: new Set(),
      platform,
      markerEnv: 'ORC_ATTEMPT_ID',
      procRoot: join(dir, 'no-proc'),
    });
    expect(report.checked).toBe(1);
    expect(report.killed).toEqual([]);
    expect((await reg.list()).map((e) => e.key)).toEqual(['test-active']);
  });

  it('kills a verified live orphan from the registry', { timeout: 60_000 }, async () => {
    const reg = createFileProcessRegistry(join(dir, 'reg4'));
    const orphan = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      detached: !isWin,
      env: { ...env, ORC_ATTEMPT_ID: ATTEMPT },
    });
    const pid = orphan.pid ?? 0;
    const exited = new Promise((r) => orphan.once('exit', r));
    try {
      await reg.add({
        key: `claude-${ATTEMPT}`,
        kind: 'claude',
        pid,
        pgid: isWin ? null : pid,
        attemptId: ATTEMPT,
        workerId: 'w1',
        startedAt: '2026-11-02T10:00:00.000Z',
        command: 'node',
      });
      const report = await sweepOrphans({
        registry: reg,
        activeKeys: new Set(),
        activeAttemptIds: new Set(),
        platform,
        markerEnv: 'ORC_ATTEMPT_ID',
        procRoot: fakeProc('proc4', pid, `PATH=/bin\0ORC_ATTEMPT_ID=${ATTEMPT}\0`),
      });
      expect(report.killed).toContainEqual({ pid, key: `claude-${ATTEMPT}`, via: 'registry' });
      await exited;
      expect(await reg.list()).toEqual([]);
    } finally {
      if (isProcessAlive(pid)) orphan.kill('SIGKILL');
    }
  });

  it(
    'does not kill a live process whose identity does not match (pid reuse)',
    { timeout: 60_000 },
    async () => {
      const reg = createFileProcessRegistry(join(dir, 'reg5'));
      const other = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      const pid = other.pid ?? 0;
      const otherAttempt = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
      try {
        await reg.add({
          key: 'git-op9',
          kind: 'git',
          pid,
          pgid: null,
          attemptId: isWin ? null : ATTEMPT,
          workerId: 'w1',
          startedAt: '2026-11-02T10:00:00.000Z',
          command: 'git',
        });
        const report = await sweepOrphans({
          registry: reg,
          activeKeys: new Set(),
          activeAttemptIds: new Set([otherAttempt]),
          platform,
          markerEnv: 'ORC_ATTEMPT_ID',
          procRoot: fakeProc('proc5', pid, `PATH=/bin\0ORC_ATTEMPT_ID=${otherAttempt}\0`),
        });
        expect(report.killed).toEqual([]);
        expect(isProcessAlive(pid)).toBe(true);
        expect(await reg.list()).toEqual([]);
      } finally {
        other.kill('SIGKILL');
      }
    },
  );

  it(
    'marker scan kills same-uid processes of inactive attempts (POSIX /proc)',
    { timeout: 60_000 },
    async () => {
      if (isWin) return;
      const victim = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      const pid = victim.pid ?? 0;
      const exited = new Promise((r) => victim.once('exit', r));
      try {
        const report = await sweepOrphans({
          registry: createFileProcessRegistry(join(dir, 'reg6')),
          activeKeys: new Set(),
          activeAttemptIds: new Set(),
          platform,
          markerEnv: 'ORC_ATTEMPT_ID',
          procRoot: fakeProc('proc6', pid, `ORC_ATTEMPT_ID=${ATTEMPT.toUpperCase()}\0`),
        });
        expect(report.killed).toEqual([{ pid, key: `marker-${ATTEMPT}`, via: 'marker' }]);
        await exited;
      } finally {
        if (isProcessAlive(pid)) victim.kill('SIGKILL');
      }
    },
  );
});
