// Shared helpers for mcp-manager tests: silent logger, in-memory recorder, temp roots, fake-cbm switch.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { cryptoIdGenerator } from '@orc/shared';
import type { Uuid } from '@orc/shared';
import { createLogger } from '@orc/logger';
import type { Logger } from '@orc/logger';
import type { McpOperationRecorder, OperationOutcome } from '@orc/mcp-manager';

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_CBM_PATH = resolve(here, '..', '..', 'fixtures', 'fake-mcp', 'fake-cbm.mjs');

export function createTestLogger(level: 'silent' | 'debug' = 'silent'): { logger: Logger; lines: () => string[] } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  const logger = createLogger({ service: 'test', level, version: 'test', env: 'test', destination });
  return { logger, lines: () => chunks.join('').split('\n').filter((l) => l.length > 0) };
}

export type RecorderStart = Parameters<McpOperationRecorder['start']>[0];

export interface MemoryRecorder extends McpOperationRecorder {
  readonly started: (RecorderStart & { id: Uuid })[];
  readonly finished: { id: Uuid; outcome: OperationOutcome }[];
}

export function createMemoryRecorder(): MemoryRecorder {
  const started: (RecorderStart & { id: Uuid })[] = [];
  const finished: { id: Uuid; outcome: OperationOutcome }[] = [];
  return {
    started,
    finished,
    start(o) {
      const id = o.existingOperationId ?? cryptoIdGenerator.uuid();
      started.push({ ...o, id });
      return Promise.resolve(id);
    },
    finish(id, outcome) {
      finished.push({ id, outcome });
      return Promise.resolve();
    },
  };
}

export interface TempRoot {
  root: string;
  workspaces: string;
  cache: string;
  cleanup(): Promise<void>;
}

export async function createTempRoot(): Promise<TempRoot> {
  const root = await mkdtemp(join(tmpdir(), 'orc-test-'));
  const workspaces = join(root, 'workspaces');
  const cache = join(root, 'cbm-cache');
  await mkdir(workspaces, { recursive: true });
  await mkdir(cache, { recursive: true });
  return {
    root,
    workspaces,
    cache,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }),
  };
}

export type FakeCbmSwitch = {
  mode?: string;
  omitParams?: Record<string, string[]>;
  structured?: boolean;
};

export async function writeFakeSwitch(dir: string, sw: FakeCbmSwitch): Promise<void> {
  await writeFile(join(dir, '.fake-cbm.json'), JSON.stringify(sw));
}

export interface FakeCall {
  tool: string;
  args: Record<string, unknown>;
}

export async function readFakeCalls(cacheDir: string): Promise<FakeCall[]> {
  const file = join(cacheDir, 'fake-cbm-calls.jsonl');
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as FakeCall);
}

/** Real codebase-memory-mcp binary: CODEBASE_MEMORY_MCP_BIN, else PATH lookup. Null when absent. */
export function resolveRealCbmBinary(): string | null {
  const override = process.env['CODEBASE_MEMORY_MCP_BIN'];
  if (override !== undefined && override.length > 0) {
    return existsSync(override) && statSync(override).isFile() ? override : null;
  }
  const names =
    process.platform === 'win32'
      ? ['codebase-memory-mcp.exe']
      : ['codebase-memory-mcp'];
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
