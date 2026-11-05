// Contract §10.11 item 9 static part (ADR-0024): the runner sandbox in docker-compose.yml, and the
// lease/spawn validation the runner applies to every worker request (path escapes, foreign roots,
// secrets in the child environment). The dynamic probes inside the running stack (/run/secrets,
// TCP to mssql/redis, sibling worktrees, fork bomb) run in `npm run test:compose`.
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowedEnvKeys,
  resolveInLease,
  resolveLeasePaths,
  validateLeaseKey,
  validateSpawnArgv,
  validateSpawnCredential,
  validateSpawnEnv,
} from '@orc/sandbox';
import { OrcError } from '@orc/shared';
import { loadCompose, requireService } from '../helpers/security/deployment';
import { makeRoots } from '../helpers/sandbox/roots';
import type { SandboxRoots } from '../helpers/sandbox/roots';

const PROD = loadCompose('docker-compose.yml');
const TASK_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const TASK_B = 'bbbbbbbb-2222-4222-8222-222222222222';

async function rejection(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    if (typeof p === 'function') p();
    else await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrcError);
    const reason = (e as OrcError).details?.['reason'];
    return typeof reason === 'string' ? reason : (e as OrcError).code;
  }
  return 'accepted';
}

function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('runner container (static, docker-compose.yml)', () => {
  const runner = requireService(PROD, 'runner');

  it('is on the sandbox network only (never backend, never egress)', () => {
    expect(runner.networks).toEqual(['sandbox']);
  });

  it('receives no compose secret and no secret-bearing environment', () => {
    expect(runner.secrets).toEqual([]);
    for (const key of Object.keys(runner.environment)) {
      expect(key).not.toMatch(/^(DB_|REDIS_|MSSQL_|ANTHROPIC_|EGRESS_)|_FILE$|PASSWORD|TOKEN|SECRET/);
    }
  });

  it('mounts exactly the four sandbox volumes and never the projects directory', () => {
    expect(runner.volumes.map((v) => `${v.kind}:${v.source}:${v.target}`)).toEqual([
      'volume:workspaces:/var/lib/orc/workspaces',
      'volume:claude-home:/var/lib/orc/claude',
      'volume:cbm-cache:/var/lib/orc/cbm-cache',
      'volume:runner-sock:/run/orc-runner',
    ]);
  });

  it('is the ratified root launcher: user 0:0, cap_drop ALL + exactly six caps, no-new-privileges, read-only', () => {
    expect(runner.user).toBe('0:0');
    expect(runner.capDrop).toEqual(['ALL']);
    expect([...runner.capAdd].sort()).toEqual(['CHOWN', 'DAC_READ_SEARCH', 'FOWNER', 'KILL', 'SETGID', 'SETUID']);
    expect(runner.securityOpt).toContain('no-new-privileges:true');
    expect(runner.readOnly).toBe(true);
    expect(runner.raw['pids_limit']).toBe(8192);
  });

  it('keeps the sandbox uid range away from the worker uid (WORKER_UID 1000 outside RUNNER_UID_BASE..+N)', () => {
    const base = Number(runner.environment['RUNNER_UID_BASE']);
    const n = Number(runner.environment['RUNNER_MAX_LEASES']);
    const workerUid = Number(runner.environment['WORKER_UID']);
    expect(workerUid).toBe(1000);
    expect(base).toBeGreaterThan(workerUid);
    expect(workerUid < base || workerUid >= base + n).toBe(true);
  });

  it('worker and api cannot reach the sandbox or egress networks; egress-proxy is the only internet route', () => {
    for (const name of ['worker', 'api']) {
      const s = requireService(PROD, name);
      expect(s.networks).not.toContain('sandbox');
      expect(s.networks).not.toContain('egress');
    }
    const onEgress = [...PROD.services.values()].filter((s) => s.networks.includes('egress')).map((s) => s.name);
    expect(onEgress).toEqual(['egress-proxy']);
  });
});

describe('lease and spawn validation (runner side, §10.11 items 3 and 5)', () => {
  let r: SandboxRoots;
  let a: ReturnType<SandboxRoots['attemptPaths']>;
  let b: ReturnType<SandboxRoots['attemptPaths']>;
  let outside: string;

  beforeAll(() => {
    r = makeRoots('orc-sec-sandbox-');
    a = r.attemptPaths(TASK_A);
    b = r.attemptPaths(TASK_B);
    outside = join(r.base, 'outside');
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(r.ws, '.orc', 'run'), { recursive: true });
    // A link inside the leased worktree that points at the sibling worktree, and one out of all roots.
    linkDir(b.worktree, join(a.worktree, 'sibling-link'));
    linkDir(outside, join(a.worktree, 'outside-link'));
    linkDir(outside, join(r.ws, 'p1', 'linked-task'));
  });

  afterAll(() => {
    r.cleanup();
  });

  it('accepts the four attempt paths', async () => {
    await expect(resolveLeasePaths([a.worktree, a.meta, a.home, a.cache], r.roots)).resolves.toHaveLength(4);
  });

  it.each([
    ['relative path', () => 'p1/x/a1'],
    ['dot-dot escape to the base dir', () => join(r.ws, '..', 'outside')],
    ['a path outside every root', () => outside],
    ['a root itself', () => r.ws],
    ['the mirror directory', () => join(r.ws, '.repos')],
    ['the registry directory', () => join(r.ws, '.orc', 'run')],
    ['a junction/symlink that leaves the roots', () => join(r.ws, 'p1', 'linked-task')],
    ['NUL in the path', () => `${a.worktree}\0x`],
  ])('rejects lease path: %s', async (_name, p) => {
    expect(await rejection(resolveLeasePaths([p()], r.roots))).toBe('path_rejected');
  });

  it('rejects overlapping paths in one request', async () => {
    expect(await rejection(resolveLeasePaths([a.worktree, join(a.worktree, 'src')], r.roots))).toBe('path_rejected');
  });

  it('confines spawn cwd to the leased paths (no sibling worktree, no link escape)', async () => {
    await expect(resolveInLease(join(a.worktree, 'src'), [a.worktree])).resolves.toBe(join(a.worktree, 'src'));
    for (const cwd of [
      b.worktree,
      join(a.worktree, '..', '..', TASK_B, 'a1'),
      join(a.worktree, 'sibling-link'),
      join(a.worktree, 'outside-link'),
      outside,
      'relative/dir',
    ]) {
      expect(await rejection(resolveInLease(cwd, [a.worktree])), cwd).toBe('cwd_rejected');
    }
  });

  it('refuses secrets in the child environment for every kind; API key and proxy only for claude', () => {
    for (const kind of ['claude', 'test', 'mcp'] as const) {
      for (const key of [
        'DB_PASSWORD',
        'DB_PASSWORD_FILE',
        'REDIS_PASSWORD',
        'MSSQL_SA_PASSWORD',
        'SESSION_SECRET',
        'EGRESS_PROXY_TOKEN',
        'NODE_OPTIONS',
        'LD_PRELOAD',
        'GIT_SSH_COMMAND',
      ]) {
        expect(allowedEnvKeys(kind).has(key), `${kind}:${key}`).toBe(false);
        expect(() => validateSpawnEnv(kind, { [key]: 'x' }), `${kind}:${key}`).toThrow(OrcError);
      }
    }
    expect(() => validateSpawnEnv('test', { ANTHROPIC_API_KEY: 'k' })).toThrow(OrcError);
    expect(() => validateSpawnEnv('mcp', { HTTPS_PROXY: 'http://orc:t@egress-proxy:3128' })).toThrow(OrcError);
    expect(() => validateSpawnEnv('claude', { ANTHROPIC_API_KEY: 'k', PATH: '/usr/bin' })).not.toThrow();
  });

  it('keeps the OAuth credential (CLAUDE_CODE_OAUTH_TOKEN*, credentialFd) to kind claude, one credential at a time (ADR-0036 m.4)', async () => {
    const token = 'sk-ant-oat01-SANDBOXESCAPE_SEC_000000000000000000';
    for (const kind of ['test', 'mcp'] as const) {
      for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE']) {
        expect(allowedEnvKeys(kind).has(key), `${kind}:${key}`).toBe(false);
        expect(await rejection(() => validateSpawnEnv(kind, { [key]: key.endsWith('DESCRIPTOR') ? '3' : token })), `${kind}:${key}`).toBe(
          'env_rejected',
        );
      }
      expect(await rejection(() => validateSpawnCredential(kind, {}, token)), kind).toBe('env_rejected');
    }
    // claude: each credential alone is accepted; any two together, a "never set" key or the _FILE form are not.
    expect(() => validateSpawnEnv('claude', { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' })).not.toThrow();
    expect(() => validateSpawnCredential('claude', { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' }, token)).not.toThrow();
    expect(() => validateSpawnEnv('claude', { CLAUDE_CODE_OAUTH_TOKEN: token })).not.toThrow();
    const refused: Record<string, string>[] = [
      { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: token },
      { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' },
      { CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' },
      { CLAUDE_CODE_OAUTH_TOKEN_FILE: '/run/secrets/claude_oauth_token' },
      { ANTHROPIC_AUTH_TOKEN: token },
      { ANTHROPIC_BASE_URL: 'https://evil.example.invalid' },
      { CLAUDE_CODE_SIMPLE: '1' },
    ];
    for (const env of refused) {
      expect(await rejection(() => validateSpawnEnv('claude', env)), Object.keys(env).join('+')).toBe('env_rejected');
    }
    // The fd variable only together with a credential, and only naming fd 3.
    expect(await rejection(() => validateSpawnCredential('claude', { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' }, undefined))).toBe(
      'env_rejected',
    );
    expect(await rejection(() => validateSpawnCredential('claude', { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '4' }, token))).toBe(
      'env_rejected',
    );
    expect(await rejection(() => validateSpawnCredential('claude', {}, token))).toBe('env_rejected');
  });

  it('validates lease keys and argv (no NUL, bounded size)', async () => {
    for (const key of ['attempt-../../etc', `attempt-${TASK_A}/..`, 'op-', 'x']) {
      expect(await rejection(() => validateLeaseKey(key)), key).toBe('path_rejected');
    }
    expect(await rejection(() => validateSpawnArgv(['node', 'a\0b']))).toBe('argv_rejected');
    expect(await rejection(() => validateSpawnArgv([]))).toBe('argv_rejected');
  });
});
