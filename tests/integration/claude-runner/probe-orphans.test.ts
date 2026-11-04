// CLI probe against fake-claude (recorded `claude --help` of 2.1.316) and the Claude orphan sweep
// over a file process registry (contract §10.8, §10.9).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeProbeError,
  claudeProcessKey,
  claudeRegistryEntry,
  sweepClaudeOrphans,
} from '@orc/claude-runner';
import { createFileProcessRegistry } from '@orc/shared/node';
import { isProcessAlive, waitFor } from '../../helpers/common';
import { ATTEMPT_ID, hostPlatform } from '../../helpers/claude/fake-claude';
import { useRunnerEnv } from '../../helpers/claude/integration';

const env = useRunnerEnv();
const OTHER_ATTEMPT = '99999999-8888-4777-8666-555555555555';

/** A long-lived node process carrying the attempt marker, outside any lease (an "orphan"). */
function spawnOrphan(attemptId: string): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], {
    env: { ...process.env, ORC_ATTEMPT_ID: attemptId },
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    shell: false,
  });
  child.on('error', () => undefined);
  child.unref();
  if (child.pid === undefined) throw new Error('orphan spawn failed');
  return child.pid;
}

describe('claude CLI probe (integration, fake-claude)', () => {
  it('accepts the recorded 2.1.316 help output', async () => {
    const e = env();
    const res = await e.runner().probe();
    expect(res).toMatchObject({ ok: true, version: '2.1.316', missingFlags: [] });
    expect(res.permissionModes).toContain('dontAsk');
  });

  it('rejects a CLI whose help lacks a required flag', async () => {
    const e = env();
    writeFileSync(join(e.layout.claudeHomeRoot, 'probe', 'fake-help-omit.txt'), '--fork-session\n');
    const err = await e.runner().probe().then(
      () => null,
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(ClaudeProbeError);
    expect((err as ClaudeProbeError).details?.missingFlags).toEqual(['--fork-session']);
  });

  it('a missing executable => ClaudeProbeError (spawn_failed)', async () => {
    const e = env();
    const err = await e
      .runner({ bin: join(e.layout.root, 'no-such-claude'), binPrefixArgs: [] })
      .probe()
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(err).toBeInstanceOf(ClaudeProbeError);
    expect((err as ClaudeProbeError).details?.reason).toBe('spawn_failed');
  });
});

describe.skipIf(process.platform === 'darwin')('claude orphan sweep (integration)', () => {
  it('kills registered Claude processes of inactive attempts and keeps active ones', async () => {
    const e = env();
    const registry = createFileProcessRegistry(join(e.layout.workspacesRoot, '.orc', 'run', 'worker-test-1'));
    const orphan = spawnOrphan(ATTEMPT_ID);
    const active = spawnOrphan(OTHER_ATTEMPT);
    e.trackPids(orphan);
    try {
      for (const [attemptId, pid] of [
        [ATTEMPT_ID, orphan],
        [OTHER_ATTEMPT, active],
      ] as const) {
        await registry.add(
          claudeRegistryEntry({
            attemptId,
            workerId: 'worker-test-1',
            pid,
            pgid: hostPlatform === 'posix' ? pid : null,
            startedAt: new Date(),
            bin: process.execPath,
            platform: hostPlatform,
          }),
        );
      }
      const report = await sweepClaudeOrphans({
        registry,
        activeAttemptIds: new Set([OTHER_ATTEMPT]),
        platform: hostPlatform,
      });
      expect(report.errors).toEqual([]);
      expect(report.killed.map((k) => k.pid)).toContain(orphan);
      expect(report.killed.map((k) => k.pid)).not.toContain(active);
      await waitFor(() => !isProcessAlive(orphan), { timeoutMs: 10_000, description: 'orphan to die' });
      expect(isProcessAlive(active)).toBe(true);
      const keys = (await registry.list()).map((x) => x.key);
      expect(keys).not.toContain(claudeProcessKey(ATTEMPT_ID));
      expect(keys).toContain(claudeProcessKey(OTHER_ATTEMPT));
    } finally {
      if (isProcessAlive(active)) process.kill(active, 'SIGKILL');
      await waitFor(() => !isProcessAlive(active), { timeoutMs: 10_000, description: 'active test process to die' });
    }
  });

  it('does not kill a live pid whose image no longer matches the entry (pid reuse guard)', async () => {
    const e = env();
    const registry = createFileProcessRegistry(join(e.layout.workspacesRoot, '.orc', 'run', 'worker-test-1'));
    const pid = spawnOrphan(OTHER_ATTEMPT);
    try {
      await registry.add({
        ...claudeRegistryEntry({
          attemptId: ATTEMPT_ID,
          workerId: 'worker-test-1',
          pid,
          pgid: hostPlatform === 'posix' ? pid : null,
          startedAt: new Date(),
          bin: hostPlatform === 'win32' ? 'C:\\tools\\not-node.exe' : '/usr/bin/not-node',
          platform: hostPlatform,
        }),
      });
      const report = await sweepClaudeOrphans({ registry, activeAttemptIds: new Set(), platform: hostPlatform });
      expect(report.killed.filter((k) => k.pid === pid && k.via === 'registry')).toEqual([]);
      expect((await registry.list()).map((x) => x.key)).not.toContain(claudeProcessKey(ATTEMPT_ID));
    } finally {
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
      await waitFor(() => !isProcessAlive(pid), { timeoutMs: 10_000, description: 'test process to die' });
    }
  });
});
