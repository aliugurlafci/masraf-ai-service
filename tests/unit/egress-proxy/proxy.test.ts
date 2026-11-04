import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@orc/logger';
import { EgressProxyConfigSchema } from '@orc/shared/node';
import { proxyAuthorizationHeader } from '../../../apps/egress-proxy/src/auth.js';
import { createEgressProxy, settingsFromConfig } from '../../../apps/egress-proxy/src/proxy.js';
import type {
  ConnectFn,
  EgressProxy,
  EgressProxySettings,
  LookupAllFn,
  ResolvedAddress,
} from '../../../apps/egress-proxy/src/proxy.js';
import {
  LogCapture,
  rawRequest,
  readExactly,
  sendConnect,
  startEchoServer,
  waitForClose,
  waitUntil,
} from '../../helpers/devops/proxy-client.js';
import type { EchoServer } from '../../helpers/devops/proxy-client.js';

const TOKEN = 'egress_test_token_0123456789-abcdefXYZ';
const AUTH = { 'Proxy-Authorization': proxyAuthorizationHeader(TOKEN) };
const PUBLIC_IP = '160.79.104.10';

/** Stand-in DNS: names map to fixed answers; unknown names fail like NXDOMAIN. */
const DNS: Readonly<Record<string, readonly ResolvedAddress[] | 'hang'>> = {
  'api.anthropic.com': [{ address: PUBLIC_IP, family: 4 }],
  'public.allowed.test': [{ address: PUBLIC_IP, family: 4 }],
  'rebind.allowed.test': [{ address: '10.0.0.7', family: 4 }],
  'metadata.allowed.test': [{ address: '169.254.169.254', family: 4 }],
  'v6loop.allowed.test': [{ address: '::1', family: 6 }],
  'mixed.allowed.test': [
    { address: PUBLIC_IP, family: 4 },
    { address: '127.0.0.1', family: 4 },
  ],
  'slow.allowed.test': 'hang',
};

interface Harness {
  proxy: EgressProxy;
  port: number;
  logs: LogCapture;
  lookups: string[];
  connects: { host: string; port: number; family: 4 | 6 }[];
}

let echo: EchoServer;
let harness: Harness;
const clientSockets: Socket[] = [];

function baseSettings(overrides: Partial<EgressProxySettings> = {}): EgressProxySettings {
  return {
    allowedHosts: ['api.anthropic.com', '*.allowed.test', '127.0.0.1'],
    allowedPorts: [443],
    denyPrivateIps: true,
    connectTimeoutMs: 2_000,
    idleTimeoutMs: 60_000,
    maxConnections: 32,
    authToken: TOKEN,
    version: '1.2.3-test',
    ...overrides,
  };
}

async function startHarness(settings: EgressProxySettings): Promise<Harness> {
  const logs = new LogCapture();
  const logger = createLogger({
    service: 'egress-proxy',
    level: 'debug',
    version: 'test',
    env: 'test',
    destination: logs,
  });
  const lookups: string[] = [];
  const connects: Harness['connects'] = [];
  const lookup: LookupAllFn = (host) => {
    lookups.push(host);
    const answer = DNS[host];
    if (answer === 'hang') return new Promise(() => undefined);
    if (answer === undefined) {
      return Promise.reject(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }),
      );
    }
    return Promise.resolve(answer);
  };
  // Every validated upstream connection lands on the local echo server.
  const connectUpstream: ConnectFn = (options) => {
    connects.push(options);
    return connect(echo.port, '127.0.0.1');
  };
  const proxy = createEgressProxy({ settings, logger, lookup, connect: connectUpstream });
  const address = await proxy.listen(0, '127.0.0.1');
  return { proxy, port: address.port, logs, lookups, connects };
}

function track<T extends { socket: Socket }>(response: T): T {
  clientSockets.push(response.socket);
  return response;
}

function decisions(): Record<string, unknown>[] {
  return harness.logs.records().filter((r) => r.event === 'egress_decision');
}

beforeEach(async () => {
  echo = await startEchoServer();
  harness = await startHarness(baseSettings());
});

afterEach(async () => {
  for (const socket of clientSockets.splice(0)) socket.destroy();
  await harness.proxy.close(0);
  await echo.close();
});

describe('egress proxy: health and plain HTTP', () => {
  it('answers GET /healthz with 200 and a Health body', async () => {
    const res = await fetch(`http://127.0.0.1:${harness.port}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'ok', version: '1.2.3-test', checks: {} });
  });

  it.each([
    ['GET /', 'GET / HTTP/1.1\r\nHost: x\r\n\r\n'],
    [
      'absolute-form GET',
      'GET http://api.anthropic.com/ HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n',
    ],
    ['POST /healthz', 'POST /healthz HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n'],
    ['DELETE /', 'DELETE / HTTP/1.1\r\nHost: x\r\n\r\n'],
  ])('rejects %s with 403', async (_name, request) => {
    const res = track(await rawRequest(harness.port, request));
    expect(res.statusCode).toBe(403);
    expect(harness.lookups).toEqual([]);
    expect(harness.connects).toEqual([]);
  });

  it('rejects an Upgrade request with 403', async () => {
    const res = track(
      await rawRequest(
        harness.port,
        'GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      ),
    );
    expect(res.statusCode).toBe(403);
  });

  it('answers malformed requests with 400', async () => {
    const res = track(await rawRequest(harness.port, 'NOT A REQUEST\r\n\r\n'));
    expect(res.statusCode).toBe(400);
  });
});

describe('egress proxy: CONNECT authentication', () => {
  it('returns 407 with Proxy-Authenticate when the token is missing', async () => {
    const res = track(await sendConnect(harness.port, 'api.anthropic.com:443'));
    expect(res.statusCode).toBe(407);
    expect(res.headers['proxy-authenticate']).toBe('Basic realm="orc"');
    expect(harness.lookups).toEqual([]);
    expect(harness.connects).toEqual([]);
    await waitForClose(res.socket);
  });

  it('returns 407 for a wrong token and for a non-allow-listed host without token', async () => {
    const wrong = track(
      await sendConnect(harness.port, 'api.anthropic.com:443', {
        'Proxy-Authorization': proxyAuthorizationHeader(`${TOKEN}-wrong`),
      }),
    );
    expect(wrong.statusCode).toBe(407);
    const hidden = track(await sendConnect(harness.port, 'example.com:443'));
    expect(hidden.statusCode).toBe(407);
    expect(decisions().map((d) => d.reason)).toEqual([
      'proxy_auth_required',
      'proxy_auth_required',
    ]);
  });

  it('never writes the token to the log', async () => {
    track(await sendConnect(harness.port, 'api.anthropic.com:443', AUTH));
    track(await sendConnect(harness.port, 'example.com:443', AUTH));
    expect(harness.logs.lines.length).toBeGreaterThan(0);
    expect(harness.logs.text()).not.toContain(TOKEN);
    expect(harness.logs.text()).not.toContain(AUTH['Proxy-Authorization'].slice(6));
  });
});

describe('egress proxy: CONNECT allow-list', () => {
  it('tunnels an allow-listed host to the validated address and logs bytes', async () => {
    const res = track(await sendConnect(harness.port, 'api.anthropic.com:443', AUTH));
    expect(res.statusCode).toBe(200);
    expect(harness.connects).toEqual([{ host: PUBLIC_IP, port: 443, family: 4 }]);

    res.socket.write('hello through the tunnel');
    const echoed = await readExactly(res.socket, 24, res.rest);
    expect(echoed.toString()).toBe('hello through the tunnel');
    expect(harness.proxy.activeTunnels()).toBe(1);

    res.socket.end();
    await waitUntil(() => harness.proxy.activeTunnels() === 0);
    await waitUntil(() => decisions().length === 1);
    expect(decisions()[0]).toMatchObject({
      allowed: true,
      status: 200,
      host: 'api.anthropic.com',
      port: 443,
      address: PUBLIC_IP,
      bytesUp: 24,
      bytesDown: 24,
    });
    expect(typeof decisions()[0]?.durationMs).toBe('number');
  });

  it('forwards bytes the client pipelined after the CONNECT head', async () => {
    const res = track(
      await rawRequest(
        harness.port,
        `CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: ${AUTH['Proxy-Authorization']}\r\n\r\nearly`,
      ),
    );
    expect(res.statusCode).toBe(200);
    expect((await readExactly(res.socket, 5, res.rest)).toString()).toBe('early');
  });

  it('allows sub-domains of a *.domain entry', async () => {
    const res = track(await sendConnect(harness.port, 'Public.Allowed.Test:443', AUTH));
    expect(res.statusCode).toBe(200);
    expect(harness.lookups).toEqual(['public.allowed.test']);
    expect(harness.connects).toEqual([{ host: PUBLIC_IP, port: 443, family: 4 }]);
  });

  it.each([
    ['a host that is not allow-listed', 'example.com:443'],
    ['a look-alike host', 'api.anthropic.com.evil.net:443'],
    ['the apex of a *.domain entry', 'allowed.test:443'],
    ['a port that is not allow-listed', 'api.anthropic.com:80'],
  ])('returns 403 for %s without resolving it', async (_name, target) => {
    const res = track(await sendConnect(harness.port, target, AUTH));
    expect(res.statusCode).toBe(403);
    expect(harness.lookups).toEqual([]);
    expect(harness.connects).toEqual([]);
  });

  it('returns 400 for an invalid CONNECT target', async () => {
    const res = track(await sendConnect(harness.port, 'no-port-here', AUTH));
    expect(res.statusCode).toBe(400);
  });
});

describe('egress proxy: private addresses and DNS rebinding', () => {
  it.each([
    ['a private IPv4 answer', 'rebind.allowed.test:443'],
    ['the link-local metadata address', 'metadata.allowed.test:443'],
    ['an IPv6 loopback answer', 'v6loop.allowed.test:443'],
    ['a mixed public/private answer', 'mixed.allowed.test:443'],
    ['an allow-listed private IP literal', '127.0.0.1:443'],
  ])('returns 403 for %s and never connects', async (_name, target) => {
    const res = track(await sendConnect(harness.port, target, AUTH));
    expect(res.statusCode).toBe(403);
    expect(harness.connects).toEqual([]);
    expect(decisions().at(-1)).toMatchObject({ allowed: false, reason: 'private_address' });
  });

  it('connects to private addresses only when EGRESS_DENY_PRIVATE_IPS=false', async () => {
    await harness.proxy.close(0);
    harness = await startHarness(baseSettings({ denyPrivateIps: false }));
    const res = track(await sendConnect(harness.port, 'rebind.allowed.test:443', AUTH));
    expect(res.statusCode).toBe(200);
    expect(harness.connects).toEqual([{ host: '10.0.0.7', port: 443, family: 4 }]);
  });
});

describe('egress proxy: failures and timeouts', () => {
  it('returns 502 when DNS resolution fails', async () => {
    const res = track(await sendConnect(harness.port, 'nxdomain.allowed.test:443', AUTH));
    expect(res.statusCode).toBe(502);
    expect(decisions().at(-1)).toMatchObject({ reason: 'dns_failed', error: 'ENOTFOUND' });
  });

  it('returns 504 when resolution exceeds EGRESS_CONNECT_TIMEOUT_MS', async () => {
    await harness.proxy.close(0);
    harness = await startHarness(baseSettings({ connectTimeoutMs: 150 }));
    const res = track(await sendConnect(harness.port, 'slow.allowed.test:443', AUTH));
    expect(res.statusCode).toBe(504);
    expect(decisions().at(-1)).toMatchObject({ reason: 'connect_timeout' });
  });

  it('returns 502 when the upstream refuses the connection', async () => {
    await echo.close();
    const res = track(await sendConnect(harness.port, 'api.anthropic.com:443', AUTH));
    expect(res.statusCode).toBe(502);
    expect(decisions().at(-1)).toMatchObject({ reason: 'connect_failed', error: 'ECONNREFUSED' });
    echo = await startEchoServer();
  });

  it('closes idle tunnels after EGRESS_IDLE_TIMEOUT_MS', async () => {
    await harness.proxy.close(0);
    harness = await startHarness(baseSettings({ idleTimeoutMs: 200 }));
    const res = track(await sendConnect(harness.port, 'api.anthropic.com:443', AUTH));
    expect(res.statusCode).toBe(200);
    await waitForClose(res.socket, 3_000);
    await waitUntil(() => decisions().length === 1);
    expect(decisions()[0]).toMatchObject({ allowed: true, closeReason: 'idle_timeout' });
  });

  it('stops listening and destroys tunnels left after the shutdown grace period', async () => {
    const res = track(await sendConnect(harness.port, 'api.anthropic.com:443', AUTH));
    expect(res.statusCode).toBe(200);
    const closing = harness.proxy.close(100);
    await waitForClose(res.socket, 3_000);
    await closing;
    expect(harness.proxy.server.listening).toBe(false);
    expect(harness.proxy.activeTunnels()).toBe(0);
  });

  it('aborts a CONNECT that is still resolving when the grace period ends', async () => {
    await harness.proxy.close(0);
    harness = await startHarness(baseSettings({ connectTimeoutMs: 60_000 }));
    const socket = connect(harness.port, '127.0.0.1');
    clientSockets.push(socket);
    socket.on('error', () => undefined);
    socket.write(
      `CONNECT slow.allowed.test:443 HTTP/1.1\r\nHost: slow.allowed.test:443\r\n` +
        `Proxy-Authorization: ${AUTH['Proxy-Authorization']}\r\n\r\n`,
    );
    await waitUntil(() => harness.lookups.includes('slow.allowed.test'));
    const started = Date.now();
    await Promise.all([harness.proxy.close(100), waitForClose(socket, 3_000)]);
    // Without the abort, close() would wait for EGRESS_CONNECT_TIMEOUT_MS (60 s here).
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(harness.proxy.server.listening).toBe(false);
    expect(harness.connects).toEqual([]);
  });
});

describe('egress proxy: configuration mapping', () => {
  it('maps EgressProxyConfig (§16.4) onto proxy settings', () => {
    const config = EgressProxyConfigSchema.parse({
      NODE_ENV: 'production',
      APP_VERSION: '9.9.9',
      EGRESS_AUTH_TOKEN: TOKEN,
      EGRESS_ALLOWED_HOSTS: 'API.anthropic.com, *.example.org',
      EGRESS_ALLOWED_PORTS: '443,8443',
    });
    expect(settingsFromConfig(config)).toEqual({
      allowedHosts: ['api.anthropic.com', '*.example.org'],
      allowedPorts: [443, 8443],
      denyPrivateIps: true,
      connectTimeoutMs: 10_000,
      idleTimeoutMs: 600_000,
      maxConnections: 256,
      authToken: TOKEN,
      version: '9.9.9',
    });
  });
});
