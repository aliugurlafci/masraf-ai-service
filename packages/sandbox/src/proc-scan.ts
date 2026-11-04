// Uid-wide process control for lease release (contract §10.11 item 3): every process whose real
// uid is the lease uid is signalled, which also catches `setsid` / double-fork escapes.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { KillResult } from '@orc/shared/node';

export type KillSignal = 'SIGTERM' | 'SIGKILL';

export interface ProcessTable {
  /** Live (non-zombie) pids whose real uid is `uid`. */
  listByUid(uid: number): Promise<number[]>;
  /** Best effort; ESRCH/EPERM are ignored (verification happens through listByUid). */
  signal(pid: number, signal: KillSignal): void;
}

/** Parses `/proc/<pid>/status`: real uid and whether the task is a zombie/dead. */
export function parseProcStatus(text: string): { realUid: number | null; zombie: boolean } {
  let realUid: number | null = null;
  let zombie = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('Uid:')) {
      const first = line.slice(4).trim().split(/\s+/)[0];
      const n = first === undefined ? NaN : Number(first);
      realUid = Number.isInteger(n) && n >= 0 ? n : null;
    } else if (line.startsWith('State:')) {
      const s = line.slice(6).trim().charAt(0);
      zombie = s === 'Z' || s === 'X';
    }
  }
  return { realUid, zombie };
}

export interface ProcfsTableOptions {
  procRoot?: string;
  /** Defaults to process.kill. */
  kill?: (pid: number, signal: KillSignal) => void;
  /** Never signalled (the runner itself). Defaults to process.pid. */
  selfPid?: number;
}

/** Linux `/proc` scanner. */
export function createProcfsTable(opts: ProcfsTableOptions = {}): ProcessTable {
  const procRoot = opts.procRoot ?? '/proc';
  const kill = opts.kill ?? ((pid: number, sig: KillSignal) => process.kill(pid, sig));
  const selfPid = opts.selfPid ?? process.pid;
  return {
    async listByUid(uid) {
      let names: string[];
      try {
        names = await readdir(procRoot);
      } catch {
        return [];
      }
      const pids: number[] = [];
      await Promise.all(
        names.map(async (name) => {
          if (!/^[1-9][0-9]*$/.test(name)) return;
          const pid = Number(name);
          if (pid === selfPid) return;
          let text: string;
          try {
            text = await readFile(path.join(procRoot, name, 'status'), 'utf8');
          } catch {
            return; // exited while scanning
          }
          const st = parseProcStatus(text);
          if (st.realUid === uid && !st.zombie) pids.push(pid);
        }),
      );
      return pids.sort((a, b) => a - b);
    },
    signal(pid, signal) {
      if (!Number.isInteger(pid) || pid <= 1 || pid === selfPid) return;
      try {
        kill(pid, signal);
      } catch {
        // ESRCH (gone) / EPERM: verified by the next scan.
      }
    },
  };
}

export interface KillUidOptions {
  graceMs: number;
  /** Maximum time spent in the SIGKILL phase (default 5000 ms). */
  forceWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * SIGTERM to every process of `uid` (newly seen ones included) until none remain or `graceMs`
 * passed, then SIGKILL rounds until none remain or `forceWaitMs` passed. Returns survivors.
 */
export async function killUidProcesses(
  uid: number,
  table: ProcessTable,
  o: KillUidOptions,
): Promise<KillResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const pollMs = o.pollMs ?? 100;
  const forceWaitMs = o.forceWaitMs ?? 5000;
  const started = now();
  let pids = await table.listByUid(uid);
  if (pids.length === 0) {
    return { graceful: true, forced: false, survivors: [], durationMs: now() - started };
  }
  let graceful = false;
  if (o.graceMs > 0) {
    const termed = new Set<number>();
    const deadline = started + o.graceMs;
    for (;;) {
      for (const pid of pids) {
        if (!termed.has(pid)) {
          table.signal(pid, 'SIGTERM');
          termed.add(pid);
        }
      }
      await sleep(pollMs);
      pids = await table.listByUid(uid);
      if (pids.length === 0) {
        graceful = true;
        break;
      }
      if (now() >= deadline) break;
    }
  }
  let forced = false;
  if (!graceful) {
    forced = true;
    const deadline = now() + forceWaitMs;
    for (;;) {
      for (const pid of pids) table.signal(pid, 'SIGKILL');
      await sleep(pollMs);
      pids = await table.listByUid(uid);
      if (pids.length === 0 || now() >= deadline) break;
    }
  }
  return { graceful, forced, survivors: pids, durationMs: Math.max(0, now() - started) };
}
