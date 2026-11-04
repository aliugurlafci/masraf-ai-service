#!/usr/bin/env node
// Runs the opt-in claude-live Vitest project against the real Claude Code CLI.
// Sets CLAUDE_LIVE=1 cross-platform; extra CLI arguments are forwarded to Vitest.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = join(rootDir, 'node_modules', 'vitest', 'vitest.mjs');

const child = spawn(
  process.execPath,
  [vitestBin, 'run', '--project', 'claude-live', ...process.argv.slice(2)],
  {
    cwd: rootDir,
    env: { ...process.env, CLAUDE_LIVE: '1' },
    stdio: 'inherit',
    shell: false,
  },
);

child.on('error', (error) => {
  console.error(`Failed to start Vitest: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Vitest terminated by signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
