// Cross-platform process liveness for tests (contract §18.2 "Processes").
// Builds on @orc/shared/node isProcessAlive (process.kill(pid, 0), EPERM => alive; on Windows
// libuv reports an exited process as ESRCH) and additionally treats Linux zombies as dead:
// a killed grandchild re-parented to a PID 1 that never reaps it still answers kill(pid, 0).
import { readFileSync } from 'node:fs';
import { isProcessAlive as pidExists } from '@orc/shared/node';
import { waitFor } from './wait-for';
import type { WaitForOptions } from './wait-for';

function errnoCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** Linux scheduler state ('R', 'S', 'Z', ...); null when the process is gone; undefined when unknown. */
function linuxProcessState(pid: number): string | null | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    const code = errnoCode(error);
    return code === 'ENOENT' || code === 'ESRCH' ? null : undefined;
  }
  // Format: "<pid> (<comm>) <state> ..."; comm may contain spaces and parentheses.
  const state = stat.slice(stat.lastIndexOf(')') + 2).charAt(0);
  return state === '' ? undefined : state;
}

export function isProcessAlive(pid: number): boolean {
  if (!pidExists(pid)) return false;
  if (process.platform !== 'linux') return true;
  const state = linuxProcessState(pid);
  return state !== null && state !== 'Z' && state !== 'X';
}

/** Resolves once `pid` is no longer alive; rejects with WaitForTimeoutError otherwise. */
export async function waitForProcessExit(pid: number, options: WaitForOptions = {}): Promise<void> {
  await waitFor(() => !isProcessAlive(pid), {
    description: `process ${pid} to exit`,
    ...options,
  });
}

/** PIDs from `pids` that are still alive (for afterEach orphan assertions). */
export function aliveProcesses(pids: Iterable<number>): number[] {
  return [...pids].filter((pid) => isProcessAlive(pid));
}
