// SANDBOX_MODE=local launcher (all platforms): same validation as the runner, current user.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalLauncher, validateSpawnEnvPaths } from '@orc/sandbox';
import { OrcError } from '@orc/shared';
import { ATTEMPT_ID, ATTEMPT_ID_2, OP_ID, silentLogger } from '../../helpers/sandbox/fakes';
import { makeRoots, type SandboxRoots } from '../../helpers/sandbox/roots';

const NODE = process.execPath;
const ENV = { PATH: process.env.PATH ?? '' };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function roots(): SandboxRoots {
  const r = makeRoots('orc-local-');
  cleanups.push(() => r.cleanup());
  return r;
}

async function reason(p: Promise<unknown>): Promise<[string, unknown]> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrcError);
    return [(e as OrcError).code, (e as OrcError).details?.reason];
  }
  return ['resolved', undefined];
}

describe('createLocalLauncher', () => {
  it('runs a validated child inside the lease and releases idempotently', async () => {
    const r = roots();
    const a = r.attemptPaths('t1');
    const launcher = createLocalLauncher({ logger: silentLogger(), killGraceMs: 200 });
    expect(launcher.mode).toBe('local');
    const lease = await launcher.acquire({
      key: `attempt-${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
      workerId: 'w1',
      paths: [a.worktree, a.meta],
    });
    expect(lease.uid).toBeNull();
    const proc = await launcher.spawn(lease, {
      kind: 'test',
      cmd: NODE,
      args: ['-e', 'process.stdout.write(process.cwd())'],
      cwd: join(a.worktree, 'src'),
      env: ENV,
    });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    expect((await proc.exited).exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString().toLowerCase()).toContain('src');

    const listed = await launcher.listLeases();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: lease.id, key: lease.key, uid: null, workerId: 'w1' });
    const m = await lease.measure(a.worktree, 1000);
    expect(m.entries).toBeGreaterThan(2);
    await lease.renew();

    const rel = await lease.release();
    expect(rel).toMatchObject({ reclaimed: true, kill: { survivors: [] } });
    expect(await lease.release()).toBe(rel);
    expect(await reason(lease.renew())).toEqual(['process_spawn_failed', 'lease_expired']);
    expect(await launcher.listLeases()).toEqual([]);
    expect(await launcher.releaseLease('unknown')).toMatchObject({ reclaimed: true });
    await launcher.close();
  });

  it('applies the runner checks: key, paths, overlap, cwd, env per kind, argv', async () => {
    const r = roots();
    const a = r.attemptPaths('t2');
    const launcher = createLocalLauncher({ logger: silentLogger() });
    const req = {
      key: `attempt-${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
      workerId: 'w',
      paths: [a.worktree],
    };
    expect(await reason(launcher.acquire({ ...req, key: 'bad key' }))).toEqual([
      'validation_failed',
      'path_rejected',
    ]);
    expect(await reason(launcher.acquire({ ...req, paths: ['relative/path'] }))).toEqual([
      'path_escape',
      'path_rejected',
    ]);
    expect(await reason(launcher.acquire({ ...req, paths: [join(r.ws, 'missing')] }))).toEqual([
      'path_escape',
      'path_rejected',
    ]);
    expect(
      await reason(launcher.acquire({ ...req, paths: [a.worktree, join(a.worktree, 'src')] })),
    ).toEqual(['path_escape', 'path_rejected']);
    expect(
      await reason(
        launcher.acquire({ ...req, paths: Array.from({ length: 17 }, () => a.worktree) }),
      ),
    ).toEqual(['path_escape', 'path_rejected']);
    const lease = await launcher.acquire(req);
    expect(await reason(launcher.acquire({ ...req, paths: [a.meta] }))).toEqual([
      'process_spawn_failed',
      'busy',
    ]);
    expect(
      await reason(
        launcher.acquire({
          key: `op-${OP_ID}`,
          attemptId: null,
          workerId: 'w',
          paths: [join(a.worktree, 'src')],
        }),
      ),
    ).toEqual(['process_spawn_failed', 'busy']);

    const spec = { kind: 'test' as const, cmd: NODE, args: ['-v'], cwd: a.worktree, env: ENV };
    expect(await reason(launcher.spawn(lease, { ...spec, cwd: a.meta }))).toEqual([
      'path_escape',
      'cwd_rejected',
    ]);
    const rejected: Record<string, string>[] = [
      { ANTHROPIC_API_KEY: 'k' },
      { HTTP_PROXY: 'http://p:1' },
      { REDIS_URL: 'x' },
    ];
    for (const extra of rejected) {
      expect(await reason(launcher.spawn(lease, { ...spec, env: { ...ENV, ...extra } }))).toEqual([
        'unsafe_argument',
        'env_rejected',
      ]);
    }
    expect((await reason(launcher.spawn(lease, { ...spec, args: ['a\u0000b'] })))[1]).toBe(
      'argv_rejected',
    );
    const claude = await launcher.spawn(lease, {
      ...spec,
      kind: 'claude',
      env: { ...ENV, ANTHROPIC_API_KEY: 'k', HTTPS_PROXY: 'http://p:1' },
    });
    expect((await claude.exited).exitCode).toBe(0);

    const other = r.attemptPaths('t3');
    const second = await launcher.acquire({
      key: `attempt-${ATTEMPT_ID_2}`,
      attemptId: ATTEMPT_ID_2,
      workerId: 'w',
      paths: [other.worktree],
    });
    await launcher.close();
    expect(await reason(second.renew())).toEqual(['process_spawn_failed', 'lease_expired']);
    expect(await reason(launcher.acquire(req))).toEqual(['process_spawn_failed', 'closed']);
  });

  it('local mode by design: CBM_RUNTIME_DIR may lie outside the lease (mcp-manager per-cache temp dir), absolute and mcp-only', async () => {
    const r = roots();
    const a = r.attemptPaths('t4');
    // Shape of the mcp-manager local runtime dir `<tmpdir>/orc-cbm-rt/<16 hex>`: outside every lease path.
    const runtimeDir = join(r.base, 'orc-cbm-rt', '0123456789abcdef');
    mkdirSync(runtimeDir, { recursive: true });
    const paths = [a.worktree, a.cache];
    // The runner-side check rejects exactly this value; the local launcher deliberately does not apply it.
    expect((await reason(validateSpawnEnvPaths({ CBM_RUNTIME_DIR: runtimeDir }, paths)))[1]).toBe(
      'env_rejected',
    );
    const launcher = createLocalLauncher({ logger: silentLogger(), killGraceMs: 200 });
    const lease = await launcher.acquire({
      key: `op-${OP_ID}`,
      attemptId: null,
      workerId: 'w',
      paths,
    });
    const cbm = {
      CBM_CACHE_DIR: a.cache,
      CBM_ALLOWED_ROOT: a.worktree,
      CBM_LOG_LEVEL: 'warn',
      CBM_RUNTIME_DIR: runtimeDir,
    };
    const spec = {
      kind: 'mcp' as const,
      cmd: NODE,
      args: ['-e', 'process.stdout.write(process.env.CBM_RUNTIME_DIR ?? "")'],
      cwd: a.worktree,
      env: { ...ENV, ...cbm },
    };
    const proc = await launcher.spawn(lease, spec);
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    expect((await proc.exited).exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe(runtimeDir);

    expect(
      await reason(
        launcher.spawn(lease, { ...spec, env: { ...ENV, ...cbm, CBM_RUNTIME_DIR: 'rel/rt' } }),
      ),
    ).toEqual(['unsafe_argument', 'env_rejected']);
    for (const kind of ['claude', 'test'] as const) {
      expect(
        await reason(
          launcher.spawn(lease, { ...spec, kind, env: { ...ENV, CBM_RUNTIME_DIR: runtimeDir } }),
        ),
        kind,
      ).toEqual(['unsafe_argument', 'env_rejected']);
    }
    await launcher.close();
  });
});
