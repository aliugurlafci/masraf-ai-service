// Worker health endpoints (contract §14.6): GET /health/live and GET /health/ready, nothing else.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Health } from '@orc/shared';

export type CheckResult = Health['checks'][string];

export interface HealthSource {
  version: string;
  startedAtMs: number;
  /** Live checks (each bounded by the caller); cached for CHECK_CACHE_MS. */
  checks(): Promise<Record<string, CheckResult>>;
  /** Readiness gate beyond the checks (startup finished, not draining, heartbeat DB healthy). */
  ready(checks: Record<string, CheckResult>): boolean;
}

export const CHECK_CACHE_MS = 5000;

export interface HealthServer {
  readonly address: { host: string; port: number } | null;
  listen(host: string, port: number): Promise<void>;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function createHealthServer(src: HealthSource): HealthServer {
  let cached: { at: number; checks: Record<string, CheckResult> } | null = null;
  let pending: Promise<Record<string, CheckResult>> | null = null;
  let address: { host: string; port: number } | null = null;

  const checks = async (): Promise<Record<string, CheckResult>> => {
    if (cached !== null && Date.now() - cached.at < CHECK_CACHE_MS) return cached.checks;
    pending ??= src
      .checks()
      .then((c) => {
        cached = { at: Date.now(), checks: c };
        return c;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  const uptime = (): number => Math.max(0, (Date.now() - src.startedAtMs) / 1000);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { status: 'fail', detail: 'method not allowed' });
      return;
    }
    if (url === '/health/live') {
      const body: Health = { status: 'ok', version: src.version, uptimeSeconds: uptime(), checks: {} };
      send(res, 200, body);
      return;
    }
    if (url === '/health/ready') {
      const c = await checks();
      const ok = src.ready(c);
      const body: Health = { status: ok ? 'ok' : 'fail', version: src.version, uptimeSeconds: uptime(), checks: c };
      send(res, ok ? 200 : 503, body);
      return;
    }
    send(res, 404, { status: 'fail', detail: 'not found' });
  };

  let server: Server | null = null;
  return {
    get address() {
      return address;
    },
    listen(host, port) {
      return new Promise((resolve, reject) => {
        const s = createServer((req, res) => {
          handle(req, res).catch(() => {
            if (!res.headersSent) send(res, 500, { status: 'fail' });
            else res.end();
          });
        });
        s.once('error', reject);
        s.listen(port, host, () => {
          s.off('error', reject);
          const a = s.address() as AddressInfo;
          address = { host, port: a.port };
          server = s;
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (server === null) {
          resolve();
          return;
        }
        server.closeAllConnections();
        server.close(() => resolve());
        server = null;
      });
    },
  };
}
