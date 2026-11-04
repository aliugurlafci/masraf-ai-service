// Worker entry point (contract §14.1): config -> logger -> runtime -> start; signals -> graceful stop,
// a second signal forces the kill of every registered process tree (§14.5).
import { createLogger, serializeError } from '@orc/logger';
import { createSecretRegistry } from '@orc/security';
import { loadWorkerConfig } from '@orc/shared/node';
import type { WorkerConfig } from '@orc/shared/node';
import { createWorkerRuntime } from './runtime.js';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let config: WorkerConfig;
try {
  config = loadWorkerConfig();
} catch (err) {
  fail(`worker configuration invalid: ${err instanceof Error ? err.message : String(err)}`);
}

const secrets = createSecretRegistry();
const logger = createLogger({
  service: 'worker',
  level: config.logLevel,
  pretty: config.logPretty,
  version: config.appVersion,
  env: config.nodeEnv,
  secrets,
});
const runtime = createWorkerRuntime(config, { logger, secrets });

let signals = 0;
const onSignal = (signal: NodeJS.Signals): void => {
  signals += 1;
  if (signals === 1) {
    logger.info({ signal }, 'shutdown requested');
    void runtime.stop().then((code) => process.exit(code));
    return;
  }
  logger.warn({ signal }, 'second signal: forcing shutdown');
  void runtime.forceKill().finally(() => process.exit(1));
};
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
process.on('unhandledRejection', (err) => {
  logger.error({ err: serializeError(err) }, 'unhandled rejection');
});

runtime.start().catch((err: unknown) => {
  logger.fatal({ err: serializeError(err) }, 'worker failed to start');
  process.exit(1);
});
