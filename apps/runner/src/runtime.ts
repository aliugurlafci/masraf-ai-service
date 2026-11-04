// Runner composition (contract §10.11, §16.7): caps self-check, codebase-memory-mcp cache anchors
// (ADR-0034), lease manager with restart recovery, socket server, reaper, graceful shutdown.
import { chmod, mkdir } from 'node:fs/promises';
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
}

export interface RunnerRuntime {
  start(): Promise<void>;
  /** Stops accepting, releases every lease (kill + reclaim), closes connections, removes the socket. */
  stop(): Promise<void>;
  readonly identity: IdentityMode | null;
  readonly caps: RunnerCaps | null;
  readonly recovery: RecoveryReport | null;
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
  };
}
