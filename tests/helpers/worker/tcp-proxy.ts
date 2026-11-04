// Cuttable TCP forwarder (fencing tests): one worker runtime reaches the test DB only through it, so the test can take
// that worker's database away (sockets destroyed, new connections refused) and give it back on the same port.
import net from 'node:net';

export interface TcpProxy {
  readonly port: number;
  /** Destroys every open connection and stops listening (new connections are refused). */
  cut(): Promise<void>;
  /** Listens again on the same port. */
  restore(): Promise<void>;
  close(): Promise<void>;
}

export async function startTcpProxy(target: { host: string; port: number }): Promise<TcpProxy> {
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket): void => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
    s.on('error', () => s.destroy());
  };
  const server = net.createServer((client) => {
    track(client);
    const upstream = net.connect(target.port, target.host);
    track(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  });
  const listen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
      });
    });
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  const port = await listen(0);
  return {
    port,
    cut: stop,
    async restore() {
      if (!server.listening) await listen(port);
    },
    close: stop,
  };
}
