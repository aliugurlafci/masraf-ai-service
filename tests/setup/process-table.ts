// Host process table for the test leak guard (B-005, contract §18.2 "Processes").
// - Windows: ONE fixed PowerShell/CIM query, spawned as
//   spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SCAN_SCRIPT], { shell: false });
//   nothing from outside is ever added to the command text. Output is pure ASCII JSON (non-ASCII is \u-escaped).
// - Linux: /proc/<pid>/{stat,cmdline} (environ only on request, see readRunMarker).
// A failed or implausible scan is returned as { ok: false } and is NEVER treated as an empty (clean) table: the
// table must contain the scanning process itself with its real parent PID.
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Start-time key of a process. 'epoch-us' (win32): microseconds since 1970-01-01 UTC, comparable with Date.now().
 * 'boot-ticks' (linux): clock ticks since boot, only comparable with other entries of the same host.
 */
export type StartClock = 'epoch-us' | 'boot-ticks';

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  /** Start key in the table's clock; null when the OS does not report it (never trusted for a parent link). */
  readonly start: bigint | null;
  /** win32: the raw CommandLine; linux: argv joined with single spaces. Empty when unreadable. */
  readonly commandLine: string;
  /** linux: the exact argv; win32: null (Windows has no argv, only a command line string). */
  readonly argv: readonly string[] | null;
  /** linux zombie/dead state ('Z'/'X'): the PID is still held but the process no longer runs. */
  readonly defunct: boolean;
}

export type ProcessScan =
  | { readonly ok: true; readonly clock: StartClock; readonly processes: readonly ProcessEntry[] }
  | { readonly ok: false; readonly reason: string };

/** .NET DateTime ticks (100 ns since 0001-01-01) of 1970-01-01T00:00:00Z. */
const DOTNET_EPOCH_TICKS = 621_355_968_000_000_000n;
const SCAN_TIMEOUT_MS = 60_000;
const MAX_SCAN_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PROCESSES = 200_000;

/**
 * The only PowerShell text the leak guard ever runs (condition: constant, no interpolation, single quotes only so
 * the Windows command-line quoting of spawn() cannot alter it).
 */
export const WINDOWS_PROCESS_SCAN_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'; try { $rows = @(foreach ($p in Get-CimInstance -ClassName Win32_Process) { $c = $null; if ($null -ne $p.CreationDate) { $c = [string]$p.CreationDate.ToUniversalTime().Ticks }; [pscustomobject]@{ pid = [int64]$p.ProcessId; ppid = [int64]$p.ParentProcessId; created = $c; cmd = [string]$p.CommandLine } }); $json = ConvertTo-Json -InputObject $rows -Compress -Depth 2; [Console]::Out.Write([regex]::Replace($json, '[^\x00-\x7F]', { param($m) ('\u{0:x4}' -f [int][char]$m.Value) })); exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }`;

export const POWERSHELL_ARGS: readonly string[] = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  WINDOWS_PROCESS_SCAN_SCRIPT,
];

/** Variables PowerShell/CIM needs; everything else of the test runner's environment stays out of the child. */
const POWERSHELL_ENV_KEYS = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'Path',
  'PATHEXT',
  'ComSpec',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'ProgramData',
  'ProgramFiles',
  'CommonProgramFiles',
  'PSModulePath',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
] as const;

const WindowsRowSchema = z.object({
  pid: z.number().int().nonnegative(),
  ppid: z.number().int().nonnegative(),
  created: z
    .string()
    .regex(/^\d{1,20}$/)
    .nullable(),
  cmd: z.string().nullable(),
});
const WindowsRowsSchema = z.array(WindowsRowSchema).max(MAX_PROCESSES);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errnoCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** .NET UTC ticks -> microseconds since the Unix epoch. */
export function windowsTicksToEpochUs(ticks: bigint): bigint {
  return (ticks - DOTNET_EPOCH_TICKS) / 10n;
}

/** Parses (and validates) the JSON printed by WINDOWS_PROCESS_SCAN_SCRIPT. Throws on any schema violation. */
export function parseWindowsProcessJson(text: string): ProcessEntry[] {
  const rows = WindowsRowsSchema.parse(JSON.parse(text) as unknown);
  return rows.map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    start: row.created === null ? null : windowsTicksToEpochUs(BigInt(row.created)),
    commandLine: row.cmd ?? '',
    argv: null,
    defunct: false,
  }));
}

export interface ProcStat {
  readonly ppid: number;
  readonly state: string;
  readonly startTicks: bigint;
}

/** Parses /proc/<pid>/stat ("<pid> (<comm>) <state> <ppid> ... <starttime> ..."); comm may contain ") ". */
export function parseProcStat(text: string): ProcStat | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // fields[0] = state (field 3), fields[1] = ppid (field 4), fields[19] = starttime (field 22).
  const state = fields[0];
  const ppid = fields[1];
  const start = fields[19];
  if (state === undefined || ppid === undefined || start === undefined) return null;
  if (!/^\d+$/.test(ppid) || !/^\d+$/.test(start)) return null;
  return { state, ppid: Number(ppid), startTicks: BigInt(start) };
}

/** The scan must contain the scanning process with its real parent; otherwise it is not a usable table. */
function plausible(processes: readonly ProcessEntry[]): string | null {
  const self = processes.find((p) => p.pid === process.pid);
  if (!self) return `scan does not contain the scanning process ${process.pid}`;
  if (self.ppid !== process.ppid) {
    return `scan reports parent ${self.ppid} for process ${process.pid}, expected ${process.ppid}`;
  }
  return null;
}

function powershellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of POWERSHELL_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function scanWindows(): Promise<ProcessScan> {
  const output = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    error: string | null;
  }>((resolve) => {
    const child = spawn('powershell.exe', [...POWERSHELL_ARGS], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: powershellEnv(),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let failure: string | null = null;
    const timer = setTimeout(() => {
      failure = `PowerShell process scan timed out after ${SCAN_TIMEOUT_MS} ms`;
      child.kill();
    }, SCAN_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_SCAN_OUTPUT_BYTES) {
        failure = 'PowerShell process scan output exceeded the size limit';
        child.kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < 64) err.push(chunk);
    });
    child.on('error', (error) => {
      failure = `PowerShell could not be started: ${error.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8').trim().slice(0, 500),
        error: failure,
      });
    });
  });
  if (output.error !== null) return { ok: false, reason: output.error };
  if (output.code !== 0) {
    return {
      ok: false,
      reason: `PowerShell process scan exited with ${String(output.code)}: ${output.stderr}`,
    };
  }
  let processes: ProcessEntry[];
  try {
    processes = parseWindowsProcessJson(output.stdout);
  } catch (error) {
    return { ok: false, reason: `PowerShell process scan output is invalid: ${errorText(error)}` };
  }
  const problem = plausible(processes);
  return problem === null
    ? { ok: true, clock: 'epoch-us', processes }
    : { ok: false, reason: problem };
}

async function readProcEntry(pid: number): Promise<ProcessEntry | null> {
  let stat: ProcStat | null;
  let cmdline: string;
  try {
    stat = parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
    cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
  } catch (error) {
    const code = errnoCode(error);
    // The process exited (or is not ours to read) between readdir and read: not part of the table.
    if (code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES' || code === 'EPERM') return null;
    throw error;
  }
  if (stat === null) return null;
  const argv = cmdline.split('\0');
  if (argv.at(-1) === '') argv.pop();
  return {
    pid,
    ppid: stat.ppid,
    start: stat.startTicks,
    commandLine: argv.join(' '),
    argv,
    defunct: stat.state === 'Z' || stat.state === 'X',
  };
}

async function scanLinux(): Promise<ProcessScan> {
  let names: string[];
  try {
    names = await readdir('/proc');
  } catch (error) {
    return { ok: false, reason: `/proc is not readable: ${errorText(error)}` };
  }
  const processes: ProcessEntry[] = [];
  try {
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const entry = await readProcEntry(Number(name));
      if (entry) processes.push(entry);
      if (processes.length > MAX_PROCESSES) return { ok: false, reason: 'too many processes' };
    }
  } catch (error) {
    return { ok: false, reason: `/proc scan failed: ${errorText(error)}` };
  }
  const problem = plausible(processes);
  return problem === null
    ? { ok: true, clock: 'boot-ticks', processes }
    : { ok: false, reason: problem };
}

/** Snapshot of every process on the host (Windows: CIM; Linux: /proc). Never throws. */
export async function scanProcessTable(
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessScan> {
  try {
    if (platform === 'win32') return await scanWindows();
    if (platform === 'linux') return await scanLinux();
    return { ok: false, reason: `process scan is not supported on ${platform}` };
  } catch (error) {
    return { ok: false, reason: `process scan failed: ${errorText(error)}` };
  }
}

/**
 * Linux only: whether /proc/<pid>/environ carries exactly `<name>=<value>`. null when it cannot be read (other
 * uid, exited) or on other platforms (Windows cannot read another process' environment through CIM).
 */
export async function readEnvMarker(
  pid: number,
  name: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean | null> {
  if (platform !== 'linux') return null;
  try {
    const environ = await readFile(`/proc/${pid}/environ`, 'utf8');
    return environ.split('\0').includes(`${name}=${value}`);
  } catch {
    return null;
  }
}
