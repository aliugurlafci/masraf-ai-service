// Shared helpers of the worker "no orphan" gates (contract §18.5): fixture loading and PID collection from the
// persisted attempt logs (fake-claude `fake_pid` events and the orphan-tests fixture announcements).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Uuid } from '@orc/shared';
import { aliveProcesses } from '../common/process';
import { waitFor } from '../common/wait-for';
import type { WorkerWorld } from './world';

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/repos/orphan-tests', import.meta.url));
const FIXTURE_SKIP = new Set(['fixture.json', 'README.md', 'orphan-pids.json']);

export const ORPHAN_TEST_COMMAND = ['node', 'run-tests.mjs'] as const;

/** Files of tests/fixtures/repos/orphan-tests as a source-repository file map. */
export function orphanFixtureFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(FIXTURE_DIR)) {
    const full = path.join(FIXTURE_DIR, name);
    if (FIXTURE_SKIP.has(name) || !statSync(full).isFile()) continue;
    files[name] = readFileSync(full, 'utf8');
  }
  return files;
}

/** Directive of the Claude-stage grandchild: detached (own session) only where the host supports it. */
export function grandchildDirective(): string {
  return process.platform === 'win32'
    ? '@@fake spawn-grandchild'
    : '@@fake spawn-grandchild detached';
}

async function attemptLogText(world: WorkerWorld, attemptId: Uuid): Promise<string> {
  const logs = await world.db.repos.taskLogs.listByAttempt({ attemptId, limit: 5000 });
  return logs.map((l) => l.content).join('');
}

/** PIDs announced by fake-claude (`fake_pid`) so far. */
export async function fakeClaudePids(world: WorkerWorld, attemptId: Uuid): Promise<number[]> {
  const text = await attemptLogText(world, attemptId);
  return [...text.matchAll(/"subtype":"fake_pid","pid":(\d+)/g)].map((m) => Number(m[1]));
}

/** PIDs announced by the orphan-tests fixture command (test process, detached grandchild). */
export async function fixturePids(
  world: WorkerWorld,
  attemptId: Uuid,
): Promise<{ test: number; grandchild: number } | null> {
  const text = await attemptLogText(world, attemptId);
  const t = /ORC_ORPHAN_TEST_PID=(\d+)/.exec(text);
  const g = /ORC_ORPHAN_GRANDCHILD_PID=(\d+)/.exec(text);
  return t?.[1] && g?.[1] ? { test: Number(t[1]), grandchild: Number(g[1]) } : null;
}

export async function waitForFixturePids(
  world: WorkerWorld,
  attemptId: Uuid,
): Promise<{ test: number; grandchild: number }> {
  return waitFor(() => fixturePids(world, attemptId), {
    timeoutMs: 40_000,
    intervalMs: 200,
    description: 'orphan-tests fixture PIDs in the task log',
  });
}

export async function expectNoSurvivors(pids: readonly number[]): Promise<void> {
  await waitFor(() => aliveProcesses(pids).length === 0, {
    timeoutMs: 20_000,
    intervalMs: 200,
    description: `no surviving processes (${pids.join(',')})`,
  });
}
