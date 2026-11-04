// Local process registry + orphan sweep (contract §2.2, §10.8). Node-only.
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { IsoDateTime, Uuid } from '../primitives';
import { OrcError } from '../errors';
import { IdSchema } from '../schemas/common';
import {
  errnoCode,
  execHelper,
  isProcessAlive,
  killTree,
  readProcEnvVar,
  type HostPlatform,
  type SpawnFn,
} from './process';

export interface ProcessRegistryEntry {
  /** `${kind}-${attemptId}` | `${kind}-${operationId}` */
  key: string;
  kind: 'claude' | 'test' | 'git' | 'mcp';
  pid: number;
  pgid: number | null;
  attemptId: Uuid | null;
  workerId: string;
  startedAt: IsoDateTime;
  /** Basename of the executable, for verification. */
  command: string;
}

export interface ProcessRegistry {
  /** Atomic write <dir>/<key>.json (tmp + rename). */
  add(e: ProcessRegistryEntry): Promise<void>;
  remove(key: string): Promise<void>;
  list(): Promise<ProcessRegistryEntry[]>;
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const ProcessRegistryEntrySchema = z.strictObject({
  key: z.string().regex(KEY_PATTERN),
  kind: z.enum(['claude', 'test', 'git', 'mcp']),
  pid: z.int().min(1),
  pgid: z.int().min(1).nullable(),
  attemptId: IdSchema.nullable(),
  workerId: z.string().min(1).max(128),
  startedAt: z.iso.datetime(),
  command: z.string().min(1).max(260),
});

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new OrcError('unsafe_argument', 'Invalid process registry key');
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = errnoCode(e);
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
}

export function createFileProcessRegistry(dir: string): ProcessRegistry {
  const fileOf = (key: string): string => join(dir, `${key}.json`);
  return {
    async add(e) {
      const parsed = ProcessRegistryEntrySchema.safeParse(e);
      if (!parsed.success) throw new OrcError('unsafe_argument', 'Invalid process registry entry');
      await mkdir(dir, { recursive: true });
      const tmp = join(
        dir,
        `.${parsed.data.key}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
      );
      await writeFile(tmp, JSON.stringify(parsed.data), { mode: 0o600 });
      try {
        await renameWithRetry(tmp, fileOf(parsed.data.key));
      } catch (err) {
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
    },
    async remove(key) {
      assertKey(key);
      try {
        await unlink(fileOf(key));
      } catch (e) {
        if (errnoCode(e) !== 'ENOENT') throw e;
      }
    },
    async list() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (e) {
        if (errnoCode(e) === 'ENOENT') return [];
        throw e;
      }
      const entries: ProcessRegistryEntry[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue;
        try {
          const parsed = ProcessRegistryEntrySchema.safeParse(
            JSON.parse(await readFile(join(dir, name), 'utf8')),
          );
          if (parsed.success && `${parsed.data.key}.json` === name) entries.push(parsed.data);
        } catch {
          // unreadable or corrupt entry: skipped
        }
      }
      return entries;
    },
  };
}

export interface SweepReport {
  checked: number;
  killed: { pid: number; key: string; via: 'registry' | 'marker' }[];
  errors: string[];
}

export interface SweepOrphansInput {
  registry: ProcessRegistry;
  activeKeys: ReadonlySet<string>;
  activeAttemptIds: ReadonlySet<Uuid>;
  platform: HostPlatform;
  markerEnv: 'ORC_ATTEMPT_ID';
  procRoot?: string;
  spawn?: SpawnFn;
}

const exeName = (command: string): string =>
  basename(command)
    .toLowerCase()
    .replace(/\.exe$/, '');

/** Is the live process `e.pid` still the process we registered (guards against pid reuse)? */
async function verifyEntry(
  e: ProcessRegistryEntry,
  input: SweepOrphansInput,
  procRoot: string | null,
  spawnFn: SpawnFn,
): Promise<boolean | 'unverifiable'> {
  if (input.platform === 'win32') {
    const { stdout } = await execHelper(spawnFn, 'tasklist', [
      '/FI',
      `PID eq ${e.pid}`,
      '/FO',
      'CSV',
      '/NH',
    ]);
    const match = /^"([^"]+)","(\d+)"/m.exec(stdout.trim());
    if (match === null || Number(match[2]) !== e.pid) return false;
    return exeName(match[1] ?? '') === exeName(e.command);
  }
  if (procRoot === null) return 'unverifiable';
  if (e.attemptId !== null) {
    const value = await readProcEnvVar(procRoot, e.pid, input.markerEnv);
    return value !== null && value.toLowerCase() === e.attemptId.toLowerCase();
  }
  try {
    const cmdline = await readFile(join(procRoot, String(e.pid), 'cmdline'), 'utf8');
    const argv0 = cmdline.split('\0')[0] ?? '';
    return argv0.length > 0 && exeName(argv0) === exeName(e.command);
  } catch {
    return false;
  }
}

/**
 * Kills processes left behind by a previous incarnation of this worker:
 * registry entries not in `activeKeys` (verified against pid reuse) and, on Linux, every
 * same-uid process whose environ carries `<markerEnv>=<id>` with id not in `activeAttemptIds`.
 */
export async function sweepOrphans(input: SweepOrphansInput): Promise<SweepReport> {
  const report: SweepReport = { checked: 0, killed: [], errors: [] };
  const spawnFn = input.spawn ?? nodeSpawn;
  const root = input.procRoot ?? '/proc';
  let procRoot: string | null = null;
  if (input.platform === 'posix') {
    try {
      await readdir(root);
      procRoot = root;
    } catch {
      procRoot = null;
    }
  }

  let entries: ProcessRegistryEntry[] = [];
  try {
    entries = await input.registry.list();
  } catch (e) {
    report.errors.push(`registry: list failed (${errnoCode(e) ?? 'error'})`);
  }

  for (const entry of entries) {
    if (input.activeKeys.has(entry.key)) continue;
    report.checked += 1;
    try {
      if (isProcessAlive(entry.pid)) {
        const verified = await verifyEntry(entry, input, procRoot, spawnFn);
        if (verified === 'unverifiable') {
          report.errors.push(
            `${entry.key}: pid ${entry.pid} alive but cannot be verified on this platform`,
          );
        } else if (verified) {
          const result = await killTree(entry.pid, {
            pgid: input.platform === 'posix' ? entry.pgid : null,
            graceMs: 0,
            platform: input.platform,
            spawn: spawnFn,
            procRoot: root,
          });
          if (result.survivors.length > 0) {
            report.errors.push(`${entry.key}: survivors ${result.survivors.join(',')}`);
            continue; // keep the entry so the next sweep retries
          }
          report.killed.push({ pid: entry.pid, key: entry.key, via: 'registry' });
        }
      }
      await input.registry.remove(entry.key);
    } catch (e) {
      report.errors.push(`${entry.key}: ${e instanceof Error ? e.message : 'sweep failed'}`);
    }
  }

  if (procRoot !== null) {
    const activeIds = new Set([...input.activeAttemptIds].map((id) => id.toLowerCase()));
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    let names: string[] = [];
    try {
      names = await readdir(procRoot);
    } catch (e) {
      report.errors.push(`marker: cannot list ${procRoot} (${errnoCode(e) ?? 'error'})`);
    }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid || report.killed.some((k) => k.pid === pid)) continue;
      const value = await readProcEnvVar(procRoot, pid, input.markerEnv);
      if (value === null) continue;
      const id = value.toLowerCase();
      if (activeIds.has(id)) continue;
      if (uid !== null) {
        try {
          if ((await stat(join(procRoot, name))).uid !== uid) continue;
        } catch {
          continue;
        }
      }
      report.checked += 1;
      if (!isProcessAlive(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
        report.killed.push({ pid, key: `marker-${id}`, via: 'marker' });
      } catch (e) {
        if (errnoCode(e) !== 'ESRCH')
          report.errors.push(`marker: pid ${pid} kill failed (${errnoCode(e) ?? 'error'})`);
      }
    }
  }
  return report;
}
