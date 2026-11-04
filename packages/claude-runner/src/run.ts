// One supervised Claude run (contract §10.1, §10.5-§10.8).
import { StringDecoder } from 'node:string_decoder';
import { parseClaudeLine } from '@orc/shared';
import type { ClaudeInitEvent, ClaudeResultEvent, Clock, ParsedClaudeLine } from '@orc/shared';
import type { KillResult, ProcessLauncher, SupervisedProcess } from '@orc/shared/node';
import { assertSafeArgv, createStreamMasker, maskText } from '@orc/security';
import type { SecretRegistry, StreamMasker } from '@orc/security';
import { serializeError } from '@orc/logger';
import type { Logger } from '@orc/logger';
import { CLAUDE_INTERNAL_TOOL_NAMES, CLAUDE_PERMISSION_MODE } from './constants';
import { validateInit } from './init-validation';
import { LineSplitter, type SplitLine } from './line-splitter';
import { isSpawnFailure } from './spawn-errors';
import type {
  AbortReason,
  ClaudeOutcome,
  ClaudeRunHandlers,
  ClaudeRunnerConfig,
  ClaudeRunRequest,
  ClaudeRunResult,
  InitViolation,
} from './types';

const ABORT_REASONS: readonly AbortReason[] = [
  'cancel',
  'timeout',
  'worker_shutdown',
  'quota',
  'output_limit',
  'security_violation',
];

const OUTCOME_BY_REASON: Readonly<Record<StopReason, ClaudeOutcome>> = {
  cancel: 'cancelled',
  timeout: 'timeout',
  worker_shutdown: 'shutdown',
  quota: 'quota',
  output_limit: 'output_limit',
  security_violation: 'security_violation',
  init_timeout: 'init_timeout',
};

/** After the leader exited, stdio may be held by an escaped descendant: stop waiting after this. */
const STREAM_END_AFTER_EXIT_MS = 2000;
/** After a stop reports the leader as a survivor, stop waiting for its exit after this. */
const EXIT_AFTER_FAILED_STOP_MS = 5000;
const MAX_TIMER_MS = 2_147_483_647;

type StopReason = AbortReason | 'init_timeout';

export function toAbortReason(reason: unknown): AbortReason {
  return typeof reason === 'string' && (ABORT_REASONS as readonly string[]).includes(reason)
    ? (reason as AbortReason)
    : 'cancel';
}

export function outcomeForStopReason(reason: StopReason): ClaudeOutcome {
  return OUTCOME_BY_REASON[reason];
}

export interface RunContext {
  cfg: ClaudeRunnerConfig;
  logger: Logger;
  secrets: SecretRegistry;
  launcher: ProcessLauncher;
  clock: Clock;
  argv: string[];
  env: Record<string, string>;
}

function emptyResult(outcome: ClaudeOutcome, durationMs: number): ClaudeRunResult {
  return {
    outcome,
    exitCode: null,
    signal: null,
    sessionId: null,
    init: null,
    result: null,
    violation: null,
    outputBytes: 0,
    durationMs,
    kill: null,
  };
}

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
}

function destroyStream(stream: NodeJS.ReadableStream): void {
  const s = stream as NodeJS.ReadableStream & { destroy?: () => void };
  if (typeof s.destroy === 'function') s.destroy();
}

function mergeKills(results: KillResult[]): KillResult | null {
  if (results.length === 0) return null;
  const forced = results.some((r) => r.forced);
  const last = results[results.length - 1] as KillResult;
  return {
    graceful: !forced && results.every((r) => r.graceful),
    forced,
    survivors: [...new Set(last.survivors)],
    durationMs: Math.max(...results.map((r) => r.durationMs)),
  };
}

class ClaudeRun {
  private readonly ctx: RunContext;
  private readonly r: ClaudeRunRequest;
  private readonly h: ClaudeRunHandlers;
  private readonly cfg: ClaudeRunnerConfig;
  private readonly log: Logger;
  private readonly startedMs: number;
  private proc: SupervisedProcess | null = null;

  private stopReason: StopReason | null = null;
  private violation: InitViolation | null = null;
  private handlerError: { error: unknown } | null = null;
  private readonly kills: Promise<KillResult>[] = [];
  private gracefulRequested = false;
  private forcedRequested = false;
  private readonly onStopDone: ((k: KillResult) => void)[] = [];
  private readonly completedKills: KillResult[] = [];

  private outputBytes = 0;
  private outputLimited = false;
  private readonly splitter: LineSplitter;
  private readonly stderrDecoder = new StringDecoder('utf8');
  private readonly stderrMasker: StreamMasker;
  private queue: SplitLine[] = [];
  private pump: Promise<void> = Promise.resolve();
  private lineNo = 0;

  private init: ClaudeInitEvent | null = null;
  private result: ClaudeResultEvent | null = null;
  private sessionId: string | null = null;
  private exited = false;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(ctx: RunContext, r: ClaudeRunRequest, h: ClaudeRunHandlers) {
    this.ctx = ctx;
    this.r = r;
    this.h = h;
    this.cfg = ctx.cfg;
    this.log = ctx.logger.child({
      component: 'claude-runner',
      attemptId: r.attemptId,
      taskId: r.taskId,
    });
    this.startedMs = ctx.clock.nowMs();
    this.splitter = new LineSplitter(this.cfg.maxLineBytes);
    this.stderrMasker = createStreamMasker(ctx.secrets);
  }

  private elapsed(): number {
    return Math.max(0, Math.round(this.ctx.clock.nowMs() - this.startedMs));
  }

  async execute(): Promise<ClaudeRunResult> {
    const r = this.r;
    if (r.signal.aborted) {
      return emptyResult(outcomeForStopReason(toAbortReason(r.signal.reason)), 0);
    }
    const args = [...this.cfg.binPrefixArgs, ...this.ctx.argv];
    assertSafeArgv([this.cfg.bin, ...args], { platform: this.cfg.platform });

    let proc: SupervisedProcess;
    try {
      proc = await this.ctx.launcher.spawn(r.lease, {
        kind: 'claude',
        cmd: this.cfg.bin,
        args,
        cwd: r.cwd,
        env: this.ctx.env,
      });
    } catch (e) {
      if (isSpawnFailure(e)) {
        this.log.error({ err: serializeError(e) }, 'claude spawn failed');
        return emptyResult('spawn_failed', this.elapsed());
      }
      throw e;
    }
    this.proc = proc;
    this.log.info({ pid: proc.pid, pgid: proc.pgid }, 'claude started');

    proc.stdin.on('error', () => undefined);
    proc.stdout.on('data', (c: Buffer | string) => this.onStdout(toBuffer(c)));
    proc.stderr.on('data', (c: Buffer | string) => this.onStderr(toBuffer(c)));
    const stdoutEnded = this.streamEnded(proc.stdout);
    const stderrEnded = this.streamEnded(proc.stderr);
    const exitP = proc.exited.then((x) => {
      this.exited = true;
      return x;
    });

    const onAbort = (): void => this.requestStop(toAbortReason(r.signal.reason));
    r.signal.addEventListener('abort', onAbort, { once: true });
    // An abort that arrived while spawn() was pending never fires the listener: honour it now.
    if (r.signal.aborted) onAbort();
    this.arm(Math.max(0, r.deadlineAt.getTime() - this.ctx.clock.nowMs()), () =>
      this.requestStop('timeout'),
    );
    this.arm(this.cfg.initTimeoutMs, () => {
      if (this.init === null && !this.exited) {
        this.log.warn({ initTimeoutMs: this.cfg.initTimeoutMs }, 'claude init event timed out');
        this.requestStop('init_timeout');
      }
    });

    try {
      await this.h.onSpawn({ pid: proc.pid, pgid: proc.pgid, startedAt: proc.startedAt });
    } catch (e) {
      this.handlerFailed(e);
    }
    if (this.stopReason === null && this.handlerError === null) {
      proc.stdin.end(r.stdinPrompt, 'utf8');
    } else {
      proc.stdin.end();
    }

    const exit = await this.waitExit(exitP);
    r.signal.removeEventListener('abort', onAbort);
    for (const t of this.timers) clearTimeout(t);

    await this.waitStreams(stdoutEnded, stderrEnded);
    this.enqueue(this.splitter.flush());
    const tail = this.stderrMasker.push(this.stderrDecoder.end()) + this.stderrMasker.flush();
    if (tail.length > 0 && !this.outputLimited) this.emitStderr(tail);
    await this.pump;

    const kill = await this.finalKill(proc);
    if (kill !== null && kill.survivors.length > 0) {
      this.log.error(
        { code: 'process_kill_failed', survivors: kill.survivors },
        'claude process tree survived the kill sequence',
      );
    }

    if (this.handlerError !== null) throw this.handlerError.error;

    const outcome = this.decideOutcome(exit.exitCode, exit.signal);
    const durationMs = this.elapsed();
    this.log.info(
      { outcome, exitCode: exit.exitCode, signal: exit.signal, outputBytes: this.outputBytes, durationMs },
      'claude exited',
    );
    return {
      outcome,
      exitCode: exit.exitCode,
      signal: exit.signal,
      sessionId: this.sessionId,
      init: this.init,
      result: this.result,
      violation: this.violation,
      outputBytes: this.outputBytes,
      durationMs,
      kill,
    };
  }

  private arm(ms: number, fn: () => void): void {
    const t = setTimeout(fn, Math.min(ms, MAX_TIMER_MS));
    this.timers.push(t);
  }

  private streamEnded(stream: NodeJS.ReadableStream): Promise<void> {
    return new Promise((resolve) => {
      stream.once('end', () => resolve());
      stream.once('close', () => resolve());
      stream.once('error', () => resolve());
    });
  }

  private async waitExit(
    exitP: Promise<{ exitCode: number | null; signal: string | null }>,
  ): Promise<{ exitCode: number | null; signal: string | null }> {
    return new Promise((resolve) => {
      void exitP.then(resolve);
      const check = (k: KillResult): void => {
        const pid = this.proc?.pid;
        if (!this.exited && pid !== undefined && k.survivors.includes(pid)) {
          setTimeout(() => resolve({ exitCode: null, signal: null }), EXIT_AFTER_FAILED_STOP_MS);
        }
      };
      for (const k of this.completedKills) check(k);
      this.onStopDone.push(check);
    });
  }

  private async waitStreams(...ended: Promise<void>[]): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), STREAM_END_AFTER_EXIT_MS);
    });
    const r = await Promise.race([Promise.all(ended).then(() => 'ended' as const), bound]);
    clearTimeout(timer);
    if (r === 'timeout' && this.proc !== null) {
      this.log.warn('claude stdio still open after exit; closing our ends');
      destroyStream(this.proc.stdout);
      destroyStream(this.proc.stderr);
    }
  }

  /** Requested stop results, or a cleanup pass over descendants left behind by a normal exit. */
  private async finalKill(proc: SupervisedProcess): Promise<KillResult | null> {
    if (this.kills.length > 0) return mergeKills(await Promise.all(this.kills));
    try {
      const sweep = await proc.stop({ graceMs: this.cfg.killGraceMs });
      if (sweep.forced || sweep.survivors.length > 0) {
        this.log.warn({ kill: sweep }, 'claude left descendant processes after exit; killed');
        return sweep;
      }
    } catch (e) {
      this.log.error({ err: serializeError(e) }, 'claude post-exit cleanup failed');
    }
    return null;
  }

  private requestStop(reason: StopReason): void {
    const force = reason === 'security_violation';
    if (this.stopReason === null || (force && this.stopReason !== 'security_violation')) {
      this.stopReason = reason;
    }
    this.stopProcess(force, reason);
  }

  private stopProcess(force: boolean, reason: string): void {
    const proc = this.proc;
    if (proc === null) return;
    if (force ? this.forcedRequested : this.gracefulRequested || this.forcedRequested) return;
    if (force) this.forcedRequested = true;
    else this.gracefulRequested = true;
    this.log.info({ reason, force }, 'stopping claude');
    const p = proc
      .stop(force ? { graceMs: 0, forceImmediately: true } : { graceMs: this.cfg.killGraceMs })
      .then(
        (k) => {
          this.completedKills.push(k);
          for (const cb of this.onStopDone) cb(k);
          return k;
        },
        (e: unknown) => {
          this.log.error({ err: serializeError(e) }, 'claude kill sequence failed');
          const pid = this.proc?.pid;
          const k: KillResult = {
            graceful: false,
            forced: true,
            survivors: pid !== undefined && !this.exited ? [pid] : [],
            durationMs: 0,
          };
          this.completedKills.push(k);
          for (const cb of this.onStopDone) cb(k);
          return k;
        },
      );
    this.kills.push(p);
  }

  private handlerFailed(e: unknown): void {
    if (this.handlerError !== null) return;
    this.handlerError = { error: e };
    this.log.error({ err: serializeError(e) }, 'claude run handler failed; stopping claude');
    this.stopProcess(true, 'handler_error');
  }

  private setViolation(v: InitViolation): void {
    if (this.violation === null) this.violation = v;
    this.log.warn({ rule: v.rule, detail: v.detail }, 'claude security violation');
    this.requestStop('security_violation');
  }

  private countOutput(bytes: number): boolean {
    this.outputBytes += bytes;
    if (this.outputLimited) return false;
    if (this.outputBytes > this.cfg.maxOutputBytes) {
      this.outputLimited = true;
      this.log.warn({ maxOutputBytes: this.cfg.maxOutputBytes }, 'claude output limit exceeded');
      this.requestStop('output_limit');
      return false;
    }
    return true;
  }

  private onStdout(chunk: Buffer): void {
    if (!this.countOutput(chunk.length)) return;
    this.enqueue(this.splitter.push(chunk));
  }

  private onStderr(chunk: Buffer): void {
    if (!this.countOutput(chunk.length)) return;
    const masked = this.stderrMasker.push(this.stderrDecoder.write(chunk));
    if (masked.length > 0) this.emitStderr(masked);
  }

  private emitStderr(text: string): void {
    try {
      this.h.onStderr(text);
    } catch (e) {
      this.handlerFailed(e);
    }
  }

  private enqueue(lines: SplitLine[]): void {
    if (lines.length === 0) return;
    this.queue.push(...lines);
    this.pump = this.pump.then(() => this.drain());
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const line = this.queue.shift() as SplitLine;
      const pending = this.processLine(line);
      if (pending !== undefined) await pending;
    }
  }

  private processLine(line: SplitLine): Promise<void> | undefined {
    if (this.handlerError !== null) return undefined;
    // Fail closed: once a security violation stopped the run, nothing the CLI prints afterwards is
    // trusted or forwarded (it is still counted against the output limit).
    if (this.violation !== null) return undefined;
    if (!line.truncated && line.text.trim().length === 0) return undefined;
    this.lineNo += 1;
    const masked = maskText(line.text, this.ctx.secrets);
    let parsed: ParsedClaudeLine;
    if (line.truncated) {
      this.log.warn(
        { lineNo: this.lineNo, maxLineBytes: this.cfg.maxLineBytes },
        'claude stream-json line exceeds the line limit; cut',
      );
      parsed = {
        kind: 'invalid',
        raw: masked,
        error: `line longer than ${this.cfg.maxLineBytes} bytes (cut)`,
      };
    } else {
      parsed = parseClaudeLine(masked);
    }
    try {
      this.h.onLine(parsed, masked, this.lineNo);
    } catch (e) {
      this.handlerFailed(e);
      return undefined;
    }
    switch (parsed.kind) {
      case 'init':
        return this.onInit(parsed.event);
      case 'hook':
        if (this.cfg.bare) {
          this.setViolation({
            rule: 'hook_event',
            detail: maskText(`hook event ${JSON.stringify(parsed.subtype)} with --bare`),
          });
        }
        return undefined;
      case 'result':
        this.result = parsed.event;
        if (this.sessionId === null && typeof parsed.event.session_id === 'string') {
          this.sessionId = parsed.event.session_id;
        }
        return undefined;
      default:
        return undefined;
    }
  }

  private async onInit(init: ClaudeInitEvent): Promise<void> {
    if (this.init === null) {
      this.init = init;
      this.sessionId ??= init.session_id;
    }
    const expectedSession =
      this.r.session.kind === 'new' ? this.r.session.sessionId : this.init.session_id;
    const v = validateInit(init, {
      permissionMode: CLAUDE_PERMISSION_MODE,
      cwd: this.r.cwd,
      sessionId: expectedSession,
      builtinTools: this.r.tools.builtinTools,
      extraTools: [...CLAUDE_INTERNAL_TOOL_NAMES, ...this.cfg.initExtraTools],
      mcpEnabled: this.r.mcp !== null,
      platform: this.cfg.platform,
    });
    if (!v.ok) {
      for (const violation of v.violations) this.setViolation(violation);
    } else if (this.r.mcp !== null && !v.mcpConnected) {
      this.log.warn('codebase-memory-mcp is not connected in the Claude session');
    }
    try {
      await this.h.onInit(init, v);
    } catch (e) {
      this.handlerFailed(e);
    }
  }

  private decideOutcome(exitCode: number | null, signal: string | null): ClaudeOutcome {
    if (this.violation !== null) return 'security_violation';
    if (this.stopReason !== null) return outcomeForStopReason(this.stopReason);
    if (this.init === null) {
      if (this.r.session.kind === 'resume') return 'resume_failed';
      return exitCode === 0 && signal === null ? 'protocol_error' : 'exit_nonzero';
    }
    const result = this.result;
    if (result !== null) {
      if (result.subtype.includes('budget')) return 'budget_exceeded';
      if (result.is_error || result.subtype !== 'success') return 'result_error';
      return exitCode === 0 && signal === null ? 'success' : 'exit_nonzero';
    }
    return exitCode === 0 && signal === null ? 'protocol_error' : 'exit_nonzero';
  }
}

export function runClaude(
  ctx: RunContext,
  r: ClaudeRunRequest,
  h: ClaudeRunHandlers,
): Promise<ClaudeRunResult> {
  return new ClaudeRun(ctx, r, h).execute();
}
