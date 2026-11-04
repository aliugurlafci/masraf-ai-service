// Scriptable fake `spawn` for @orc/git-manager unit tests: records argv/cwd/env/stdin of every git
// call and answers with scripted stdout/stderr/exit codes. Never starts a real process.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnFn } from '@orc/shared/node';

export interface FakeCall {
  cmd: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string>;
  options: Record<string, unknown>;
  stdin: string;
}

export interface FakeResponse {
  code?: number;
  stdout?: string | Buffer;
  stderr?: string;
  /** Delay before exiting (used with short timeouts). */
  delayMs?: number;
  /** Emit an 'error' instead of spawning (ENOENT). */
  spawnError?: boolean;
}

export type Responder = (call: FakeCall) => FakeResponse;

/** Unlikely to be a real process (group) id: kill/probe calls of runProcess get ESRCH. */
const FAKE_PID = 2_000_000_000;

class FakeChild extends EventEmitter {
  readonly pid: number | undefined;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }
  kill(): boolean {
    return true;
  }
}

export interface FakeSpawn {
  spawn: SpawnFn;
  calls: FakeCall[];
  /** Calls of the git binary only, argv after the isolation prefix split off. */
  gitCalls(): { prefix: string[]; rest: string[]; call: FakeCall }[];
}

/** Splits the `-c key=value` isolation prefix (§11.3) from the operation argv. */
export function splitPrefix(args: readonly string[]): { prefix: string[]; rest: string[] } {
  let i = 0;
  while (i + 1 < args.length && args[i] === '-c') i += 2;
  return { prefix: args.slice(0, i), rest: args.slice(i) };
}

export function createFakeSpawn(responder: Responder, gitBin = 'git'): FakeSpawn {
  const calls: FakeCall[] = [];
  const spawn = ((cmd: string, args: readonly string[], options: Record<string, unknown>) => {
    const call: FakeCall = {
      cmd,
      args: [...args],
      cwd: options.cwd as string | undefined,
      env: { ...(options.env as Record<string, string>) },
      options,
      stdin: '',
    };
    calls.push(call);
    const isGit = cmd === gitBin;
    const res: FakeResponse = isGit ? responder(call) : { code: 0, stdout: '[]' };
    const child = new FakeChild(res.spawnError ? undefined : FAKE_PID);
    const stdinChunks: Buffer[] = [];
    child.stdin.on('data', (c: Buffer) => stdinChunks.push(c));
    setImmediate(() => {
      if (res.spawnError) {
        const err = Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
        child.emit('error', err);
        return;
      }
      child.emit('spawn');
      const finish = (): void => {
        call.stdin = Buffer.concat(stdinChunks).toString('utf8');
        const code = res.code ?? 0;
        let pending = 2;
        const done = (): void => {
          pending -= 1;
          if (pending > 0) return;
          child.exitCode = code;
          child.emit('exit', code, null);
          child.emit('close', code, null);
        };
        child.stdout.once('end', done);
        child.stderr.once('end', done);
        if (res.stdout !== undefined) child.stdout.write(res.stdout);
        if (res.stderr !== undefined) child.stderr.write(res.stderr);
        child.stdout.end();
        child.stderr.end();
      };
      const wait = (): void => {
        if (res.delayMs) setTimeout(finish, res.delayMs);
        else finish();
      };
      // 'end' of the readable side => every stdin byte has reached the 'data' listener above.
      if (child.stdin.readableEnded) wait();
      else child.stdin.once('end', wait);
    });
    return child;
  }) as unknown as SpawnFn;
  return {
    spawn,
    calls,
    gitCalls: () =>
      calls.filter((c) => c.cmd === gitBin).map((call) => ({ ...splitPrefix(call.args), call })),
  };
}
