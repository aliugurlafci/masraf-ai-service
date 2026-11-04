// apps/runner composition (contract §10.11, §16.7): config, restart recovery of persisted leases,
// socket startup, hello, graceful shutdown. POSIX only (Unix socket file, chmod semantics).
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileLeaseStateStore, createRunnerClient } from '@orc/sandbox';
import { loadRunnerConfig } from '@orc/shared/node';
import { createRunnerRuntime } from '../../../apps/runner/src/runtime';
import { ATTEMPT_ID, silentLogger } from '../../helpers/sandbox/fakes';
import { makeRoots } from '../../helpers/sandbox/roots';

const IS_WIN = process.platform === 'win32';
const STALE_ID = '33333333-3333-4333-8333-333333333333';

describe.skipIf(IS_WIN)(
  'runner runtime (POSIX only; skipped on win32: no Unix socket files)',
  () => {
    it('rejects a uid range containing the worker uid', () => {
      expect(() =>
        loadRunnerConfig({
          WORKSPACES_ROOT: '/w',
          CLAUDE_HOME_ROOT: '/c',
          CBM_CACHE_DIR: '/m',
          RUNNER_UID_BASE: '1000',
        }),
      ).toThrow(/RUNNER_UID_BASE|WORKER_UID|range/);
    });

    it('recovers stale leases, serves hello, refuses work after stop and removes the socket', async () => {
      const r = makeRoots();
      try {
        const stateDir = join(r.base, 'state');
        const socketPath = join(r.base, 'sock', 'runner.sock');
        const a = r.attemptPaths('t-runtime');
        await createFileLeaseStateStore(stateDir).write({
          v: 1,
          id: STALE_ID,
          key: `attempt-${ATTEMPT_ID}`,
          attemptId: ATTEMPT_ID,
          workerId: 'w',
          uid: 20001,
          gid: 20001,
          paths: [a.worktree, a.meta],
          acquiredAt: '2026-11-02T09:00:00.000Z',
        });
        const config = loadRunnerConfig({
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
          RUNNER_SOCKET_PATH: socketPath,
          RUNNER_STATE_DIR: stateDir,
          WORKSPACES_ROOT: r.ws,
          CLAUDE_HOME_ROOT: r.claudeHome,
          CBM_CACHE_DIR: r.cbm,
          RUNNER_MAX_LEASES: '4',
          RUNNER_KILL_GRACE_MS: '300',
          RUNNER_LEASE_TTL_MS: '5000',
        });
        const runtime = createRunnerRuntime(config, silentLogger());
        await runtime.start();
        expect(runtime.recovery).toMatchObject({ released: 1, failed: 0 });
        // Uid switching (root): CBM_CACHE_DIR and its p/ w/ anchored for codebase-memory-mcp (ADR-0034).
        for (const d of [r.cbm, join(r.cbm, 'p'), join(r.cbm, 'w')]) {
          if (runtime.identity !== 'switch') break;
          const st = lstatSync(d);
          expect([st.uid, st.gid, st.mode & 0o7777]).toEqual([0, config.workerGid, 0o1775]);
        }
        expect(existsSync(join(stateDir, 'leases', `${STALE_ID}.json`))).toBe(false);
        expect(existsSync(socketPath)).toBe(true);

        const client = createRunnerClient({ socketPath, requestTimeoutMs: 5000 });
        const hello = await client.hello();
        expect(hello).toMatchObject({
          protocol: 1,
          uidBase: 20000,
          maxLeases: 4,
          leaseTtlMs: 5000,
        });
        expect(hello.caps).toEqual(runtime.caps);
        const lease = await client.acquire({
          key: `attempt-${ATTEMPT_ID}`,
          attemptId: ATTEMPT_ID,
          workerId: 'w',
          paths: [a.worktree],
        });
        expect(existsSync(join(stateDir, 'leases', `${lease.id}.json`))).toBe(true);

        await runtime.stop();
        // Shutdown released the live lease and removed the socket.
        expect(existsSync(join(stateDir, 'leases', `${lease.id}.json`))).toBe(false);
        expect(existsSync(socketPath)).toBe(false);
        await expect(client.hello()).rejects.toMatchObject({
          details: { reason: 'runner_unavailable' },
        });
        await client.close();
      } finally {
        r.cleanup();
      }
    });
  },
);
