// CLI probe (contract §10.9): `<bin> --version` and `<bin> --help` through the launcher.
import { mkdir } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { Env, LaunchLease, ProcessLauncher, SupervisedProcess } from '@orc/shared/node';
import type { Logger } from '@orc/logger';
import { serializeError } from '@orc/logger';
import { buildClaudeAppDataEnv } from '@orc/security';
import {
  CLAUDE_FLAG_ALIASES,
  CLAUDE_PERMISSION_MODE,
  CLAUDE_PROBE_MAX_OUTPUT_BYTES,
  CLAUDE_PROBE_TIMEOUT_MS,
  CLAUDE_REQUIRED_FLAGS,
} from './constants';
import { buildProbeEnv } from './env';
import { ClaudeProbeError } from './errors';
import { isSpawnFailure } from './spawn-errors';
import type { ClaudeProbeResult, ClaudeRunnerConfig } from './types';

const VERSION_REGEX = /(\d+\.\d+\.\d+)/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** §10.9 flag regex: `(^|[\s,])<flag>([\s,=<\[]|$)` (multi-line). */
export function helpHasFlag(help: string, flag: string): boolean {
  return new RegExp(`(^|[\\s,])${escapeRegex(flag)}([\\s,=<\\[]|$)`, 'm').test(help);
}

/** Choices of `--permission-mode <mode> ... (choices: "a", "b", ...)` (commander help format). */
export function parsePermissionModes(help: string): string[] {
  const flat = help.replace(/\s+/g, ' ');
  const match = /--permission-mode <[^>]*>[^(]*\(choices: ([^)]*)\)/.exec(flat);
  if (match === null) return [];
  return [...(match[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '').filter((m) => m.length > 0);
}

/** Flags the CLI must document (§10.9); the same for both auth modes (ADR-0036 Decision 6). */
export function requiredClaudeFlags(): string[] {
  return [...CLAUDE_REQUIRED_FLAGS];
}

export interface ProbeEvaluation extends ClaudeProbeResult {
  /** First failure reason when `ok` is false. */
  reason: 'ok' | 'version_unrecognized' | 'missing_flags' | 'permission_mode_missing';
}

/** Pure evaluation of the `--version` and `--help` outputs. */
export function evaluateClaudeProbe(versionOutput: string, helpOutput: string): ProbeEvaluation {
  const version = VERSION_REGEX.exec(versionOutput)?.[1] ?? null;
  const missingFlags = requiredClaudeFlags().filter(
    (flag) =>
      !helpHasFlag(helpOutput, flag) &&
      !(CLAUDE_FLAG_ALIASES[flag] ?? []).some((alias) => helpHasFlag(helpOutput, alias)),
  );
  const permissionModes = parsePermissionModes(helpOutput);
  const hasDontAsk = helpOutput.includes(CLAUDE_PERMISSION_MODE);
  const reason =
    version === null
      ? 'version_unrecognized'
      : missingFlags.length > 0
        ? 'missing_flags'
        : !hasDontAsk
          ? 'permission_mode_missing'
          : 'ok';
  return { ok: reason === 'ok', version, missingFlags, permissionModes, reason };
}

interface CommandOutput {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
}

function collect(
  proc: SupervisedProcess,
  timeoutMs: number,
  maxBytes: number,
): Promise<CommandOutput> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let ended = false;
    let exit: { exitCode: number | null } | null = null;
    let done = false;
    let endGrace: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(endGrace);
      resolve({
        stdout: Buffer.concat(chunks, size).toString('utf8'),
        exitCode: exit?.exitCode ?? null,
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void proc.stop({ graceMs: 0, forceImmediately: true }).finally(finish);
    }, timeoutMs);
    proc.stdout.on('data', (c: Buffer | string) => {
      const b = typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
      const room = maxBytes - size;
      if (room <= 0) return;
      const part = b.length > room ? b.subarray(0, room) : b;
      chunks.push(part);
      size += part.length;
    });
    const onEnd = (): void => {
      ended = true;
      if (exit !== null) finish();
    };
    proc.stdout.on('end', onEnd);
    proc.stdout.on('close', onEnd);
    proc.stdout.on('error', onEnd);
    proc.stderr.on('data', () => undefined);
    proc.stderr.on('error', () => undefined);
    proc.stdin.on('error', () => undefined);
    proc.stdin.end();
    void proc.exited.then((x) => {
      exit = x;
      if (ended) finish();
      else endGrace = setTimeout(finish, 2000);
    });
  });
}

export interface ProbeDeps {
  logger: Logger;
  launcher: ProcessLauncher;
  env: Env;
}

/** Runs the probe; resolves only when the CLI passes, else rejects with {@link ClaudeProbeError}. */
export async function probeClaude(
  cfg: ClaudeRunnerConfig,
  deps: ProbeDeps,
): Promise<ClaudeProbeResult> {
  const p = cfg.platform === 'win32' ? win32 : posix;
  const probeDir = p.resolve(cfg.claudeHomeRoot, 'probe');
  await mkdir(probeDir, { recursive: true, mode: 0o700 });
  // B-020: on win32 the probe gets its own AppData layout below the probe directory.
  for (const dir of Object.values(buildClaudeAppDataEnv('probe', probeDir, cfg.platform))) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const env = buildProbeEnv(cfg, probeDir, deps.env);
  let lease: LaunchLease;
  try {
    lease = await deps.launcher.acquire({
      key: `op-probe-${cfg.workerId}`,
      attemptId: null,
      workerId: cfg.workerId,
      paths: [probeDir],
    });
  } catch (e) {
    throw new ClaudeProbeError('Claude CLI probe could not acquire a launch lease', {
      cause: e,
      details: { reason: 'lease_failed' },
    });
  }
  const run = async (arg: '--version' | '--help'): Promise<CommandOutput> => {
    let proc: SupervisedProcess;
    try {
      proc = await deps.launcher.spawn(lease, {
        kind: 'claude',
        cmd: cfg.bin,
        args: [...cfg.binPrefixArgs, arg],
        cwd: probeDir,
        env,
      });
    } catch (e) {
      if (isSpawnFailure(e)) {
        throw new ClaudeProbeError('Claude CLI could not be started', {
          cause: e,
          details: { reason: 'spawn_failed', arg },
        });
      }
      throw e;
    }
    const out = await collect(proc, CLAUDE_PROBE_TIMEOUT_MS, CLAUDE_PROBE_MAX_OUTPUT_BYTES);
    if (out.timedOut) {
      throw new ClaudeProbeError(`Claude CLI ${arg} timed out`, {
        details: { reason: 'timeout', arg },
      });
    }
    return out;
  };
  let evaluation: ProbeEvaluation;
  try {
    const version = await run('--version');
    const help = await run('--help');
    evaluation = evaluateClaudeProbe(version.stdout, help.stdout);
  } finally {
    await lease.release().catch((e: unknown) => {
      deps.logger.warn({ err: serializeError(e) }, 'claude probe lease release failed');
    });
  }
  const { reason, ...result } = evaluation;
  if (!result.ok) {
    deps.logger.error(
      { reason, version: result.version, missingFlags: result.missingFlags },
      'claude CLI probe failed',
    );
    throw new ClaudeProbeError(`Claude CLI probe failed: ${reason}`, {
      details: { reason, ...result },
    });
  }
  deps.logger.info(
    { version: result.version, permissionModes: result.permissionModes },
    'claude CLI probe ok',
  );
  return result;
}
