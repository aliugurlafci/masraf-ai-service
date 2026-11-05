// Runner composition (contract §10.11, §16.7): caps self-check, Yama ptrace_scope check (§10.11
// item 10, ADR-0036 m.9), codebase-memory-mcp cache anchors (ADR-0034), lease manager with restart
// recovery, socket server, reaper, graceful shutdown.
import { chmod, mkdir, readFile } from 'node:fs/promises';
import type { Logger } from '@orc/logger';
import {
  anchorCbmCacheDirs,
  createFileLeaseStateStore,
  createLeaseManager,
  createProcfsTable,
  createRunnerServer,
  detectRunnerCaps,
  type AnchorFs,
  type DetectedCaps,
  type IdentityMode,
  type LaunchProcessFn,
  type LeaseManager,
  type LeaseStateStore,
  type ProcessTable,
  type RecoveryReport,
  type RunnerCaps,
  type RunnerServer,
  type SocketFsOps,
  type WalkFs,
} from '@orc/sandbox';
import { realpathWithin } from '@orc/security';
import { OrcError } from '@orc/shared';
import type { RunnerConfig } from '@orc/shared/node';

export interface RunnerRuntimeOverrides {
  caps?: DetectedCaps;
  processTable?: ProcessTable;
  stateStore?: LeaseStateStore;
  fs?: WalkFs;
  socketFs?: SocketFsOps;
  launch?: LaunchProcessFn;
  /** Filesystem of the codebase-memory-mcp cache anchoring (tests). */
  anchorFs?: AnchorFs;
  /** Reaper period override (tests). */
  reapIntervalMs?: number;
  /** Reads the Yama ptrace_scope file; null = missing or unreadable (tests). */
  readPtraceScope?: () => Promise<string | null>;
}

export interface RunnerRuntime {
  start(): Promise<void>;
  /** Stops accepting, releases every lease (kill + reclaim), closes connections, removes the socket. */
  stop(): Promise<void>;
  readonly identity: IdentityMode | null;
  readonly caps: RunnerCaps | null;
  readonly recovery: RecoveryReport | null;
  /** Yama ptrace_scope read at start (null: missing, unreadable or not an integer). */
  readonly ptraceScope: number | null;
}

/** Host kernel setting that guards `/proc/<claude>/mem` (not namespaced; compose cannot set it). */
export const YAMA_PTRACE_SCOPE_PATH = '/proc/sys/kernel/yama/ptrace_scope';

export interface PtraceScopeAssessment {
  /** Parsed value; null when the file is missing, unreadable or not an integer. */
  value: number | null;
  /** True only for a value >= 1. */
  ok: boolean;
  reason: 'ok' | 'missing' | 'invalid' | 'disabled';
}

/**
 * Contract §10.11 item 10 / ADR-0036 m.9: the OAuth token in the Claude CLI's memory is protected
 * from other processes of the same lease uid only by Yama `ptrace_scope >= 1`. A missing file
 * (no Yama), an unparsable value and `0` all fail the check.
 */
export function assessPtraceScope(raw: string | null): PtraceScopeAssessment {
  if (raw === null) return { value: null, ok: false, reason: 'missing' };
  const text = raw.trim();
  if (!/^[0-9]{1,3}$/.test(text)) return { value: null, ok: false, reason: 'invalid' };
  const value = Number(text);
  return value >= 1
    ? { value, ok: true, reason: 'ok' }
    : { value, ok: false, reason: 'disabled' };
}

async function readPtraceScopeFile(): Promise<string | null> {
  try {
    return await readFile(YAMA_PTRACE_SCOPE_PATH, 'utf8');
  } catch {
    return null;
  }
}

/** Children run under sandbox uids only when every privileged primitive is available. */
export function identityFor(caps: RunnerCaps): IdentityMode {
  return caps.uidSwitch && caps.chown && caps.kill && caps.procfs ? 'switch' : 'none';
}

export function createRunnerRuntime(
  config: RunnerConfig,
  logger: Logger,
  overrides: RunnerRuntimeOverrides = {},
): RunnerRuntime {
  let identity: IdentityMode | null = null;
  let caps: RunnerCaps | null = null;
  let recovery: RecoveryReport | null = null;
  let ptraceScope: number | null = null;
  let manager: LeaseManager | null = null;
  let server: RunnerServer | null = null;
  let stopping: Promise<void> | null = null;

  async function start(): Promise<void> {
    const detected = overrides.caps ?? (await detectRunnerCaps());
    caps = detected.caps;
    if (!caps.ok) {
      const missing = Object.entries(caps)
        .filter(([k, v]) => k !== 'ok' && v === false)
        .map(([k]) => k);
      if (config.nodeEnv === 'production') {
        throw new OrcError('config_invalid', 'Runner capability self-check failed', {
          details: { missing },
        });
      }
      logger.warn(
        { missing },
        'runner capability self-check failed; development mode without full isolation',
      );
    }
    // Production refuses to become healthy (start fails, the socket never opens); dev/test only warn.
    const ptrace = assessPtraceScope(await (overrides.readPtraceScope ?? readPtraceScopeFile)());
    ptraceScope = ptrace.value;
    if (!ptrace.ok) {
      if (config.nodeEnv === 'production') {
        throw new OrcError('config_invalid', 'Yama ptrace_scope must be at least 1', {
          details: { reason: `ptrace_scope_${ptrace.reason}`, ptraceScope: ptrace.value },
        });
      }
      logger.warn(
        { ptraceScope: ptrace.value, reason: ptrace.reason },
        'Yama ptrace_scope is missing or 0: same-uid processes can read the Claude CLI memory (dev only)',
      );
    }
    identity = identityFor(caps);
    if (identity === 'none') {
      logger.warn('sandbox uid switching unavailable: children run as the runner user (dev only)');
    }

    // Roots must exist; canonical paths are used for every lease check.
    const roots = await Promise.all(
      [config.workspacesRoot, config.claudeHomeRoot, config.cbmCacheDir].map((root) =>
        realpathWithin(root),
      ),
    );
    const cbmRoot = roots[2] as string;

    await mkdir(config.runnerStateDir, { recursive: true, mode: 0o700 });
    await chmod(config.runnerStateDir, 0o700);

    const switching = identity === 'switch';
    if (switching) {
      // codebase-memory-mcp only accepts cache/runtime dirs whose every ancestor a sandbox uid can open
      // and that root (or itself) owns (ADR-0034): anchor <CBM_CACHE_DIR> and its p/ and w/ dirs.
      const anchors = await anchorCbmCacheDirs(
        { root: cbmRoot, workerGid: config.workerGid },
        ...(overrides.anchorFs === undefined ? [] : [overrides.anchorFs]),
      );
      logger.info(
        {
          anchors: anchors.map((a) => ({
            path: a.path,
            created: a.created,
            changed: a.changed,
            before: a.before === null ? null : { ...a.before, mode: a.before.mode.toString(8) },
          })),
        },
        'codebase-memory-mcp cache anchors ready',
      );
    }
    manager = createLeaseManager({
      roots,
      // Probe homes only below CLAUDE_HOME_ROOT and CBM_CACHE_DIR (§10.9, §12.1), never WORKSPACES_ROOT/probe.
      probeRoots: roots.slice(1),
      workerUid: config.workerUid,
      workerGid: config.workerGid,
      uidBase: config.runnerUidBase,
      maxLeases: config.runnerMaxLeases,
      leaseTtlMs: config.runnerLeaseTtlMs,
      killGraceMs: config.runnerKillGraceMs,
      limits: {
        nproc: config.runnerNproc,
        nofile: config.runnerNofile,
        fsizeBytes: config.runnerFsizeBytes,
      },
      identity,
      prlimitPath: detected.prlimitPath,
      logger,
      stateStore: overrides.stateStore ?? createFileLeaseStateStore(config.runnerStateDir),
      ...(switching ? { processTable: overrides.processTable ?? createProcfsTable() } : {}),
      ...(overrides.fs === undefined ? {} : { fs: overrides.fs }),
      ...(overrides.launch === undefined ? {} : { launch: overrides.launch }),
      ...(overrides.reapIntervalMs === undefined
        ? {}
        : { reapIntervalMs: overrides.reapIntervalMs }),
    });
    if (detected.prlimitPath === null) {
      logger.warn('prlimit not found: children run without per-process limits (dev only)');
    }

    recovery = await manager.recoverStale();

    server = createRunnerServer({
      socketPath: config.runnerSocketPath,
      manager,
      hello: {
        uidBase: config.runnerUidBase,
        maxLeases: config.runnerMaxLeases,
        leaseTtlMs: config.runnerLeaseTtlMs,
        caps,
      },
      logger,
      maxConnections: config.runnerMaxConnections,
      socketGroup: switching ? config.workerGid : null,
      killGraceMs: config.runnerKillGraceMs,
      ...(overrides.socketFs === undefined ? {} : { fs: overrides.socketFs }),
    });
    await server.listen();
    manager.startReaper();
    logger.info(
      {
        identity,
        caps,
        ptraceScope,
        uidBase: config.runnerUidBase,
        maxLeases: config.runnerMaxLeases,
        leaseTtlMs: config.runnerLeaseTtlMs,
      },
      'runner started',
    );
  }

  async function doStop(): Promise<void> {
    server?.stopAccepting();
    if (manager !== null) await manager.close();
    if (server !== null) await server.close(5000);
    logger.info('runner stopped');
  }

  return {
    start,
    stop() {
      stopping ??= doStop();
      return stopping;
    },
    get identity() {
      return identity;
    },
    get caps() {
      return caps;
    },
    get recovery() {
      return recovery;
    },
    get ptraceScope() {
      return ptraceScope;
    },
  };
}
