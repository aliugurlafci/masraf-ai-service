// Orphan fixture test command (contract §18.5 "Cancel/Timeout leaves no orphan", testing stage): starts a long
// lived grandchild (detached on POSIX, so it leaves the process group), announces both PIDs on stdout and then
// keeps running far longer than any test deadline. Nothing here ever finishes on its own.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {
  stdio: 'ignore',
  detached: process.platform !== 'win32',
  windowsHide: true,
});
grandchild.on('error', () => undefined);
grandchild.unref();

writeFileSync(
  'orphan-pids.json',
  JSON.stringify({ test: process.pid, grandchild: grandchild.pid ?? null }),
);
console.log(`ORC_ORPHAN_TEST_PID=${process.pid}`);
console.log(`ORC_ORPHAN_GRANDCHILD_PID=${grandchild.pid ?? 0}`);

setInterval(() => undefined, 1_000_000);
