// Cuttable loopback TCP proxy in front of redis-test: simulates a Redis outage for one app instance (F8) without
// touching the shared container. cut() drops every connection and refuses new ones; restore() accepts again.
import { createServer, connect } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';

export interface TcpProxy {
  readonly port: number;
  cut(): Promise<void>;
  restore(): Promise<void>;
  close(): Promise<void>;
}

export async function startTcpProxy(targetHost: string, targetPort: number): Promise<TcpProxy> {
  const sockets = new Set<Socket>();
  let accepting = true;
  let port = 0;

  const makeServer = (): Server =>
    createServer((client) => {
      if (!accepting) {
        client.destroy();
        return;
      }
      const upstream = connect(targetPort, targetHost);
      sockets.add(client);
      sockets.add(upstream);
      const drop = (): void => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on('error', drop);
      upstream.on('error', drop);
      client.on('close', drop);
      upstream.on('close', drop);
      client.pipe(upstream);
      upstream.pipe(client);
    });

  let server = makeServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  const closeServer = (s: Server): Promise<void> => new Promise((resolve) => s.close(() => resolve()));

  return {
    get port() {
      return port;
    },
    async cut() {
      accepting = false;
      const closing = closeServer(server);
      for (const s of sockets) s.destroy();
      sockets.clear();
      await closing;
    },
    async restore() {
      if (accepting) return;
      accepting = true;
      server = makeServer();
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    },
    async close() {
      accepting = false;
      for (const s of sockets) s.destroy();
      sockets.clear();
      if (server.listening) await closeServer(server);
    },
  };
}
