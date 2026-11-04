// PID persistence and orphan sweep helpers for Claude processes (contract §10.8).
import { posix, win32 } from 'node:path';
import { toIso } from '@orc/shared';
import type { Uuid } from '@orc/shared';
import { sweepOrphans } from '@orc/shared/node';
import type {
  HostPlatform,
  ProcessRegistry,
  ProcessRegistryEntry,
  SpawnFn,
  SweepReport,
} from '@orc/shared/node';
import { CLAUDE_MARKER_ENV, CLAUDE_PROCESS_KIND } from './constants';

/** Registry key of an attempt's Claude process: `claude-<attemptId>`. */
export function claudeProcessKey(attemptId: Uuid): string {
  return `${CLAUDE_PROCESS_KIND}-${attemptId}`;
}

/**
 * Registry entry written in `onSpawn` (local mode). `command` is the basename of the executable
 * actually started (`CLAUDE_BIN`, e.g. `node.exe` with prefix args), which the win32 sweep compares
 * with the image name reported by `tasklist`.
 */
export function claudeRegistryEntry(input: {
  attemptId: Uuid;
  workerId: string;
  pid: number;
  pgid: number | null;
  startedAt: Date;
  bin: string;
  platform: HostPlatform;
}): ProcessRegistryEntry {
  const p = input.platform === 'win32' ? win32 : posix;
  return {
    key: claudeProcessKey(input.attemptId),
    kind: CLAUDE_PROCESS_KIND,
    pid: input.pid,
    pgid: input.pgid,
    attemptId: input.attemptId,
    workerId: input.workerId,
    startedAt: toIso(input.startedAt),
    command: p.basename(input.bin),
  };
}

/** Read-through view of a registry restricted to Claude entries (other kinds are never touched). */
function claudeOnly(registry: ProcessRegistry): ProcessRegistry {
  return {
    add: (e) => registry.add(e),
    remove: (key) => registry.remove(key),
    list: async () => (await registry.list()).filter((e) => e.kind === CLAUDE_PROCESS_KIND),
  };
}

/**
 * Kills Claude processes of attempts that are no longer active (worker startup and every
 * ORPHAN_SWEEP_INTERVAL_MS): registry entries verified against pid reuse and, on Linux, processes
 * carrying `ORC_ATTEMPT_ID=<id>` for an inactive attempt (same uid).
 */
export function sweepClaudeOrphans(input: {
  registry: ProcessRegistry;
  activeAttemptIds: ReadonlySet<Uuid>;
  platform: HostPlatform;
  procRoot?: string;
  spawn?: SpawnFn;
}): Promise<SweepReport> {
  const activeKeys = new Set([...input.activeAttemptIds].map((id) => claudeProcessKey(id)));
  return sweepOrphans({
    registry: claudeOnly(input.registry),
    activeKeys,
    activeAttemptIds: input.activeAttemptIds,
    platform: input.platform,
    markerEnv: CLAUDE_MARKER_ENV,
    ...(input.procRoot !== undefined ? { procRoot: input.procRoot } : {}),
    ...(input.spawn !== undefined ? { spawn: input.spawn } : {}),
  });
}
