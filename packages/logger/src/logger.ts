import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { pino, stdTimeFunctions } from 'pino';
import type {
  Bindings,
  ChildLoggerOptions,
  DestinationStream,
  LevelWithSilent,
  Logger as PinoLogger,
  LoggerOptions as PinoLoggerOptions,
} from 'pino';
import type { NodeEnv } from '@orc/shared';
import { REDACT_KEYS, maskText } from '@orc/security';
import type { SecretRegistry } from '@orc/security';
import { getLogContext } from './context.js';
import { serializeErrorWith } from './serialize-error.js';

export type Logger = PinoLogger;
export type LogLevel = LevelWithSilent;

export interface LoggerOptions {
  service: 'api' | 'worker' | 'egress-proxy' | 'db-cli' | 'runner' | 'test';
  level: LogLevel;
  /** Honoured only when `env === 'development'`, no `destination` is given and pino-pretty is installed. */
  pretty?: boolean;
  version: string;
  env: NodeEnv;
  /** Tests capture output here; defaults to stdout. */
  destination?: NodeJS.WritableStream;
  /** Registered secret values are masked in `msg`, string fields and serialized errors. */
  secrets?: SecretRegistry;
}

/** §17.2 pino redact paths (censor `[REDACTED]`). */
export const REDACT_PATHS: readonly string[] = Object.freeze([
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.tokenHash',
  '*.csrfToken',
  '*.secret',
  '*.apiKey',
  '*.anthropicApiKey',
  '*.connectionString',
  'config.db.password',
  'config.redis.password',
  'config.anthropicApiKey',
]);

const CENSOR = '[REDACTED]';
const MAX_MASK_DEPTH = 16;
const REDACT_KEY_SET: ReadonlySet<string> = new Set(REDACT_KEYS);
const REDACT_KEY_SUFFIXES = ['password', '_secret', '_token'] as const;

function isRedactKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_KEY_SET.has(lower) || REDACT_KEY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Masks a log payload without touching objects pino serializers own (req/res and other class
 * instances): strings -> maskText, Errors -> masked serialized form, plain objects/arrays recursed
 * with REDACT_KEYS values censored at any depth (pino's `*.x` paths only reach one level).
 */
function maskLogValue(
  value: unknown,
  registry: SecretRegistry | undefined,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return maskText(value, registry);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return serializeErrorWith(value, registry);
  if (depth >= MAX_MASK_DEPTH) return value;
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (isArray) return value.map((item: unknown) => maskLogValue(item, registry, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        isRedactKey(key) && item != null ? CENSOR : maskLogValue(item, registry, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function maskRecord(
  obj: Record<string, unknown>,
  registry: SecretRegistry | undefined,
): Record<string, unknown> {
  return maskLogValue(obj, registry, 0, new WeakSet<object>()) as Record<string, unknown>;
}

/**
 * Last line of defence on the serialized JSON line: registered secret values in their JSON-escaped
 * form (the only form a value can take inside the line), so the replacement keeps the JSON valid.
 * Pattern masking is not applied here because patterns could consume JSON structure.
 */
function maskSerializedLine(line: string, registry: SecretRegistry): string {
  let out = line;
  for (const value of registry.values()) {
    const escaped = JSON.stringify(value).slice(1, -1);
    if (out.includes(escaped)) out = out.split(escaped).join(CENSOR);
  }
  return out;
}

/**
 * pino resets the bindings formatter for child loggers, so child bindings are masked here. Child
 * instances inherit from their parent via the prototype chain, so grandchildren use this too.
 */
function maskChildBindings(logger: Logger, registry: SecretRegistry | undefined): void {
  type ChildFn = (this: Logger, bindings: Bindings, options?: ChildLoggerOptions<never>) => Logger;
  // Taken unbound on purpose: it is re-invoked below with the correct `this` (parent or descendant).
  const pinoChild = (logger as unknown as { child: ChildFn }).child;
  Object.defineProperty(logger, 'child', {
    configurable: true,
    writable: true,
    value: function maskedChild(
      this: Logger,
      bindings: Bindings,
      options?: ChildLoggerOptions<never>,
    ): Logger {
      return pinoChild.call(this, maskRecord(bindings, registry), options);
    },
  });
}

function resolvePinoPretty(): string | null {
  try {
    return createRequire(import.meta.url).resolve('pino-pretty');
  } catch {
    return null;
  }
}

/**
 * Pino JSON logger (§17.1): ISO `time`, `level` label, base `service/env/version/pid/hostname`,
 * current {@link LogContext} via mixin, redaction of REDACT_PATHS plus REDACT_KEYS at any depth,
 * secret masking of `msg`, string fields and errors. Pretty output only in development.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const registry = opts.secrets;
  const prettyTarget =
    opts.pretty === true && opts.env === 'development' && opts.destination === undefined
      ? resolvePinoPretty()
      : null;

  const options: PinoLoggerOptions = {
    level: opts.level,
    base: {
      service: opts.service,
      env: opts.env,
      version: opts.version,
      pid: process.pid,
      hostname: hostname(),
    },
    timestamp: stdTimeFunctions.isoTime,
    messageKey: 'msg',
    errorKey: 'err',
    redact: { paths: [...REDACT_PATHS], censor: CENSOR },
    mixin: () => ({ ...getLogContext() }),
    serializers: {
      err: (value: unknown) => serializeErrorWith(value, registry),
      msg: (value: unknown) => (typeof value === 'string' ? maskText(value, registry) : value),
    },
    formatters: {
      bindings: (bindings) => maskRecord(bindings, registry),
      log: (obj) => maskRecord(obj, registry),
      ...(prettyTarget === null ? { level: (label: string) => ({ level: label }) } : {}),
    },
    ...(registry === undefined
      ? {}
      : { hooks: { streamWrite: (line: string) => maskSerializedLine(line, registry) } }),
  };

  let logger: Logger;
  if (prettyTarget !== null) {
    logger = pino({
      ...options,
      transport: {
        target: prettyTarget,
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      },
    });
  } else if (opts.destination !== undefined) {
    logger = pino(options, opts.destination as DestinationStream);
  } else {
    logger = pino(options);
  }
  maskChildBindings(logger, registry);
  return logger;
}
