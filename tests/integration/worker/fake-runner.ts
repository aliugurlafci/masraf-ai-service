// Fake runner for worker integration tests (SANDBOX_MODE=runner on any host): the real runner protocol server
// (`createRunnerServer`) on a Unix socket / named pipe, backed by the local launcher instead of uid-switching lease
// handling. Tests can drop spawn connections (runner crash) and reject lease renewals (runner restarted: lease unknown).
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createLocalLauncher,
  createRunnerServer,
  runnerError,
  type LeaseManager,
  type LocalLauncher,
  type RunnerServer,
} from '@orc/sandbox';
import type { LaunchLease, LeaseInfo } from '@orc/shared/node';
import { createLogger } from '@orc/logger';

/** Reported TTL (the worker refuses a runner whose TTL exceeds its self-fence window); the backend never fences. */
const LEASE_TTL_MS = 1000;

export interface FakeRunner {
  readonly socketPath: string;
  /** Kinds of the spawn sessions that are currently open. */
  openSessions(): string[];
  /** Destroys every open spawn connection of `kind` (the runner then stops the child); returns how many. */
  dropSessions(kind: 'claude' | 'test' | 'mcp'): number;
  /** While true every `lease_renew` fails with `lease_expired` (a restarted runner no longer knows the lease). */
  rejectRenewals: boolean;
  readonly renewRejections: number;
  close(): Promise<void>;
}

const expired = (): Error =>
  runnerError('process_spawn_failed', 'lease_expired', 'Lease expired or unknown');

function localBackedManager(
  local: LocalLauncher,
  ctl: { rejectRenewals: boolean; renewRejections: number },
): LeaseManager {
  const leases = new Map<string, { lease: LaunchLease; info: LeaseInfo }>();
  const get = (id: string): { lease: LaunchLease; info: LeaseInfo } => {
    const l = leases.get(id);
    if (l === undefined) throw expired();
    return l;
  };
  return {
    async acquire(input) {
      const lease = await local.acquire(input);
      const info: LeaseInfo = {
        id: lease.id,
        key: lease.key,
        attemptId: input.attemptId,
        workerId: input.workerId,
        uid: null,
        pids: [],
        expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
      };
      leases.set(lease.id, { lease, info });
      return info;
    },
    async renew(id) {
      if (ctl.rejectRenewals) {
        ctl.renewRejections += 1;
        throw expired();
      }
      await get(id).lease.renew();
      return { expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString() };
    },
    async release(id) {
      const out = await get(id).lease.release();
      leases.delete(id);
      return out;
    },
    measure: (id, target, maxEntries) => get(id).lease.measure(target, maxEntries),
    list: () => [...leases.values()].map((l) => l.info),
    async spawn(id, input) {
      const [cmd, ...args] = input.argv as [string, ...string[]];
      const proc = await local.spawn(get(id).lease, {
        kind: input.kind,
        cmd,
        args,
        cwd: input.cwd,
        env: input.env,
        ...(input.credentialFd !== undefined ? { credentialFd: input.credentialFd } : {}),
      });
      return { proc, uid: null };
    },
    recoverStale: () =>
      Promise.resolve({ released: 0, failed: 0, invalidStateFiles: 0, strayProcessesKilled: 0 }),
    reapExpired: () => Promise.resolve(),
    startReaper: () => undefined,
    async close() {
      leases.clear();
      await local.close();
    },
  };
}

export async function startFakeRunner(): Promise<FakeRunner> {
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\orc-fake-runner-${randomUUID()}`
      : path.join(tmpdir(), `orc-fr-${randomUUID().slice(0, 8)}.sock`);
  const logger = createLogger({ service: 'test', level: 'silent', version: 'test', env: 'test' });
  const ctl = { rejectRenewals: false, renewRejections: 0 };
  const local = createLocalLauncher({ killGraceMs: 1000, logger });
  const manager = localBackedManager(local, ctl);
  const server: RunnerServer = createRunnerServer({
    socketPath,
    manager,
    hello: {
      uidBase: 20000,
      maxLeases: 64,
      leaseTtlMs: LEASE_TTL_MS,
      caps: { ok: true, uidSwitch: true, chown: true, kill: true, prlimit: true, procfs: true },
    },
    logger,
    maxConnections: 64,
    socketGroup: null,
    killGraceMs: 1000,
  });
  const sessions = new Map<net.Socket, string>();
  const sockets = new Set<net.Socket>();
  const listener = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => {
      sockets.delete(sock);
      sessions.delete(sock);
    });
    sock.on('error', () => undefined);
    let head = '';
    const sniff = (chunk: Buffer): void => {
      head += chunk.toString('utf8');
      const nl = head.indexOf('\n');
      if (nl < 0 && head.length < 4096) return;
      sock.off('data', sniff);
      const m = /"type":"spawn".*"kind":"(claude|test|mcp)"/.exec(
        head.slice(0, nl < 0 ? head.length : nl),
      );
      if (m?.[1] !== undefined) sessions.set(sock, m[1]);
    };
    server.handleConnection(sock);
    sock.on('data', sniff);
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    openSessions: () => [...sessions.values()],
    dropSessions(kind) {
      let n = 0;
      for (const [sock, k] of sessions) {
        if (k !== kind) continue;
        sock.destroy();
        n += 1;
      }
      return n;
    },
    get rejectRenewals() {
      return ctl.rejectRenewals;
    },
    set rejectRenewals(v: boolean) {
      ctl.rejectRenewals = v;
    },
    get renewRejections() {
      return ctl.renewRejections;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await manager.close();
    },
  };
}
