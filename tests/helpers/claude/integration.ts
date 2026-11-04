// Vitest wiring for claude-runner integration tests: per-test temp layout, local launcher, attempt
// lease, and the §18.2 process assertion (every PID reported by fake-claude is dead afterwards).
import { afterEach, beforeEach, expect } from 'vitest';
import type { LaunchLease } from '@orc/shared/node';
import { createSecretRegistry, type SecretRegistry } from '@orc/security';
import { createClaudeRunner, type ClaudeRunner, type ClaudeRunnerConfig } from '@orc/claude-runner';
import { aliveProcesses, createTempDir, waitFor, type TempDir } from '../common';
import { ATTEMPT_ID, createRunnerLayout, fakeRunnerConfig, type RunnerLayout } from './fake-claude';
import { createTestLocalLauncher, type TestLocalLauncher } from './local-launcher';
import { silentLogger } from './memory-process';

export interface RunnerEnv {
  layout: RunnerLayout;
  launcher: TestLocalLauncher;
  lease: LaunchLease;
  secrets: SecretRegistry;
  /** PIDs that must be dead after the test (child and grandchildren). */
  trackPids(...pids: (number | null | undefined)[]): void;
  runner(overrides?: Partial<ClaudeRunnerConfig>): ClaudeRunner;
}

export function useRunnerEnv(): () => RunnerEnv {
  let current: (RunnerEnv & { dir: TempDir; pids: Set<number> }) | undefined;

  beforeEach(async () => {
    const dir = await createTempDir('orc-claude-runner-');
    const layout = await createRunnerLayout(dir.path);
    const launcher = createTestLocalLauncher();
    const lease = await launcher.acquire({
      key: `attempt-${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
      workerId: 'worker-test-1',
      paths: [layout.worktree, layout.metaDir],
    });
    const secrets = createSecretRegistry();
    const pids = new Set<number>();
    current = {
      dir,
      pids,
      layout,
      launcher,
      lease,
      secrets,
      trackPids: (...list) => {
        for (const pid of list) if (typeof pid === 'number' && pid > 0) pids.add(pid);
      },
      runner: (overrides = {}) =>
        createClaudeRunner(fakeRunnerConfig(layout, overrides), { logger: silentLogger(), secrets, launcher }),
    };
  });

  afterEach(async () => {
    const env = current;
    current = undefined;
    if (!env) return;
    for (const l of env.launcher.launches) env.pids.add(l.proc.pid);
    // The test itself already asserted death where it matters; this is the §18.2 safety net.
    const alive = aliveProcesses(env.pids);
    await env.lease.release();
    await env.launcher.close();
    if (alive.length > 0) {
      await waitFor(() => aliveProcesses(env.pids).length === 0, {
        timeoutMs: 10_000,
        description: 'leftover test processes to die',
      }).catch(() => undefined);
    }
    await env.dir.cleanup();
    expect(alive, 'processes alive after the test').toEqual([]);
  });

  return () => {
    if (!current) throw new Error('useRunnerEnv: only available inside a test');
    return current;
  };
}
