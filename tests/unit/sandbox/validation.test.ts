import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowedEnvKeys,
  buildPrlimitCommand,
  effectiveLimits,
  isPathInside,
  pathsOverlap,
  resolveInLease,
  resolveLeasePaths,
  validateLeaseKey,
  validateSpawnArgv,
  validateSpawnEnv,
  validateSpawnEnvPaths,
} from '@orc/sandbox';
import { OrcError } from '@orc/shared';
import { ATTEMPT_ID, OP_ID } from '../../helpers/sandbox/fakes';
import { makeRoots, type SandboxRoots } from '../../helpers/sandbox/roots';

const reasonOf = async (p: Promise<unknown> | (() => unknown)): Promise<string | undefined> => {
  try {
    if (typeof p === 'function') p();
    else await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrcError);
    return (e as OrcError).details?.reason as string | undefined;
  }
  return undefined;
};

describe('kind-specific environment', () => {
  it('API key and proxy variables only for claude', () => {
    const claude = allowedEnvKeys('claude');
    for (const k of ['ANTHROPIC_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
      expect(claude.has(k)).toBe(true);
      expect(allowedEnvKeys('test').has(k)).toBe(false);
      expect(allowedEnvKeys('mcp').has(k)).toBe(false);
    }
    for (const kind of ['claude', 'test', 'mcp'] as const) {
      for (const k of [
        'PATH',
        'HOME',
        'CBM_CACHE_DIR',
        'CBM_ALLOWED_ROOT',
        'CBM_LOG_LEVEL',
        'CI',
      ]) {
        expect(allowedEnvKeys(kind).has(k), `${kind}:${k}`).toBe(true);
      }
    }
  });

  it('rejects keys outside the allowlist without echoing values', async () => {
    expect(() =>
      validateSpawnEnv('claude', {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        HTTPS_PROXY: 'http://u:p@egress:3128',
      }),
    ).not.toThrow();
    expect(await reasonOf(() => validateSpawnEnv('test', { ANTHROPIC_API_KEY: 'k' }))).toBe(
      'env_rejected',
    );
    expect(await reasonOf(() => validateSpawnEnv('mcp', { HTTPS_PROXY: 'http://x' }))).toBe(
      'env_rejected',
    );
    for (const key of ['DB_PASSWORD', 'REDIS_PASSWORD', 'ANTHROPIC_API_KEY_FILE', 'LD_PRELOAD']) {
      try {
        validateSpawnEnv('claude', { [key]: 'top-secret-value' });
        expect.unreachable(key);
      } catch (e) {
        expect((e as OrcError).code).toBe('unsafe_argument');
        expect((e as OrcError).message).not.toContain('top-secret-value');
      }
    }
    expect(await reasonOf(() => validateSpawnEnv('test', { PATH: 'a\0b' }))).toBe('env_rejected');
  });

  it('CBM_RUNTIME_DIR (per-cache daemon isolation) only for mcp, as an absolute path', async () => {
    const dir = join(process.cwd(), 'cache');
    expect(allowedEnvKeys('mcp').has('CBM_RUNTIME_DIR')).toBe(true);
    expect(allowedEnvKeys('claude').has('CBM_RUNTIME_DIR')).toBe(false);
    expect(allowedEnvKeys('test').has('CBM_RUNTIME_DIR')).toBe(false);
    expect(() =>
      validateSpawnEnv('mcp', { CBM_CACHE_DIR: dir, CBM_ALLOWED_ROOT: dir, CBM_LOG_LEVEL: 'warn', CBM_RUNTIME_DIR: dir }),
    ).not.toThrow();
    expect(await reasonOf(() => validateSpawnEnv('test', { CBM_RUNTIME_DIR: dir }))).toBe('env_rejected');
    expect(await reasonOf(() => validateSpawnEnv('claude', { CBM_RUNTIME_DIR: dir }))).toBe('env_rejected');
    expect(await reasonOf(() => validateSpawnEnv('mcp', { CBM_RUNTIME_DIR: 'rel/dir' }))).toBe('env_rejected');
  });

  it('accepts extra host keys only when passed (win32 base env in local mode)', () => {
    expect(() => validateSpawnEnv('test', { SystemRoot: 'C:\\Windows' })).toThrow();
    expect(() =>
      validateSpawnEnv('test', { SystemRoot: 'C:\\Windows' }, ['SystemRoot']),
    ).not.toThrow();
  });
});

describe('argv and lease keys', () => {
  it('argv must be non-empty, NUL-free and bounded', async () => {
    expect(() => validateSpawnArgv(['node', '-e', '1'])).not.toThrow();
    expect(await reasonOf(() => validateSpawnArgv([]))).toBe('argv_rejected');
    expect(await reasonOf(() => validateSpawnArgv(['']))).toBe('argv_rejected');
    expect(await reasonOf(() => validateSpawnArgv(['node', 'a\0b']))).toBe('argv_rejected');
    expect(await reasonOf(() => validateSpawnArgv(['node', 'x'.repeat(40 * 1024)]))).toBe(
      'argv_rejected',
    );
  });

  it('lease keys are attempt-<uuid>, op-<uuid> or a probe key of one worker', () => {
    expect(() => validateLeaseKey(`attempt-${ATTEMPT_ID}`)).not.toThrow();
    expect(() => validateLeaseKey(`op-${OP_ID}`)).not.toThrow();
    // §10.9 Claude CLI probe and §12.1 MCP probe (workerId per WORKER_ID_REGEX).
    for (const k of ['op-probe-worker-1', 'op-mcp-probe-worker-1', 'op-probe-host.example_1-42']) {
      expect(() => validateLeaseKey(k), k).not.toThrow();
    }
    for (const k of [
      'attempt-1',
      `task-${ATTEMPT_ID}`,
      `attempt-${ATTEMPT_ID.toUpperCase()}`,
      '',
      'op-probe-',
      'op-mcp-probe-',
      'op-probe-a/b',
      'op-probe-a b',
      `op-probe-${'w'.repeat(129)}`,
      'op-other-probe-w1',
      'attempt-probe-w1',
    ]) {
      expect(() => validateLeaseKey(k)).toThrow();
    }
  });
});

describe('path rules', () => {
  let r: SandboxRoots;
  let a: ReturnType<SandboxRoots['attemptPaths']>;
  let outside: string;
  beforeAll(() => {
    r = makeRoots();
    a = r.attemptPaths('t1');
    outside = join(r.base, 'outside');
    mkdirSync(outside, { recursive: true });
    // Directory link from inside a root to outside it (junction: no privilege needed on win32).
    symlinkSync(outside, join(r.ws, 'p1', 'escape'), 'junction');
  });
  afterAll(() => r.cleanup());

  it('isPathInside / pathsOverlap use separator boundaries', () => {
    const base = join(r.base, 'x');
    expect(isPathInside(base, join(base, 'y'))).toBe(true);
    expect(isPathInside(base, base)).toBe(true);
    expect(isPathInside(base, `${base}y`)).toBe(false);
    expect(isPathInside(join(base, 'y'), base)).toBe(false);
    expect(pathsOverlap(join(base, 'y'), base)).toBe(true);
    expect(pathsOverlap(join(base, 'a1'), join(base, 'a1.meta'))).toBe(false);
  });

  it('accepts attempt paths and returns real paths', async () => {
    const out = await resolveLeasePaths([a.worktree, a.meta, a.home, a.cache], r.roots);
    expect(out).toEqual([a.worktree, a.meta, a.home, a.cache]);
  });

  it('accepts the one-level probe homes <root>/probe (and nothing else one level deep)', async () => {
    const homeProbe = join(r.claudeHome, 'probe');
    const cacheProbe = join(r.cbm, 'probe');
    mkdirSync(homeProbe, { recursive: true });
    mkdirSync(cacheProbe, { recursive: true });
    mkdirSync(join(r.cbm, 'probes'), { recursive: true });
    expect(await resolveLeasePaths([homeProbe], r.roots)).toEqual([homeProbe]);
    expect(await resolveLeasePaths([cacheProbe], r.roots)).toEqual([cacheProbe]);
    expect(await reasonOf(resolveLeasePaths([join(r.cbm, 'probes')], r.roots))).toBe('path_rejected');
    expect(await reasonOf(resolveLeasePaths([join(r.cbm, 'p')], r.roots))).toBe('path_rejected');
  });

  it('probeRoots limits the probe homes to CLAUDE_HOME_ROOT and CBM_CACHE_DIR (never <WORKSPACES_ROOT>/probe)', async () => {
    const wsProbe = join(r.ws, 'probe');
    const homeProbe = join(r.claudeHome, 'probe');
    mkdirSync(wsProbe, { recursive: true });
    mkdirSync(homeProbe, { recursive: true });
    const probeRoots = [r.claudeHome, r.cbm];
    expect(await resolveLeasePaths([homeProbe], r.roots, { probeRoots })).toEqual([homeProbe]);
    expect(await reasonOf(resolveLeasePaths([wsProbe], r.roots, { probeRoots }))).toBe('path_rejected');
  });

  it('CBM_RUNTIME_DIR must resolve inside a leased path (runner side)', async () => {
    await expect(validateSpawnEnvPaths({ CBM_RUNTIME_DIR: a.cache }, [a.cache])).resolves.toBeUndefined();
    await expect(validateSpawnEnvPaths({ PATH: '/usr/bin' }, [a.cache])).resolves.toBeUndefined();
    expect(await reasonOf(validateSpawnEnvPaths({ CBM_RUNTIME_DIR: a.home }, [a.cache]))).toBe('env_rejected');
    expect(await reasonOf(validateSpawnEnvPaths({ CBM_RUNTIME_DIR: outside }, [a.cache]))).toBe('env_rejected');
    expect(await reasonOf(validateSpawnEnvPaths({ CBM_RUNTIME_DIR: join(a.cache, 'missing') }, [a.cache]))).toBe(
      'env_rejected',
    );
  });

  it('rejects roots, structure dirs, dot dirs, outside paths, links and missing paths', async () => {
    const cases = [
      r.ws,
      join(r.ws, 'p1'),
      join(r.claudeHome, 'w'),
      join(r.ws, '.repos', 'p1.git'),
      outside,
      join(r.ws, 'p1', 'escape'),
      join(r.ws, 'p1', 'missing'),
      'relative/path',
      join(r.ws, 'p1', 't1', 'a1', '..', '..', '..', '..', 'outside'),
    ];
    for (const p of cases) {
      expect(await reasonOf(resolveLeasePaths([p], r.roots)), p).toBe('path_rejected');
    }
  });

  it('rejects overlapping paths inside one request', async () => {
    expect(await reasonOf(resolveLeasePaths([a.worktree, join(a.worktree, 'src')], r.roots))).toBe(
      'path_rejected',
    );
  });

  it('cwd must resolve inside a leased path', async () => {
    expect(await resolveInLease(join(a.worktree, 'src'), [a.worktree])).toBe(
      join(a.worktree, 'src'),
    );
    expect(await reasonOf(resolveInLease(a.meta, [a.worktree]))).toBe('cwd_rejected');
    expect(await reasonOf(resolveInLease('rel', [a.worktree]))).toBe('cwd_rejected');
    expect(await reasonOf(resolveInLease(join(r.ws, 'p1', 'escape'), [join(r.ws, 'p1')]))).toBe(
      'cwd_rejected',
    );
    expect(await reasonOf(resolveInLease(outside, [a.worktree], undefined, 'path_rejected'))).toBe(
      'path_rejected',
    );
  });
});

describe('process limits', () => {
  const ceilings = { nproc: 512, nofile: 4096, fsizeBytes: 2 ** 31 };
  it('requested limits can only lower the runner ceilings', () => {
    expect(effectiveLimits(undefined, ceilings)).toEqual(ceilings);
    expect(effectiveLimits({ nproc: 64, nofile: 10_000_000 }, ceilings)).toEqual({
      nproc: 64,
      nofile: 4096,
      fsizeBytes: 2 ** 31,
    });
    expect(effectiveLimits({ fsizeBytes: 0 }, ceilings).fsizeBytes).toBe(2 ** 31);
  });

  it('wraps argv in prlimit with core=0 and an argument separator', () => {
    expect(buildPrlimitCommand('/usr/bin/prlimit', ceilings, ['node', '--version'])).toEqual({
      cmd: '/usr/bin/prlimit',
      args: [
        '--nproc=512',
        '--nofile=4096',
        `--fsize=${2 ** 31}`,
        '--core=0',
        '--',
        'node',
        '--version',
      ],
    });
  });
});
