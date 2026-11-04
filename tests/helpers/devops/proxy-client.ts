// Raw-socket helpers for egress-proxy tests: CONNECT requests, plain HTTP requests, a local
// echo upstream and a log capture stream. No external network access is ever made.
import { Writable } from 'node:stream';
import { connect, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

export interface RawResponse {
  readonly statusCode: number;
  readonly statusLine: string;
  /** Lower-case header names. */
  readonly headers: Readonly<Record<string, string>>;
  /** Bytes received after the response head (tunnel payload or body). */
  readonly rest: Buffer;
  readonly socket: Socket;
}

const HEAD_END = Buffer.from('\r\n\r\n');

function parseHead(head: string): Pick<RawResponse, 'statusCode' | 'statusLine' | 'headers'> {
  const lines = head.split('\r\n');
  const statusLine = lines[0] ?? '';
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { statusCode: match ? Number(match[1]) : 0, statusLine, headers };
}

/** Writes `request` to 127.0.0.1:`port` and resolves once the response head has arrived. */
export function rawRequest(port: number, request: string, timeoutMs = 5_000): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no response head within ${timeoutMs} ms`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf(HEAD_END);
      if (end < 0) return;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.pause();
      resolve({
        ...parseHead(received.subarray(0, end).toString('latin1')),
        rest: received.subarray(end + HEAD_END.length),
        socket,
      });
    };
    socket.on('data', onData);
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      reject(new Error(`connection closed before a response head (got ${received.length} bytes)`));
    });
    socket.write(request);
  });
}

/** Sends `CONNECT target HTTP/1.1` with optional extra header lines. */
export function sendConnect(
  port: number,
  target: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<RawResponse> {
  const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return rawRequest(port, `${lines.join('\r\n')}\r\n\r\n`);
}

/** Reads from an established tunnel until `expected` bytes arrived. */
export function readExactly(
  socket: Socket,
  expected: number,
  initial: Buffer = Buffer.alloc(0),
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let received = initial;
    if (received.length >= expected) {
      resolve(received.subarray(0, expected));
      return;
    }
    const timer = setTimeout(() => reject(new Error('tunnel read timed out')), 5_000);
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= expected) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        resolve(received.subarray(0, expected));
      }
    };
    socket.on('data', onData);
    socket.resume();
  });
}

/** Resolves once the peer closed `socket`. */
export function waitForClose(socket: Socket, timeoutMs = 5_000): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.resume();
  });
}

export interface EchoServer {
  readonly port: number;
  readonly connections: () => number;
  close(): Promise<void>;
}

/** TCP echo server on 127.0.0.1 standing in for the real upstream. */
export async function startEchoServer(): Promise<EchoServer> {
  const sockets = new Set<Socket>();
  let total = 0;
  const server: Server = createServer((socket) => {
    total += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('echo server has no port');
  return {
    port: address.port,
    connections: () => total,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Collects JSON log lines written by a pino logger. */
export class LogCapture extends Writable {
  readonly lines: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: () => void): void {
    for (const line of chunk.toString().split('\n'))
      if (line.trim().length > 0) this.lines.push(line);
    callback();
  }

  records(): Record<string, unknown>[] {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  text(): string {
    return this.lines.join('\n');
  }
}

/** Polls `predicate` until it holds or `timeoutMs` passes. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
