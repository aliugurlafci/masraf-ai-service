// CONNECT allow-list egress proxy (contract §16.4, §10.11 item 7, ADR-0013, ADR-0024).
// Only `CONNECT host:port` to an allow-listed host and port, carrying the proxy token, whose
// resolved addresses are all public, is tunnelled. The upstream socket is opened to the very
// address that was validated (never re-resolved), which defeats DNS rebinding.
import { lookup as dnsLookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { connect as netConnect, isIP } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Logger } from '@orc/logger';
import type { Health } from '@orc/shared';
import type { EgressProxyConfig } from '@orc/shared/node';
import { PROXY_AUTH_REALM, createProxyAuthenticator } from './auth.js';
import { createHostMatcher, isPublicAddress, parseConnectTarget } from './policy.js';
import type { ConnectTarget } from './policy.js';

export interface EgressProxySettings {
  readonly allowedHosts: readonly string[];
  readonly allowedPorts: readonly number[];
  readonly denyPrivateIps: boolean;
  /** Budget for DNS resolution plus the TCP connect to the upstream. */
  readonly connectTimeoutMs: number;
  /** A tunnel without traffic in either direction for this long is closed. */
  readonly idleTimeoutMs: number;
  readonly maxConnections: number;
  /** null disables proxy authentication (development only; required in production). */
  readonly authToken: string | null;
  readonly version: string;
}

export function settingsFromConfig(config: EgressProxyConfig): EgressProxySettings {
  return {
    allowedHosts: config.egressAllowedHosts,
    allowedPorts: config.egressAllowedPorts,
    denyPrivateIps: config.egressDenyPrivateIps,
    connectTimeoutMs: config.egressConnectTimeoutMs,
    idleTimeoutMs: config.egressIdleTimeoutMs,
    maxConnections: config.egressMaxConnections,
    authToken: config.egressAuthToken,
    version: config.appVersion,
  };
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}
/** Resolves every address of a host name (dns.lookup with `all: true` semantics). */
export type LookupAllFn = (host: string) => Promise<readonly ResolvedAddress[]>;
/** Opens the upstream TCP connection to an already validated IP address. */
export type ConnectFn = (options: { host: string; port: number; family: 4 | 6 }) => Socket;

export interface EgressProxyDeps {
  readonly settings: EgressProxySettings;
  readonly logger: Logger;
  readonly lookup?: LookupAllFn;
  readonly connect?: ConnectFn;
}

export interface EgressProxy {
  readonly server: Server;
  listen(port: number, host: string): Promise<AddressInfo>;
  /** Stops accepting, lets tunnels drain for `graceMs`, then destroys the remaining ones. */
  close(graceMs?: number): Promise<void>;
  activeTunnels(): number;
}

export type DenyReason =
  | 'shutting_down'
  | 'proxy_auth_required'
  | 'invalid_target'
  | 'host_not_allowed'
  | 'port_not_allowed'
  | 'private_address'
  | 'dns_failed'
  | 'connect_timeout'
  | 'connect_failed'
  | 'method_not_allowed';

const DENY_STATUS: Readonly<Record<DenyReason, readonly [number, string]>> = {
  shutting_down: [503, 'Service Unavailable'],
  proxy_auth_required: [407, 'Proxy Authentication Required'],
  invalid_target: [400, 'Bad Request'],
  host_not_allowed: [403, 'Forbidden'],
  port_not_allowed: [403, 'Forbidden'],
  private_address: [403, 'Forbidden'],
  dns_failed: [502, 'Bad Gateway'],
  connect_timeout: [504, 'Gateway Timeout'],
  connect_failed: [502, 'Bad Gateway'],
  method_not_allowed: [403, 'Forbidden'],
};

/** How long a refused client may keep its socket open after the response was sent. */
const LINGER_MS = 2000;
const MAX_LOGGED_TARGET = 200;

const defaultLookup: LookupAllFn = async (host) => {
  const results = await dnsLookup(host, { all: true, order: 'ipv4first' });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

const defaultConnect: ConnectFn = (options) =>
  netConnect({ host: options.host, port: options.port, family: options.family });

class ConnectAbortedError extends Error {
  constructor() {
    super('connect deadline exceeded');
    this.name = 'ConnectAbortedError';
  }
}

function errorCode(err: unknown): string {
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') return err.code;
  return err instanceof Error ? err.name : 'unknown';
}

function truncate(value: string | undefined): string {
  if (value === undefined) return '';
  return value.length > MAX_LOGGED_TARGET ? `${value.slice(0, MAX_LOGGED_TARGET)}...` : value;
}

/** Sends a final response and closes the socket, destroying it if the peer never closes. */
function endWithResponse(socket: Duplex, head: string): void {
  if (socket.destroyed) return;
  socket.on('error', () => undefined);
  const timer = setTimeout(() => socket.destroy(), LINGER_MS);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
  socket.resume();
  socket.end(head);
}

function rawResponse(status: number, text: string, extraHeaders: readonly string[] = []): string {
  return [`HTTP/1.1 ${status} ${text}`, 'Connection: close', 'Content-Length: 0', ...extraHeaders]
    .join('\r\n')
    .concat('\r\n\r\n');
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ConnectAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new ConnectAbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function connectOnce(
  connect: ConnectFn,
  address: ResolvedAddress,
  port: number,
  signal: AbortSignal,
): Promise<Socket> {
  if (signal.aborted) return Promise.reject(new ConnectAbortedError());
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: address.address, port, family: address.family });
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      socket.removeListener('error', onError);
      socket.removeListener('connect', onConnect);
    };
    const onAbort = (): void => {
      cleanup();
      socket.on('error', () => undefined);
      socket.destroy();
      reject(new ConnectAbortedError());
    };
    const onError = (err: Error): void => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onConnect = (): void => {
      cleanup();
      resolve(socket);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

/** Tries every validated address in order until one accepts within the deadline. */
async function connectFirst(
  connect: ConnectFn,
  addresses: readonly ResolvedAddress[],
  port: number,
  signal: AbortSignal,
): Promise<{ socket: Socket; address: string }> {
  let lastError: unknown = new Error('no address');
  for (const address of addresses) {
    try {
      const socket = await connectOnce(connect, address, port, signal);
      return { socket, address: address.address };
    } catch (err) {
      if (err instanceof ConnectAbortedError) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

interface Tunnel {
  readonly client: Socket;
  readonly upstream: Socket;
  /** Settles once both sides closed and the decision was logged. */
  readonly done: Promise<void>;
}

export function createEgressProxy(deps: EgressProxyDeps): EgressProxy {
  const { settings, logger } = deps;
  const lookup = deps.lookup ?? defaultLookup;
  const connect = deps.connect ?? defaultConnect;
  const authenticate = createProxyAuthenticator(settings.authToken);
  const hostAllowed = createHostMatcher(settings.allowedHosts);
  const allowedPorts = new Set(settings.allowedPorts);
  const tunnels = new Set<Tunnel>();
  /** CONNECT requests that passed the policy checks and are resolving / connecting. */
  const pending = new Map<Socket, AbortController>();
  const startedAt = Date.now();
  let closing = false;

  const server = createServer({ headersTimeout: 15_000, keepAliveTimeout: 5_000 });
  server.maxConnections = settings.maxConnections;

  function logDenied(
    reason: DenyReason,
    fields: { host: string; port: number | null; client: string | null; started: number },
    extra: Record<string, unknown> = {},
  ): void {
    const [status] = DENY_STATUS[reason];
    logger.warn(
      {
        event: 'egress_decision',
        allowed: false,
        reason,
        status,
        host: fields.host,
        port: fields.port,
        client: fields.client,
        bytesUp: 0,
        bytesDown: 0,
        durationMs: Date.now() - fields.started,
        ...extra,
      },
      'egress request denied',
    );
  }

  function deny(
    client: Duplex,
    reason: DenyReason,
    fields: { host: string; port: number | null; client: string | null; started: number },
    extra: Record<string, unknown> = {},
  ): void {
    const [status, text] = DENY_STATUS[reason];
    const headers =
      reason === 'proxy_auth_required'
        ? [`Proxy-Authenticate: Basic realm="${PROXY_AUTH_REALM}"`]
        : [];
    endWithResponse(client, rawResponse(status, text, headers));
    logDenied(reason, fields, extra);
  }

  async function resolveTarget(
    target: ConnectTarget,
    signal: AbortSignal,
  ): Promise<readonly ResolvedAddress[]> {
    if (target.hostType === 'ipv4') return [{ address: target.host, family: 4 }];
    if (target.hostType === 'ipv6') return [{ address: target.host, family: 6 }];
    const addresses = await raceAbort(lookup(target.host), signal);
    return addresses.filter((a) => isIP(a.address) !== 0);
  }

  function startTunnel(
    client: Socket,
    upstream: Socket,
    head: Buffer,
    fields: { host: string; port: number; client: string | null; started: number; address: string },
  ): void {
    let markDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    const tunnel: Tunnel = { client, upstream, done };
    tunnels.add(tunnel);
    let closeReason = 'closed';
    let finished = false;
    let openSides = 2;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      tunnels.delete(tunnel);
      markDone();
      logger.info(
        {
          event: 'egress_decision',
          allowed: true,
          status: 200,
          host: fields.host,
          port: fields.port,
          address: fields.address,
          client: fields.client,
          bytesUp: upstream.bytesWritten,
          bytesDown: upstream.bytesRead,
          durationMs: Date.now() - fields.started,
          closeReason,
        },
        'egress tunnel closed',
      );
    };
    const abort = (reason: string): void => {
      if (closeReason === 'closed') closeReason = reason;
      client.destroy();
      upstream.destroy();
    };
    const onSideClosed = (): void => {
      openSides -= 1;
      if (openSides === 0) finish();
    };
    client.on('error', (err) => abort(`client_error:${errorCode(err)}`));
    upstream.on('error', (err) => abort(`upstream_error:${errorCode(err)}`));
    client.once('close', onSideClosed);
    upstream.once('close', onSideClosed);
    client.setTimeout(settings.idleTimeoutMs, () => abort('idle_timeout'));
    upstream.setTimeout(settings.idleTimeoutMs, () => abort('idle_timeout'));
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.setKeepAlive(true, 30_000);
    upstream.setKeepAlive(true, 30_000);

    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
    logger.debug(
      {
        event: 'egress_tunnel_open',
        host: fields.host,
        port: fields.port,
        address: fields.address,
      },
      'egress tunnel established',
    );
  }

  async function handleConnect(req: IncomingMessage, head: Buffer): Promise<void> {
    const client = req.socket;
    const started = Date.now();
    client.on('error', () => undefined);
    const target = parseConnectTarget(req.url);
    const fields = {
      host: target?.host ?? truncate(req.url),
      port: target?.port ?? null,
      client: client.remoteAddress ?? null,
      started,
    };

    if (closing) return deny(client, 'shutting_down', fields);
    // Authentication comes first so unauthenticated callers learn nothing about the policy.
    if (!authenticate(req.headers['proxy-authorization'])) {
      return deny(client, 'proxy_auth_required', fields);
    }
    if (target === null) return deny(client, 'invalid_target', fields);
    if (!hostAllowed(target.host)) return deny(client, 'host_not_allowed', fields);
    if (!allowedPorts.has(target.port)) return deny(client, 'port_not_allowed', fields);

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), settings.connectTimeoutMs);
    pending.set(client, deadline);
    try {
      let addresses: readonly ResolvedAddress[];
      try {
        addresses = await resolveTarget(target, deadline.signal);
      } catch (err) {
        if (err instanceof ConnectAbortedError) return deny(client, 'connect_timeout', fields);
        return deny(client, 'dns_failed', fields, { error: errorCode(err) });
      }
      if (addresses.length === 0) return deny(client, 'dns_failed', fields, { error: 'ENODATA' });
      if (settings.denyPrivateIps) {
        const refused = addresses.filter((a) => !isPublicAddress(a.address)).map((a) => a.address);
        if (refused.length > 0) {
          return deny(client, 'private_address', fields, { addresses: refused });
        }
      }
      if (closing) return deny(client, 'shutting_down', fields);
      if (client.destroyed) {
        logDenied('connect_failed', fields, { error: 'client_gone' });
        return;
      }

      let connected: { socket: Socket; address: string };
      try {
        connected = await connectFirst(connect, addresses, target.port, deadline.signal);
      } catch (err) {
        if (err instanceof ConnectAbortedError) return deny(client, 'connect_timeout', fields);
        return deny(client, 'connect_failed', fields, { error: errorCode(err) });
      }
      if (client.destroyed || closing) {
        connected.socket.destroy();
        if (!client.destroyed) return deny(client, 'shutting_down', fields);
        logDenied('connect_failed', fields, { error: 'client_gone' });
        return;
      }
      startTunnel(client, connected.socket, head, {
        host: target.host,
        port: target.port,
        client: fields.client,
        started,
        address: connected.address,
      });
    } finally {
      clearTimeout(timer);
      pending.delete(client);
    }
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const path = req.url ?? '';
    if (req.method === 'GET' && (path === '/healthz' || path.startsWith('/healthz?'))) {
      const body: Health = {
        status: closing ? 'fail' : 'ok',
        version: settings.version,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        checks: {},
      };
      res.writeHead(closing ? 503 : 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(403, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    res.end('Forbidden\n');
    logDenied(
      'method_not_allowed',
      {
        host: truncate(path),
        port: null,
        client: req.socket.remoteAddress ?? null,
        started: Date.now(),
      },
      { method: truncate(req.method) },
    );
  }

  server.on('request', handleRequest);
  server.on('connect', (req: IncomingMessage, _socket: Duplex, head: Buffer) => {
    handleConnect(req, head).catch((err: unknown) => {
      logger.error({ err, event: 'egress_internal_error' }, 'egress connect handler failed');
      req.socket.destroy();
    });
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    deny(socket, 'method_not_allowed', {
      host: truncate(req.url),
      port: null,
      client: req.socket.remoteAddress ?? null,
      started: Date.now(),
    });
  });
  server.on('clientError', (err: Error, socket: Duplex) => {
    logger.debug({ event: 'egress_client_error', error: errorCode(err) }, 'malformed request');
    endWithResponse(socket, rawResponse(400, 'Bad Request'));
  });
  server.on('drop', (data?: { remoteAddress?: string }) => {
    logger.warn(
      { event: 'egress_connection_dropped', client: data?.remoteAddress ?? null },
      'connection refused: EGRESS_MAX_CONNECTIONS reached',
    );
  });

  return {
    server,
    listen(port: number, host: string): Promise<AddressInfo> {
      return new Promise<AddressInfo>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.removeListener('error', onError);
          resolve(server.address() as AddressInfo);
        });
      });
    },
    async close(graceMs = 5_000): Promise<void> {
      closing = true;
      const closed = new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      server.closeIdleConnections();
      const deadline = Date.now() + graceMs;
      while ((tunnels.size > 0 || pending.size > 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // A CONNECT still resolving or connecting keeps its client socket open, so server.close()
      // would wait up to EGRESS_CONNECT_TIMEOUT_MS for it: abort it and drop the client.
      for (const [client, connectDeadline] of pending) {
        connectDeadline.abort();
        client.destroy();
      }
      pending.clear();
      const remaining = [...tunnels];
      for (const tunnel of remaining) {
        tunnel.client.destroy();
        tunnel.upstream.destroy();
      }
      server.closeAllConnections();
      await Promise.all(remaining.map((tunnel) => tunnel.done));
      await closed;
    },
    activeTunnels(): number {
      return tunnels.size;
    },
  };
}
