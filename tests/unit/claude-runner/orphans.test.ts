// PID persistence helpers and the Claude-only orphan sweep view (contract §10.8).
import { describe, expect, it } from 'vitest';
import { claudeProcessKey, claudeRegistryEntry, sweepClaudeOrphans } from '@orc/claude-runner';
import type { ProcessRegistry, ProcessRegistryEntry } from '@orc/shared/node';

const ATTEMPT = '11111111-2222-4333-8444-555555555555';

function memoryRegistry(entries: ProcessRegistryEntry[]): ProcessRegistry & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    add: (e) => {
      entries.push(e);
      return Promise.resolve();
    },
    remove: (key) => {
      removed.push(key);
      const i = entries.findIndex((e) => e.key === key);
      if (i >= 0) entries.splice(i, 1);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...entries]),
  };
}

describe('claude orphan helpers', () => {
  it('registry key is claude-<attemptId>', () => {
    expect(claudeProcessKey(ATTEMPT)).toBe(`claude-${ATTEMPT}`);
  });

  it('registry entry records the executable basename per platform', () => {
    const startedAt = new Date('2026-01-02T03:04:05.678Z');
    expect(
      claudeRegistryEntry({
        attemptId: ATTEMPT,
        workerId: 'w1',
        pid: 4242,
        pgid: 4242,
        startedAt,
        bin: '/usr/local/bin/claude',
        platform: 'posix',
      }),
    ).toEqual({
      key: `claude-${ATTEMPT}`,
      kind: 'claude',
      pid: 4242,
      pgid: 4242,
      attemptId: ATTEMPT,
      workerId: 'w1',
      startedAt: '2026-01-02T03:04:05.678Z',
      command: 'claude',
    });
    expect(
      claudeRegistryEntry({
        attemptId: ATTEMPT,
        workerId: 'w1',
        pid: 7,
        pgid: null,
        startedAt,
        bin: 'C:\\Program Files\\nodejs\\node.exe',
        platform: 'win32',
      }).command,
    ).toBe('node.exe');
  });

  it('the sweep only sees claude entries and never removes entries of other kinds', async () => {
    const foreign: ProcessRegistryEntry = {
      key: 'git-x',
      kind: 'git',
      pid: 2_147_483_000,
      pgid: null,
      attemptId: ATTEMPT,
      workerId: 'w1',
      startedAt: '2026-01-02T03:04:05.678Z',
      command: 'git',
    };
    const registry = memoryRegistry([foreign]);
    const report = await sweepClaudeOrphans({
      registry,
      activeAttemptIds: new Set(),
      platform: 'posix',
      procRoot: '/nonexistent-proc-root-for-test',
    });
    expect(report.checked).toBe(0);
    expect(report.killed).toEqual([]);
    expect(registry.removed).toEqual([]);
  });
});
