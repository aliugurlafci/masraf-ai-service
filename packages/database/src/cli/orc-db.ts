#!/usr/bin/env node
// `orc-db` entry point (bundled to packages/database/dist/orc-db.js). See ./run.ts for the commands.
import { runOrcDb } from './run.js';

const exitCode = await runOrcDb(process.argv.slice(2), {
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exitCode = exitCode;
