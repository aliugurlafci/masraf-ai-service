// Hardened git process execution, GitOperations recording and process registry (contract §11.3, §11.7).
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { toIso, type Clock, type GitOperationKind } from '@orc/shared';
import {
  runProcess,
  type HostPlatform,
  type ProcessRegistry,
  type RunProcessResult,
  type SpawnFn,
} from '@orc/shared/node';
import { assertSafeArgv, buildChildEnv, GIT_ENV_ALLOWLIST, maskText } from '@orc/security';
import { getLogContext, serializeError, type Logger } from '@orc/logger';
import { isolationPrefix, NULL_GLOBAL_CONFIG, safeDirectoryConfig, toGitPath } from './argv';
import { GitError, GitTimeoutError } from './errors';
import { ensureDirMode, errnoOf } from './fs-utils';
import { sanitizeGitArgs } from './naming';
import type { GitOpContext, GitOperationRecorder } from './types';

export const VERSION_TIMEOUT_MS = 10_000;
export const GC_TIMEOUT_MS = 600_000;
export const DEFAULT_STDOUT_MAX = 16 * 1024 * 1024;
export const DIFF_STDOUT_MAX = 64 * 1024 * 1024;
const STDERR_MAX = 1024 * 1024;
const STDERR_TAIL_DB_MAX = 4000;
const CWD_DB_MAX = 400;
const TRANSPORT_DIR_MODE = 0o700;
const TRANSPORT_FILE_MODE = 0o400;

export interface GitExec {
  op: GitOperationKind;
  /** argv after the isolation prefix. */
  args: readonly string[];
  /** Exact absolute paths of every repository touched (`safe.directory`). */
  safeDirectories: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes?: number;
  stdin?: string;
  /** mirror_fetch only. */
  fetch?: boolean;
  /**
   * Exact git dirs opened by a git process that the local transport starts itself (upload-pack of
   * mirror_fetch). `-c` does not reach that process, so these go into a per-call, read-only
   * `GIT_CONFIG_GLOBAL` file holding only `safe.directory` entries (ADR-0033).
   */
  transportSafeDirectories?: readonly string[];
  /** Semantic success for recording; default exit code 0. */
  success?: (exitCode: number, stderr: string) => boolean;
}

export interface GitExecResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
  stdoutTruncated: boolean;
  success: boolean;
  stderrTail: string;
}

export interface GitExecutorOptions {
  gitBin: string;
  hooksDir: string;
  gitHome: string;
  /** Worker-private directory (0700) for per-call transport config files (ADR-0033). */
  transportConfigDir: string;
  platform: HostPlatform;
  killGraceMs: number;
  stderrTailChars: number;
  roots: { projectsRoot: string; workspacesRoot: string };
  workerId: string;
  logger: Logger;
  recorder: GitOperationRecorder;
  clock: Clock;
  spawn?: SpawnFn;
  registry?: ProcessRegistry;
  /** Source of inherited variables (PATH; WINDOWS_BASE_ENV on win32). */
  env?: Readonly<Record<string, string | undefined>>;
}

export type GitExecutor = (exec: GitExec, ctx: GitOpContext | null) => Promise<GitExecResult>;

/**
 * §11.3 environment: allowlisted inheritance + fixed isolation overrides. `globalConfig` is
 * `/dev/null` except for a transport op, which passes its per-call config file (ADR-0033).
 */
export function gitEnv(
  source: Readonly<Record<string, string | undefined>>,
  gitHome: string,
  platform: HostPlatform,
  globalConfig: string = NULL_GLOBAL_CONFIG,
): Record<string, string> {
  return buildChildEnv(
    GIT_ENV_ALLOWLIST,
    source,
    {
      HOME: gitHome,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
      LANG: 'C',
    },
    platform,
  );
}

function tail(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  let start = text.length - max;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

export function createGitExecutor(o: GitExecutorOptions): GitExecutor {
  const command = basename(o.gitBin);
  const tailChars = Math.min(Math.max(0, o.stderrTailChars), STDERR_TAIL_DB_MAX);

  const record = async (
    ctx: GitOpContext | null,
    exec: GitExec,
    argv: readonly string[],
    r: RunProcessResult,
    success: boolean,
    stderrTail: string,
    startedAt: Date,
  ): Promise<void> => {
    const sanitized = sanitizeGitArgs(argv, o.roots);
    const cwd = (sanitizeGitArgs([exec.cwd], o.roots)[0] ?? '').slice(0, CWD_DB_MAX);
    const fields = {
      operation: exec.op,
      args: sanitized,
      cwd,
      exitCode: r.exitCode,
      signal: r.signal,
      success,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
    };
    if (success) o.logger.debug({ ...fields, projectId: ctx?.projectId }, 'git operation');
    else o.logger.warn({ ...fields, projectId: ctx?.projectId, stderrTail }, 'git operation failed');
    if (!ctx) return;
    try {
      await o.recorder.record({
        projectId: ctx.projectId,
        taskId: ctx.taskId ?? null,
        attemptId: ctx.attemptId ?? null,
        workerId: o.workerId,
        operation: exec.op,
        args: sanitized,
        cwd,
        exitCode: r.exitCode,
        signal: r.signal,
        success,
        timedOut: r.timedOut,
        durationMs: Math.max(0, Math.round(r.durationMs)),
        stderrTail: stderrTail === '' ? null : stderrTail,
        correlationId: ctx.correlationId ?? getLogContext().correlationId ?? null,
        startedAt: toIso(startedAt),
      });
    } catch (err) {
      o.logger.error({ err: serializeError(err), operation: exec.op }, 'git operation record failed');
    }
  };

  /** Exclusive create ('wx' = O_CREAT|O_EXCL: never follows or reuses an existing entry), read-only. */
  const writeTransportConfig = async (op: GitOperationKind, file: string, text: string): Promise<void> => {
    try {
      await ensureDirMode(o.transportConfigDir, TRANSPORT_DIR_MODE, o.platform);
      await writeFile(file, text, { flag: 'wx', mode: TRANSPORT_FILE_MODE });
    } catch (err) {
      throw new GitError(`git ${op} could not be prepared`, {
        cause: err,
        details: {
          operation: op,
          exitCode: null,
          stderrTail: '',
          reason: 'transport_config_failed',
          errno: errnoOf(err) ?? null,
        },
      });
    }
  };

  /** Runs on every exit path; a leftover file is swept by ensureRuntimeDirs at the next start. */
  const removeTransportConfig = async (op: GitOperationKind, file: string): Promise<void> => {
    try {
      await rm(file, { force: true });
    } catch (err) {
      o.logger.warn({ err: serializeError(err), operation: op }, 'git transport config removal failed');
    }
  };

  const run = async (
    exec: GitExec,
    ctx: GitOpContext | null,
    argv: readonly string[],
    globalConfig: string,
  ): Promise<GitExecResult> => {
    const env = gitEnv(o.env ?? process.env, o.gitHome, o.platform, globalConfig);
    const startedAt = o.clock.now();
    const key = `git-${randomUUID()}`;
    const registration: { pending: Promise<void> | null } = { pending: null };

    const r = await runProcess(o.gitBin, argv, {
      cwd: exec.cwd,
      env,
      timeoutMs: exec.timeoutMs,
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
      ...(exec.stdin !== undefined ? { stdin: exec.stdin } : {}),
      maxStdoutBytes: exec.maxStdoutBytes ?? DEFAULT_STDOUT_MAX,
      maxStderrBytes: STDERR_MAX,
      killGraceMs: o.killGraceMs,
      ...(o.spawn ? { spawn: o.spawn } : {}),
      platform: o.platform,
      onSpawn: (pid) => {
        if (!o.registry) return;
        registration.pending = o.registry
          .add({
            key,
            kind: 'git',
            pid,
            pgid: o.platform === 'posix' ? pid : null,
            attemptId: ctx?.attemptId ?? null,
            workerId: o.workerId,
            startedAt: toIso(startedAt),
            command,
          })
          .catch((err: unknown) => {
            o.logger.warn({ err: serializeError(err) }, 'git process registry add failed');
          });
      },
    });
    if (registration.pending !== null && o.registry) {
      await registration.pending;
      await o.registry.remove(key).catch((err: unknown) => {
        o.logger.warn({ err: serializeError(err) }, 'git process registry remove failed');
      });
    }

    const stderr = r.stderr.toString('utf8');
    const stderrTail = maskText(tail(stderr, tailChars));
    const exited = r.spawnError === null && !r.timedOut && !r.aborted && r.exitCode !== null;
    const success =
      exited && (exec.success ? exec.success(r.exitCode as number, stderr) : r.exitCode === 0);
    if (r.pid !== null || r.spawnError !== null) {
      await record(ctx, exec, argv, r, success, stderrTail, startedAt);
    }

    if (r.spawnError !== null) {
      throw new GitError(`git ${exec.op} could not be started`, {
        cause: r.spawnError,
        details: {
          operation: exec.op,
          exitCode: null,
          stderrTail: '',
          reason: 'spawn_failed',
          errno: r.spawnError.code ?? null,
        },
      });
    }
    if (r.timedOut) {
      throw new GitTimeoutError(`git ${exec.op} timed out after ${exec.timeoutMs} ms`, {
        details: { operation: exec.op, timeoutMs: exec.timeoutMs, stderrTail },
      });
    }
    if (r.aborted) {
      throw new GitError(`git ${exec.op} aborted`, {
        details: { operation: exec.op, exitCode: r.exitCode, stderrTail, aborted: true },
      });
    }
    if (r.exitCode === null) {
      throw new GitError(`git ${exec.op} terminated by signal ${r.signal ?? 'unknown'}`, {
        details: { operation: exec.op, exitCode: null, signal: r.signal, stderrTail },
      });
    }
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr,
      stdoutTruncated: r.stdoutTruncated,
      success,
      stderrTail,
    };
  };

  return async (exec, ctx) => {
    const argv = [
      ...isolationPrefix({
        hooksDir: o.hooksDir,
        safeDirectories: exec.safeDirectories,
        fetch: exec.fetch === true,
        platform: o.platform,
      }),
      ...exec.args,
    ];
    assertSafeArgv(argv, { platform: o.platform });
    const transportDirs = exec.transportSafeDirectories ?? [];
    if (transportDirs.length === 0) return run(exec, ctx, argv, NULL_GLOBAL_CONFIG);
    const text = safeDirectoryConfig(transportDirs, o.platform);
    const file = join(o.transportConfigDir, `${exec.op}-${randomUUID()}.gitconfig`);
    try {
      await writeTransportConfig(exec.op, file, text);
      return await run(exec, ctx, argv, toGitPath(file, o.platform));
    } finally {
      await removeTransportConfig(exec.op, file);
    }
  };
}

/** GitError for an unexpected exit code. */
export function gitFailed(op: GitOperationKind, r: GitExecResult, message?: string): GitError {
  return new GitError(message ?? `git ${op} failed with exit code ${r.exitCode}`, {
    details: { operation: op, exitCode: r.exitCode, stderrTail: r.stderrTail },
  });
}
