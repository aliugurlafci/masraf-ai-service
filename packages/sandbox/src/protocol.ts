// Runner wire protocol v1 (contract §10.11 item 5): NDJSON over a Unix socket, one connection per
// request, every frame Zod-validated (`v: 1`, <= 1 MiB). Unknown types or fields fail validation,
// and the receiving side closes the connection.
import { ERROR_CODES, GUID_REGEX } from '@orc/shared';
import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
/** Maximum size of one frame (the JSON line without its trailing newline). */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Raw bytes carried by one stdin/stdout/stderr frame (base64 => ~342 KiB per frame). */
export const MAX_CHUNK_BYTES = 256 * 1024;
export const LAUNCH_KINDS = ['claude', 'test', 'mcp'] as const;
export const MAX_LEASE_PATHS = 16;
export const MAX_ARGV_ELEMENTS = 4096;
export const MAX_ENV_KEYS = 256;
export const MAX_PATH_LENGTH = 4096;
export const MAX_MEASURE_ENTRIES = 50_000_000;
export const MAX_STOP_GRACE_MS = 600_000;
/** Decoded size limit of the `spawn` frame's `credentialFd {b64}` (contract §10.11 item 5, ADR-0036 m.4). */
export const MAX_CREDENTIAL_FD_BYTES = 4096;

export const WORKER_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
/**
 * `attempt-<attemptId>` or `op-<operationId>` (lower-case GUIDs), or a start-up probe lease of one
 * worker: `op-probe-<workerId>` (Claude CLI probe, §10.9) / `op-mcp-probe-<workerId>` (MCP probe,
 * §12.1); `<workerId>` matches {@link WORKER_ID_REGEX}.
 */
export const LEASE_KEY_REGEX =
  /^(?:(?:attempt|op)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|op-(?:mcp-)?probe-[A-Za-z0-9._-]{1,128})$/;
export const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ERROR_REASON_REGEX = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_B64_LENGTH = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;
const MAX_CREDENTIAL_B64_LENGTH = Math.ceil(MAX_CREDENTIAL_FD_BYTES / 3) * 4;

/** Decoded byte length of a padded base64 string (`z.base64()` requires padding). */
export function base64DecodedLength(s: string): number {
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

const v = z.literal(PROTOCOL_VERSION);
const guid = z.string().regex(GUID_REGEX, 'Expected a lower-case GUID');
const noNul = (s: string): boolean => !s.includes('\0');
const pathString = z.string().min(1).max(MAX_PATH_LENGTH).refine(noNul, 'NUL byte');
const nonNegInt = z.int().min(0);
const posInt = z.int().min(1);
const b64 = z.base64().max(MAX_B64_LENGTH);
const iso = z.iso.datetime();

export const KillResultSchema = z.strictObject({
  graceful: z.boolean(),
  forced: z.boolean(),
  survivors: z.array(posInt).max(65_536),
  durationMs: nonNegInt,
});

export const LeaseInfoSchema = z.strictObject({
  id: guid,
  key: z.string().regex(LEASE_KEY_REGEX),
  attemptId: guid.nullable(),
  workerId: z.string().regex(WORKER_ID_REGEX),
  uid: nonNegInt.nullable(),
  pids: z.array(posInt).max(65_536),
  expiresAt: iso,
});

export const LaunchLimitsSchema = z.strictObject({
  nproc: posInt.optional(),
  nofile: posInt.optional(),
  fsizeBytes: posInt.optional(),
});

/** Runner self-check reported by `hello`; the worker refuses to start unless `ok`. */
export const RunnerCapsSchema = z.strictObject({
  ok: z.boolean(),
  /** CAP_SETUID + CAP_SETGID: children run under the lease uid. */
  uidSwitch: z.boolean(),
  /** CAP_CHOWN + CAP_FOWNER (+ CAP_DAC_READ_SEARCH): lease handoff and reclaim. */
  chown: z.boolean(),
  /** CAP_KILL: uid-wide kill on release. */
  kill: z.boolean(),
  /** util-linux `prlimit` is available. */
  prlimit: z.boolean(),
  /** `/proc` is readable (process scan by uid). */
  procfs: z.boolean(),
});

const envRecord = z
  .record(z.string().regex(ENV_KEY_REGEX), z.string().refine(noNul, 'NUL byte'))
  .refine((r) => Object.keys(r).length <= MAX_ENV_KEYS, 'Too many environment variables');

// ---- client -> server: request frames (first frame of a connection) ---------------------------

export const HelloRequestSchema = z.strictObject({ v, type: z.literal('hello') });
export const LeaseAcquireRequestSchema = z.strictObject({
  v,
  type: z.literal('lease_acquire'),
  key: z.string().regex(LEASE_KEY_REGEX),
  attemptId: guid.nullable(),
  workerId: z.string().regex(WORKER_ID_REGEX),
  paths: z.array(pathString).min(1).max(MAX_LEASE_PATHS),
});
export const LeaseRenewRequestSchema = z.strictObject({
  v,
  type: z.literal('lease_renew'),
  leaseId: guid,
});
export const LeaseReleaseRequestSchema = z.strictObject({
  v,
  type: z.literal('lease_release'),
  leaseId: guid,
});
export const LeaseMeasureRequestSchema = z.strictObject({
  v,
  type: z.literal('lease_measure'),
  leaseId: guid,
  path: pathString,
  maxEntries: posInt.max(MAX_MEASURE_ENTRIES),
});
export const LeaseListRequestSchema = z.strictObject({ v, type: z.literal('lease_list') });
/**
 * Credential for fd 3 (ADR-0036 m.4): 1..{@link MAX_CREDENTIAL_FD_BYTES} decoded bytes. The runner
 * accepts it only for kind `claude` with `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3` in the env
 * (`validateSpawnCredential`); it is never logged and never echoed in an error.
 */
export const CredentialFdSchema = z.strictObject({
  b64: z
    .base64()
    .min(4)
    .max(MAX_CREDENTIAL_B64_LENGTH)
    .refine((s) => base64DecodedLength(s) <= MAX_CREDENTIAL_FD_BYTES, 'Credential too large'),
});
export const SpawnRequestSchema = z.strictObject({
  v,
  type: z.literal('spawn'),
  leaseId: guid,
  kind: z.enum(LAUNCH_KINDS),
  argv: z.array(z.string()).min(1).max(MAX_ARGV_ELEMENTS),
  cwd: pathString,
  env: envRecord,
  limits: LaunchLimitsSchema,
  credentialFd: CredentialFdSchema.optional(),
});

export const RequestFrameSchema = z.discriminatedUnion('type', [
  HelloRequestSchema,
  LeaseAcquireRequestSchema,
  LeaseRenewRequestSchema,
  LeaseReleaseRequestSchema,
  LeaseMeasureRequestSchema,
  LeaseListRequestSchema,
  SpawnRequestSchema,
]);
export type RequestFrame = z.infer<typeof RequestFrameSchema>;
export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;
export type CredentialFdFrame = z.infer<typeof CredentialFdSchema>;
export type LeaseAcquireRequest = z.infer<typeof LeaseAcquireRequestSchema>;

// ---- client -> server: frames of a spawn session (after `spawned`) -----------------------------

export const StdinFrameSchema = z.strictObject({ v, type: z.literal('stdin'), b64 });
export const StdinEndFrameSchema = z.strictObject({ v, type: z.literal('stdin_end') });
export const StopFrameSchema = z.strictObject({
  v,
  type: z.literal('stop'),
  graceMs: nonNegInt.max(MAX_STOP_GRACE_MS),
  force: z.boolean(),
});
export const SessionFrameSchema = z.discriminatedUnion('type', [
  StdinFrameSchema,
  StdinEndFrameSchema,
  StopFrameSchema,
]);
export type SessionFrame = z.infer<typeof SessionFrameSchema>;

/** Every frame a client may send (requests and session frames). */
export const ClientFrameSchema = z.discriminatedUnion('type', [
  HelloRequestSchema,
  LeaseAcquireRequestSchema,
  LeaseRenewRequestSchema,
  LeaseReleaseRequestSchema,
  LeaseMeasureRequestSchema,
  LeaseListRequestSchema,
  SpawnRequestSchema,
  StdinFrameSchema,
  StdinEndFrameSchema,
  StopFrameSchema,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// ---- server -> client ----------------------------------------------------------------------------

export const HelloResultFrameSchema = z.strictObject({
  v,
  type: z.literal('hello_ok'),
  protocol: z.literal(PROTOCOL_VERSION),
  uidBase: nonNegInt,
  maxLeases: posInt,
  leaseTtlMs: posInt,
  caps: RunnerCapsSchema,
});
export const LeaseAcquiredFrameSchema = z.strictObject({
  v,
  type: z.literal('lease_acquired'),
  lease: LeaseInfoSchema,
});
export const LeaseRenewedFrameSchema = z.strictObject({
  v,
  type: z.literal('lease_renewed'),
  expiresAt: iso,
});
export const LeaseReleasedFrameSchema = z.strictObject({
  v,
  type: z.literal('lease_released'),
  kill: KillResultSchema,
  reclaimed: z.boolean(),
});
export const LeaseMeasuredFrameSchema = z.strictObject({
  v,
  type: z.literal('lease_measured'),
  bytes: nonNegInt,
  entries: nonNegInt,
  truncated: z.boolean(),
});
export const LeaseListedFrameSchema = z.strictObject({
  v,
  type: z.literal('lease_listed'),
  leases: z.array(LeaseInfoSchema).max(4096),
});
export const SpawnedFrameSchema = z.strictObject({
  v,
  type: z.literal('spawned'),
  pid: posInt,
  pgid: posInt.nullable(),
  uid: nonNegInt.nullable(),
  startedAt: iso,
});
export const StdoutFrameSchema = z.strictObject({ v, type: z.literal('stdout'), b64 });
export const StderrFrameSchema = z.strictObject({ v, type: z.literal('stderr'), b64 });
export const ExitFrameSchema = z.strictObject({
  v,
  type: z.literal('exit'),
  exitCode: z.int().nullable(),
  signal: z
    .string()
    .regex(/^[A-Z0-9]{1,32}$/)
    .nullable(),
});
export const StoppedFrameSchema = z.strictObject({
  v,
  type: z.literal('stopped'),
  ...KillResultSchema.shape,
});
export const ErrorFrameSchema = z.strictObject({
  v,
  type: z.literal('error'),
  code: z.enum(ERROR_CODES),
  message: z.string().max(1024),
  reason: z.string().regex(ERROR_REASON_REGEX).optional(),
});

export const ServerFrameSchema = z.discriminatedUnion('type', [
  HelloResultFrameSchema,
  LeaseAcquiredFrameSchema,
  LeaseRenewedFrameSchema,
  LeaseReleasedFrameSchema,
  LeaseMeasuredFrameSchema,
  LeaseListedFrameSchema,
  SpawnedFrameSchema,
  StdoutFrameSchema,
  StderrFrameSchema,
  ExitFrameSchema,
  StoppedFrameSchema,
  ErrorFrameSchema,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
export type ErrorFrame = z.infer<typeof ErrorFrameSchema>;
export type RunnerCaps = z.infer<typeof RunnerCapsSchema>;

/** `hello` result (contract §10.11 item 5). */
export interface RunnerHello {
  protocol: typeof PROTOCOL_VERSION;
  uidBase: number;
  maxLeases: number;
  leaseTtlMs: number;
  caps: RunnerCaps;
}

/**
 * Worker start-up check of a `hello` result (contract §14.2): protocol 1, lease TTL not above the
 * worker's self-fence window and a successful runner caps self-check. Returns the problems found.
 */
export function checkRunnerHello(hello: RunnerHello, selfFenceAfterMs: number): string[] {
  const problems: string[] = [];
  if (hello.protocol !== PROTOCOL_VERSION) problems.push(`protocol ${String(hello.protocol)} != 1`);
  if (hello.leaseTtlMs > selfFenceAfterMs) {
    problems.push(`leaseTtlMs ${hello.leaseTtlMs} > selfFenceAfterMs ${selfFenceAfterMs}`);
  }
  if (!hello.caps.ok) {
    const missing = (['uidSwitch', 'chown', 'kill', 'prlimit', 'procfs'] as const).filter(
      (k) => !hello.caps[k],
    );
    problems.push(`runner caps self-check failed (${missing.join(', ') || 'unknown'})`);
  }
  return problems;
}
