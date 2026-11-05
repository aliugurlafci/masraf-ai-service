// Deliberate leaks for tests/integration/leak-detection.test.ts (B-005): an orc-test- temp dir holding a git repo
// with a linked worktree on an orc/task-* branch, hanging fake-claude processes (a child of this process and an
// orphan whose parent already exited) and decoy directories the leak guard must never select. Everything created
// here is tracked and removed by cleanup(), so the run-level leak guard never sees these artefacts.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SKIP_EXITED,
  SKIP_REPLACED,
  createLedgerContext,
  describeFakeClaude,
  killVerifiedProcesses,
} from '../../setup/leak-ledger';
import type { LedgerContext, ProcessNote } from '../../setup/leak-ledger';
import { createSourceRepo, gitT } from '../git/fixtures';
import { waitForProcessExit } from './process';
import { REMOVE_OPTIONS, TEMP_DIR_PREFIX } from './temp-dir';

export const FAKE_CLAUDE_SCRIPT = fileURLToPath(
  new URL('../../fixtures/fake-claude/fake-claude.mjs', import.meta.url),
);
export const LEAK_BRANCH = 'orc/task-leak-a1';
const RUN_ID_ENV = 'ORC_TEST_RUN_ID';
const HANG_PROMPT = '@@fake hang\n';
const EXIT_WAIT_MS = 10_000;

/**
 * Starts fake-claude detached, prints its PID and exits, so the fake-claude outlives its parent (an orphan).
 * Arguments: <fake-claude.mjs> <ORC_TEST_RUN_ID value>.
 */
const ORPHAN_LAUNCHER = [
  "const { spawn } = require('node:child_process');",
  'const [script, marker] = process.argv.slice(1);',
  "const child = spawn(process.execPath, [script, '-p'], { detached: true, shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, ORC_TEST_RUN_ID: marker } });",
  "child.stdin.end('@@fake hang\\n', () => { process.stdout.write(String(child.pid)); child.unref(); });",
].join('\n');

export interface LeakedRepo {
  /** The orc-test-leak-* directory (canonical path). */
  readonly dir: string;
  readonly repo: string;
  readonly worktree: string;
  readonly branch: string;
}

/** Minimal environment for fake-claude and the orphan launcher (no inherited runner variables). */
function childEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP'] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export class LeakFixtures {
  readonly #dirs = new Set<string>();
  readonly #links = new Set<string>();
  readonly #children = new Set<ChildProcess>();
  /** Orphans by PID with the identity (start time) recorded right after they started. */
  readonly #orphans = new Map<number, ProcessNote>();
  #ledger: LedgerContext | undefined;

  async #context(): Promise<LedgerContext> {
    this.#ledger ??= await createLedgerContext({ runId: randomUUID(), rootPid: process.pid });
    return this.#ledger;
  }

  /** `realpath(os.tmpdir())/<prefix>XXXXXX`, tracked for cleanup. */
  async makeDir(prefix: string): Promise<string> {
    const created = await mkdtemp(path.join(await realpath(tmpdir()), prefix));
    const real = await realpath(created);
    this.#dirs.add(real);
    return real;
  }

  /** An orc-test-leak-* dir with repo/ (branch main) and wt/ (linked worktree on orc/task-leak-a1). */
  async makeLeakedRepo(): Promise<LeakedRepo> {
    const dir = await this.makeDir(`${TEMP_DIR_PREFIX}leak-`);
    const home = path.join(dir, 'home');
    await mkdir(home);
    const repo = path.join(dir, 'repo');
    createSourceRepo(repo, { 'README.md': 'leak detection\n' }, home);
    const worktree = path.join(dir, 'wt');
    gitT(repo, ['worktree', 'add', '--quiet', '-b', LEAK_BRANCH, worktree], { home });
    return { dir, repo, worktree, branch: LEAK_BRANCH };
  }

  /** A directory link `realpath(os.tmpdir())/<prefix><uuid>` -> target (a junction on Windows: no privilege). */
  async makeDirLink(prefix: string, target: string): Promise<string> {
    const link = path.join(await realpath(tmpdir()), `${prefix}${randomUUID()}`);
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    this.#links.add(link);
    return link;
  }

  /** A hanging fake-claude started by THIS process, carrying `ORC_TEST_RUN_ID=<marker>`. */
  spawnFakeClaude(marker: string): number {
    const child = spawn(process.execPath, [FAKE_CLAUDE_SCRIPT, '-p'], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: childEnv({ [RUN_ID_ENV]: marker }),
    });
    child.on('error', () => undefined);
    child.stdin?.on('error', () => undefined);
    if (child.pid === undefined) throw new Error('fake-claude did not start');
    this.#children.add(child);
    child.stdin?.end(HANG_PROMPT);
    return child.pid;
  }

  /** A hanging fake-claude whose parent (a short-lived launcher) has already exited. */
  async spawnOrphanFakeClaude(marker: string): Promise<number> {
    const launcher = spawn(
      process.execPath,
      ['-e', ORPHAN_LAUNCHER, '--', FAKE_CLAUDE_SCRIPT, marker],
      {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(),
      },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    launcher.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    launcher.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      launcher.on('error', reject);
      launcher.on('close', resolve);
    });
    const text = Buffer.concat(out).toString('utf8').trim();
    if (code !== 0 || !/^\d+$/.test(text)) {
      throw new Error(
        `orphan launcher failed (${String(code)}): ${Buffer.concat(err).toString('utf8')}`,
      );
    }
    const pid = Number(text);
    // The orphan hangs, so right now the PID is still its own: record its start time as its identity.
    const identity = await describeFakeClaude(await this.#context(), pid);
    if (identity === null)
      throw new Error(`orphan fake-claude ${pid} is not visible in the process table`);
    this.#orphans.set(pid, identity);
    return pid;
  }

  /** Kills every process, then removes every link and directory created here. Idempotent. */
  async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    for (const child of this.#children) {
      if (!exited(child)) child.kill('SIGKILL');
      if (child.pid !== undefined) {
        await waitForProcessExit(child.pid, { timeoutMs: EXIT_WAIT_MS }).catch((e: unknown) =>
          errors.push(e),
        );
      }
    }
    this.#children.clear();
    if (this.#orphans.size > 0) {
      // No handle: kill only a process that a fresh scan shows with the recorded PID AND start time AND the
      // fake-claude path (killVerifiedProcesses), so a reused PID is never hit.
      const outcome = await killVerifiedProcesses(await this.#context(), [
        ...this.#orphans.values(),
      ]);
      for (const pid of [...this.#orphans.keys()]) {
        const skip = outcome.skipped.find((s) => s.item === `pid ${pid}`);
        // Killed, exited on its own or its PID now belongs to another process: nothing of ours is left.
        if (skip === undefined || skip.reason === SKIP_EXITED || skip.reason === SKIP_REPLACED) {
          this.#orphans.delete(pid);
        } else {
          errors.push(new Error(`orphan fake-claude pid ${pid}: ${skip.reason}`));
        }
      }
    }
    for (const link of this.#links) {
      await unlink(link).then(
        () => this.#links.delete(link),
        (e: unknown) => {
          if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT')
            this.#links.delete(link);
          else errors.push(e);
        },
      );
    }
    for (const dir of this.#dirs) {
      await rm(dir, REMOVE_OPTIONS).then(
        () => this.#dirs.delete(dir),
        (e: unknown) => errors.push(e),
      );
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'leak fixtures were not fully cleaned up');
  }
}
