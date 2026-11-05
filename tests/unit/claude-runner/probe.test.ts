import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLAUDE_REQUIRED_FLAGS,
  ClaudeProbeError,
  createClaudeRunner,
  evaluateClaudeProbe,
  helpHasFlag,
  parsePermissionModes,
  requiredClaudeFlags,
  type ClaudeRunnerConfig,
} from '@orc/claude-runner';
import { LeaseAcquireRequestSchema, resolveLeasePaths } from '@orc/sandbox';
import { createSecretRegistry } from '@orc/security';
import type { LaunchLeaseRequest } from '@orc/shared/node';
import { FAKE_HELP_PATH } from '../../helpers/claude/fake-claude';
import { createMemoryLauncher, createMemoryProcess, silentLogger } from '../../helpers/claude/memory-process';

const PROBE_TOKEN = `sk-ant-oat01-${'P'.repeat(40)}`;
const PROBE_KEY = 'sk-ant-api03-PROBEUNIT000000000000000000000';

/** `claude --help` of the pinned CLI 2.1.316, recorded verbatim. */
const REAL_HELP = readFileSync(FAKE_HELP_PATH, 'utf8');
const REAL_VERSION = '2.1.316 (Claude Code)\n';

function withoutLinesMatching(help: string, flag: string): string {
  return help
    .split('\n')
    .filter((l) => !helpHasFlag(l, flag))
    .join('\n');
}

describe('evaluateClaudeProbe (§10.9)', () => {
  it('accepts the recorded help/version output of CLI 2.1.316', () => {
    expect(evaluateClaudeProbe(REAL_VERSION, REAL_HELP)).toEqual({
      ok: true,
      reason: 'ok',
      version: '2.1.316',
      missingFlags: [],
      permissionModes: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'],
    });
  });

  it.each([...CLAUDE_REQUIRED_FLAGS])('reports %s as missing when the help lacks it', (flag) => {
    let help = withoutLinesMatching(REAL_HELP, flag);
    if (flag === '-p') help = withoutLinesMatching(help, '--print');
    if (flag === '--allowed-tools') help = withoutLinesMatching(help, '--allowedTools');
    if (flag === '--disallowed-tools') help = withoutLinesMatching(help, '--disallowedTools');
    const r = evaluateClaudeProbe(REAL_VERSION, help);
    expect(r.ok).toBe(false);
    expect(r.missingFlags).toContain(flag);
  });

  it('accepts the documented aliases (--print, --allowedTools, --disallowedTools)', () => {
    const help = [
      '  --print   Print response',
      '  --allowedTools <tools...>',
      '  --disallowedTools <tools...>',
      ...CLAUDE_REQUIRED_FLAGS.filter((f) => !['-p', '--allowed-tools', '--disallowed-tools'].includes(f)).map(
        (f) => `  ${f} <x>`,
      ),
      '  (choices: "dontAsk")',
    ].join('\n');
    const r = evaluateClaudeProbe('1.0.0', help);
    expect(r.missingFlags).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('requires the hardened flags and never --bare (ADR-0036 Decision 6)', () => {
    expect(requiredClaudeFlags()).toEqual([...CLAUDE_REQUIRED_FLAGS]);
    for (const flag of ['--settings', '--include-hook-events', '--restricted']) {
      expect(CLAUDE_REQUIRED_FLAGS).toContain(flag);
    }
    expect(CLAUDE_REQUIRED_FLAGS).not.toContain('--bare');
    const help = withoutLinesMatching(REAL_HELP, '--bare');
    expect(evaluateClaudeProbe(REAL_VERSION, help).ok).toBe(true);
  });

  it('does not accept a flag that only appears as a prefix of another word', () => {
    expect(helpHasFlag('  --resume-later <id>', '--resume')).toBe(false);
    expect(helpHasFlag('  --toolsx', '--tools')).toBe(false);
    expect(helpHasFlag('use -p/--print for', '-p')).toBe(false);
    expect(helpHasFlag('  -r, --resume [value]', '--resume')).toBe(true);
    expect(helpHasFlag('  --allowedTools, --allowed-tools <tools...>', '--allowed-tools')).toBe(true);
    expect(helpHasFlag('--output-format=stream-json', '--output-format')).toBe(true);
  });

  it('fails without a version or without dontAsk', () => {
    expect(evaluateClaudeProbe('Claude Code', REAL_HELP)).toMatchObject({
      ok: false,
      reason: 'version_unrecognized',
      version: null,
    });
    const noDontAsk = REAL_HELP.replaceAll('dontAsk', 'dontaskx');
    expect(evaluateClaudeProbe(REAL_VERSION, noDontAsk)).toMatchObject({
      ok: false,
      reason: 'permission_mode_missing',
    });
  });

  it('parses permission modes across wrapped help lines', () => {
    expect(
      parsePermissionModes(
        '  --permission-mode <mode>   Permission mode\n      (choices: "a",\n      "dontAsk", "plan")\n',
      ),
    ).toEqual(['a', 'dontAsk', 'plan']);
    expect(parsePermissionModes('no such option')).toEqual([]);
  });
});

describe('ClaudeRunner.probe', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orc-probe-unit-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function cfg(over: Partial<ClaudeRunnerConfig> = {}): ClaudeRunnerConfig {
    return {
      bin: '/opt/claude/bin/claude',
      binPrefixArgs: ['--prefix'],
      claudeHomeRoot: join(root, 'claude-home'),
      auth: { mode: 'oauth', oauthToken: PROBE_TOKEN },
      proxy: { https: null, http: null, noProxy: null, token: null },
      killGraceMs: 100,
      initTimeoutMs: 1000,
      maxOutputBytes: 1_000_000,
      maxLineBytes: 100_000,
      cbmCacheRoot: join(root, 'cbm'),
      platform: process.platform === 'win32' ? 'win32' : 'posix',
      workerId: 'w1',
      initExtraTools: [],
      ...over,
    };
  }

  function launcherFor(outputs: Record<string, string>): ReturnType<typeof createMemoryLauncher> {
    return createMemoryLauncher((spec) => {
      const proc = createMemoryProcess();
      const arg = spec.args[spec.args.length - 1] ?? '';
      setImmediate(() => {
        proc.writeStdout(outputs[arg] ?? '');
        proc.exit(0);
      });
      return proc;
    });
  }

  it.each([
    ['oauth', { mode: 'oauth', oauthToken: PROBE_TOKEN }],
    ['api_key', { mode: 'api_key', apiKey: PROBE_KEY }],
  ] as const)('runs --version and --help without any credential or fd 3 (%s)', async (_mode, auth) => {
    const launcher = launcherFor({ '--version': REAL_VERSION, '--help': REAL_HELP });
    const runner = createClaudeRunner(cfg({ auth }), { logger: silentLogger(), secrets: createSecretRegistry(), launcher });
    const result = await runner.probe();
    expect(result).toMatchObject({ ok: true, version: '2.1.316', missingFlags: [] });
    expect(launcher.specs.map((s) => [s.kind, s.cmd, ...s.args])).toEqual([
      ['claude', '/opt/claude/bin/claude', '--prefix', '--version'],
      ['claude', '/opt/claude/bin/claude', '--prefix', '--help'],
    ]);
    for (const spec of launcher.specs) {
      expect(spec.credentialFd).toBeUndefined();
      const keys = Object.keys(spec.env).map((k) => k.toUpperCase());
      for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR']) {
        expect(keys).not.toContain(k);
      }
      expect(JSON.stringify(spec.env)).not.toContain(PROBE_TOKEN);
      expect(JSON.stringify(spec.env)).not.toContain(PROBE_KEY);
      expect(spec.env.CLAUDE_CONFIG_DIR).toBe(join(root, 'claude-home', 'probe'));
      expect(spec.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
      expect(spec.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    }
  });

  it('win32: the probe gets its own AppData layout (0700 dirs below the probe dir); POSIX: none', async () => {
    const launcher = launcherFor({ '--version': REAL_VERSION, '--help': REAL_HELP });
    const runner = createClaudeRunner(cfg(), { logger: silentLogger(), secrets: createSecretRegistry(), launcher });
    await runner.probe();
    const probeDir = join(root, 'claude-home', 'probe');
    const env = launcher.specs[0]?.env ?? {};
    if (process.platform === 'win32') {
      expect(env.APPDATA).toBe(join(probeDir, 'AppData', 'Roaming'));
      expect(env.LOCALAPPDATA).toBe(join(probeDir, 'AppData', 'Local'));
      expect(statSync(join(probeDir, 'AppData', 'Roaming')).isDirectory()).toBe(true);
      expect(statSync(join(probeDir, 'AppData', 'Local')).isDirectory()).toBe(true);
    } else {
      expect(env).not.toHaveProperty('APPDATA');
      expect(env).not.toHaveProperty('LOCALAPPDATA');
      expect(statSync(probeDir).mode & 0o777).toBe(0o700);
    }
  });

  it('requests a probe lease the runner protocol accepts (key op-probe-<workerId>, path <CLAUDE_HOME_ROOT>/probe)', async () => {
    const base = launcherFor({ '--version': REAL_VERSION, '--help': REAL_HELP });
    const requests: LaunchLeaseRequest[] = [];
    const launcher = { ...base, acquire: (r: LaunchLeaseRequest) => (requests.push(r), base.acquire(r)) };
    const runner = createClaudeRunner(cfg(), { logger: silentLogger(), secrets: createSecretRegistry(), launcher });
    await expect(runner.probe()).resolves.toMatchObject({ ok: true });
    expect(requests).toHaveLength(1);
    const req = requests[0] as LaunchLeaseRequest;
    expect(LeaseAcquireRequestSchema.safeParse({ v: 1, type: 'lease_acquire', ...req, paths: [...req.paths] }).success).toBe(true);
    expect(req.key).toMatch(/^op-probe-/);
    const claudeHome = join(root, 'claude-home');
    await expect(resolveLeasePaths(req.paths, [claudeHome])).resolves.toHaveLength(1);
  });

  it('rejects with ClaudeProbeError listing the missing flag', async () => {
    const help = withoutLinesMatching(REAL_HELP, '--fork-session');
    const runner = createClaudeRunner(cfg(), {
      logger: silentLogger(),
      secrets: createSecretRegistry(),
      launcher: launcherFor({ '--version': REAL_VERSION, '--help': help }),
    });
    const err = await runner.probe().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ClaudeProbeError);
    expect(err).toMatchObject({
      code: 'claude_probe_failed',
      details: { reason: 'missing_flags', missingFlags: ['--fork-session'], version: '2.1.316' },
    });
  });

  it('rejects with ClaudeProbeError when the CLI cannot be started', async () => {
    const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const runner = createClaudeRunner(cfg(), {
      logger: silentLogger(),
      secrets: createSecretRegistry(),
      launcher: createMemoryLauncher(() => missing),
    });
    await expect(runner.probe()).rejects.toMatchObject({
      code: 'claude_probe_failed',
      details: { reason: 'spawn_failed' },
    });
  });
});
