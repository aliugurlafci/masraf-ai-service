// API entry point (contract §14.7, §16.2): config -> logger -> DB (orc_api) -> schema version check -> Redis ->
// services -> auth-cleanup -> listen. SIGTERM/SIGINT: readiness false, server.close(), end all SSE responses, stop
// maintenance, close Redis and DB; hard deadline SHUTDOWN_TIMEOUT_MS; a second signal exits immediately.
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadApiConfig } from '@orc/shared/node';
import { createLogger, serializeError } from '@orc/logger';
import { createSecretRegistry, setPasswordHashConcurrency } from '@orc/security';
import { EXPECTED_SCHEMA_VERSION, createDatabase } from '@orc/database';
import type { Database } from '@orc/database';
import { boundRedis, createRedisFactory } from '@orc/task-manager';
import type { QueueRegistry, RedisFactory } from '@orc/task-manager';
import { createApiRuntime, createApp } from './app.js';
import { composeDeps } from './compose.js';
import { createAuthCleanup } from './maintenance.js';
import type { AuthCleanup } from './maintenance.js';

const STARTUP_REDIS_TIMEOUT_MS = 10_000;
/** Bound of the resource release after a failed startup; the process then exits even if a handle is still open. */
const STARTUP_FAILURE_EXIT_MS = 5_000;

/** Handles opened by a startup that may fail half-way; released before exit 1 (no hanging pool / reconnect loop). */
interface StartupResources {
  db?: Database;
  redis?: RedisFactory;
  queues?: QueueRegistry;
  cleanup?: AuthCleanup;
  server?: Server;
}

const started: StartupResources = {};

function closeServer(server: Server | undefined): Promise<void> {
  if (server?.listening !== true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function releaseStartup(r: StartupResources): Promise<void> {
  const steps: (() => Promise<unknown>)[] = [
    () => closeServer(r.server),
    () => r.cleanup?.stop() ?? Promise.resolve(),
    () => r.queues?.close() ?? Promise.resolve(),
    () => r.redis?.closeAll() ?? Promise.resolve(),
    () => r.db?.close() ?? Promise.resolve(),
  ];
  for (const step of steps) {
    await step().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const config = loadApiConfig();
  const secrets = createSecretRegistry();
  secrets.add(config.db.password);
  if (config.redis.password !== null) secrets.add(config.redis.password);
  const logger = createLogger({
    service: 'api',
    level: config.logLevel,
    pretty: config.logPretty,
    version: config.appVersion,
    env: config.nodeEnv,
    secrets,
  });
  setPasswordHashConcurrency(config.passwordHashConcurrency);

  const db = await createDatabase(config.db, { logger, secrets }, { nodeEnv: config.nodeEnv });
  started.db = db;
  const schemaVersion = await db.schemaVersion();
  if (schemaVersion < EXPECTED_SCHEMA_VERSION) {
    throw new Error(`Database schema version ${schemaVersion} < expected ${EXPECTED_SCHEMA_VERSION}; run orc-db migrate`);
  }

  const redis = createRedisFactory(config.redis, { logger });
  started.redis = redis;
  const runtime = createApiRuntime();
  const deps = composeDeps({ config, logger, db, redis, runtime });
  started.queues = deps.queues;
  await boundRedis(deps.commandRedis.ping(), STARTUP_REDIS_TIMEOUT_MS, 'startup PING');

  const cleanup = createAuthCleanup({ db, logger });
  started.cleanup = cleanup;
  cleanup.start();

  const app = createApp(deps);
  const server = createServer(app);
  started.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.apiPort, config.apiHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
  runtime.ready = true;
  const address = server.address() as AddressInfo;
  logger.info(
    { event: 'api_listening', host: address.address, port: address.port, trustProxy: config.trustProxy },
    'api listening',
  );

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    runtime.ready = false;
    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    runtime.sse.closeAll();
    server.closeIdleConnections();
    await cleanup.stop();
    await closed;
    await deps.queues.close();
    await redis.closeAll();
    await db.close();
  };
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      logger.warn({ signal }, 'second signal received: exiting immediately');
      process.exit(1);
    }
    stopping = true;
    logger.info({ signal, liveStreams: runtime.sse.size() }, 'api shutting down');
    const deadline = setTimeout(() => {
      logger.error({ timeoutMs: config.shutdownTimeoutMs }, 'shutdown deadline exceeded: forcing exit');
      server.closeAllConnections();
      process.exit(1);
    }, config.shutdownTimeoutMs);
    deadline.unref();
    shutdown().then(
      () => {
        logger.info('api stopped');
        process.exit(0);
      },
      (err: unknown) => {
        logger.error({ err }, 'api shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch(async (err: unknown) => {
  // The logger may not exist yet (invalid configuration); ConfigError never contains values.
  process.exitCode = 1;
  // Open DB pools / Redis reconnect loops would keep the process alive: release them (bounded), then exit.
  setTimeout(() => process.exit(1), STARTUP_FAILURE_EXIT_MS).unref();
  process.stderr.write(
    `${JSON.stringify({
      level: 'fatal',
      time: new Date().toISOString(),
      service: 'api',
      msg: 'api failed to start',
      err: serializeError(err),
    })}\n`,
  );
  await releaseStartup(started);
});
