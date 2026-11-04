// D1-WP8 / ADR-0033: safe.directory for the git process the local transport starts itself
// (upload-pack of mirror_fetch). `-c` does not reach it (git clears GIT_CONFIG_PARAMETERS /
// GIT_CONFIG_COUNT for local transports), so mirror_fetch carries a per-call, read-only
// GIT_CONFIG_GLOBAL file with exactly the source git dir; every other op keeps /dev/null.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GIT_ENV_ALLOWLIST, UnsafeArgumentError, WINDOWS_BASE_ENV } from '@orc/security';
import {
  createGitManager,
  GitError,
  type GitManager,
  type GitManagerConfig,
} from '@orc/git-manager';
import { NULL_GLOBAL_CONFIG, safeDirectoryConfig } from '../../../packages/git-manager/src/argv';
import { gitEnv } from '../../../packages/git-manager/src/runner';
import { createFakeSpawn, type FakeCall, type FakeSpawn } from '../../helpers/git/fake-spawn';
import {
  baseConfig,
  HOST_PLATFORM,
  memoryLock,
  memoryRecorder,
  removeTempDir,
  silentLogger,
} from '../../helpers/git/fixtures';
import {
  P,
  scriptedGit,
  unitLayout,
  type ScriptOptions,
  type UnitLayout,
} from '../../helpers/git/unit-layout';

const HEADER = '# @orc/git-manager per-call transport config (ADR-0033); removed after the call';
const CTX = { projectId: P, taskId: null, attemptId: null, correlationId: 'corr-t' };

describe('safeDirectoryConfig (pure, every host)', () => {
  it('posix: one quoted safe.directory per exact path, deduplicated, nothing else', () => {
    expect(safeDirectoryConfig(['/var/lib/orc/projects/smoke-sample/.git'], 'posix')).toBe(
      `${HEADER}\n[safe]\n\tdirectory = "/var/lib/orc/projects/smoke-sample/.git"\n`,
    );
    expect(safeDirectoryConfig(['/p/a/.git', '/p/a/.git', '/p/A/.git'], 'posix')).toBe(
      `${HEADER}\n[safe]\n\tdirectory = "/p/a/.git"\n\tdirectory = "/p/A/.git"\n`,
    );
  });

  it('escapes backslash and double quote inside the quoted value (spaces, # and ; stay literal)', () => {
    expect(safeDirectoryConfig(['/p/we"ird\\name #1; x/.git'], 'posix')).toBe(
      `${HEADER}\n[safe]\n\tdirectory = "/p/we\\"ird\\\\name #1; x/.git"\n`,
    );
  });

  it("win32: '/'-spelled like the argv prefix, case-insensitive dedupe, drive or UNC paths", () => {
    expect(
      safeDirectoryConfig(
        ['C:\\Projects\\App\\.git', 'c:/projects/app/.git', '\\\\srv\\share\\repo.git'],
        'win32',
      ),
    ).toBe(
      `${HEADER}\n[safe]\n\tdirectory = "C:/Projects/App/.git"\n\tdirectory = "//srv/share/repo.git"\n`,
    );
  });

  it.each([
    ['posix', ''],
    ['posix', '*'],
    ['posix', 'relative/.git'],
    ['posix', '~/repo/.git'],
    ['posix', '%(prefix)/repo/.git'],
    ['posix', '/p/x\n[core]\n\tfsmonitor = /tmp/evil'],
    ['posix', '/p/x\r'],
    ['posix', '/p/x\ty'],
    ['posix', '/p/x\u0000'],
    ['posix', '/p/x\u007f'],
    ['win32', '*'],
    ['win32', '/p/x/.git'],
    ['win32', 'C:relative\\.git'],
    ['win32', 'C:\\p\\x\n[include]\n\tpath = C:/evil'],
  ] as const)(
    '%s rejects %j (no wildcard, interpolation, relative path or injected line)',
    (platform, dir) => {
      expect(() => safeDirectoryConfig([dir], platform)).toThrow(UnsafeArgumentError);
    },
  );

  it('rejects an empty list', () => {
    expect(() => safeDirectoryConfig([], 'posix')).toThrow(UnsafeArgumentError);
  });
});

describe('gitEnv (pure, every host)', () => {
  for (const platform of ['posix', 'win32'] as const) {
    it(`${platform}: GIT_CONFIG_GLOBAL is /dev/null unless a transport config file is given`, () => {
      const source = {
        PATH: '/usr/bin',
        GIT_CONFIG_PARAMETERS: "'safe.directory'='*'",
        HOME: '/root',
      };
      expect(NULL_GLOBAL_CONFIG).toBe('/dev/null');
      const plain = gitEnv(source, '/ws/.orc/git-home', platform);
      expect(plain).toMatchObject({
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: '/ws/.orc/git-home',
      });
      const withFile = gitEnv(
        source,
        '/ws/.orc/git-home',
        platform,
        '/ws/.orc/git-config/w1/f.gitconfig',
      );
      expect(withFile).toEqual({
        ...plain,
        GIT_CONFIG_GLOBAL: '/ws/.orc/git-config/w1/f.gitconfig',
      });
      const allowed = new Set(
        [...GIT_ENV_ALLOWLIST, ...(platform === 'win32' ? WINDOWS_BASE_ENV : [])].map((k) =>
          k.toUpperCase(),
        ),
      );
      for (const key of Object.keys(withFile)) expect(allowed.has(key.toUpperCase())).toBe(true);
      expect(withFile).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
    });
  }
});

describe('mirror_fetch transport config through the executor (fake spawn)', () => {
  let L: UnitLayout;
  let fake: FakeSpawn;
  let gm: GitManager;
  let seen: { file: string; text: string; mode: number }[];
  const configDir = (): string => path.join(L.ws, '.orc', 'git-config', 'worker-1');

  const build = (script: ScriptOptions = {}, overrides: Partial<GitManagerConfig> = {}): void => {
    fake = createFakeSpawn(scriptedGit(L, script));
    gm = createGitManager(
      baseConfig({ projectsRoot: L.pr, workspacesRoot: L.ws, hooksDir: L.hooks }, overrides),
      {
        logger: silentLogger(),
        recorder: memoryRecorder(),
        lock: memoryLock(),
        workerId: 'worker-1',
        spawn: fake.spawn,
      },
    );
  };

  /** Captures the config file while the (fake) fetch process is "running". */
  const capture = (call: FakeCall): void => {
    const file = call.env['GIT_CONFIG_GLOBAL'] ?? '';
    seen.push({ file, text: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777 });
  };

  const fetchCalls = () => fake.gitCalls().filter((c) => c.rest.includes('fetch'));

  beforeEach(() => {
    L = unitLayout(HOST_PLATFORM);
    seen = [];
  });

  afterEach(() => {
    removeTempDir(L.root);
  });

  it('only mirror_fetch gets the file: exactly the source git dir, 0400, removed afterwards', async () => {
    build({
      override: (sub, _after, call) => {
        if (sub !== 'fetch') return undefined;
        capture(call);
        return { code: 0 };
      },
    });
    await gm.syncMirror(P, 'repo', CTX);
    expect(seen).toHaveLength(1);
    const [entry] = seen;
    expect(path.dirname(path.resolve(entry?.file ?? ''))).toBe(configDir());
    expect(path.basename(entry?.file ?? '')).toMatch(/^mirror_fetch-[0-9a-f-]{36}\.gitconfig$/);
    expect(entry?.file).toBe(L.gp(entry?.file ?? ''));
    expect(entry?.text).toBe(safeDirectoryConfig([L.srcGitDir], HOST_PLATFORM));
    expect(entry?.text).not.toContain(L.gp(L.M));
    if (HOST_PLATFORM === 'posix') {
      expect(entry?.mode).toBe(0o400);
      expect(statSync(configDir()).mode & 0o777).toBe(0o700);
    }
    // The §11.3 argv prefix is unchanged (the client still gets -c safe.directory for both repos).
    const fetch = fetchCalls()[0];
    expect(fetch?.prefix).toEqual(
      expect.arrayContaining([
        `safe.directory=${L.gp(L.M)}`,
        `safe.directory=${L.gp(L.srcGitDir)}`,
        'protocol.file.allow=always',
      ]),
    );
    const others = fake.gitCalls().filter((c) => !c.rest.includes('fetch'));
    expect(others.length).toBeGreaterThan(5);
    for (const c of others) expect(c.call.env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    expect(readdirSync(configDir())).toEqual([]);
    // A second sync uses a fresh file name.
    await gm.syncMirror(P, 'repo', CTX);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.file).not.toBe(seen[0]?.file);
    expect(readdirSync(configDir())).toEqual([]);
  });

  it('removes the file when git fails (exit 128)', async () => {
    build({
      override: (sub, _after, call) => {
        if (sub !== 'fetch') return undefined;
        capture(call);
        return {
          code: 128,
          stderr: "fatal: detected dubious ownership in repository at '/x/.git'\n",
        };
      },
    });
    await expect(gm.syncMirror(P, 'repo', CTX)).rejects.toMatchObject({
      code: 'git_failed',
      details: { operation: 'mirror_fetch', exitCode: 128 },
    });
    expect(seen).toHaveLength(1);
    expect(existsSync(seen[0]?.file ?? '')).toBe(false);
    expect(readdirSync(configDir())).toEqual([]);
  });

  it('removes the file when git cannot be started', async () => {
    build({
      override: (sub, _after, call) => {
        if (sub !== 'fetch') return undefined;
        capture(call);
        return { spawnError: true };
      },
    });
    await expect(gm.syncMirror(P, 'repo', CTX)).rejects.toMatchObject({
      code: 'git_failed',
      details: { reason: 'spawn_failed' },
    });
    expect(seen).toHaveLength(1);
    expect(readdirSync(configDir())).toEqual([]);
  });

  it('removes the file when the fetch times out', async () => {
    build(
      {
        override: (sub, _after, call) => {
          if (sub !== 'fetch') return undefined;
          capture(call);
          return { code: 0, delayMs: 400 };
        },
      },
      { fetchTimeoutMs: 100, killGraceMs: 10 },
    );
    await expect(gm.syncMirror(P, 'repo', CTX)).rejects.toMatchObject({ code: 'git_timeout' });
    expect(seen).toHaveLength(1);
    expect(readdirSync(configDir())).toEqual([]);
  });

  it('fails closed without spawning git when the config file cannot be created', async () => {
    build();
    // A regular file where the worker's config directory belongs.
    mkdirSync(path.dirname(configDir()), { recursive: true });
    writeFileSync(configDir(), 'not a directory');
    const err: unknown = await gm.syncMirror(P, 'repo', CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err).toMatchObject({
      details: { operation: 'mirror_fetch', reason: 'transport_config_failed' },
    });
    expect(fetchCalls()).toHaveLength(0);
  });
});
