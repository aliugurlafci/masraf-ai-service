// @orc/runner entry (contract §10.11, §16.7, §19): `node dist/runner.js` serves the runner socket;
// `node dist/runner.js healthcheck` performs `hello` over the socket (compose healthcheck).
import { createLogger, serializeError } from '@orc/logger';
import { createRunnerClient, PROTOCOL_VERSION } from '@orc/sandbox';
import { loadRunnerConfig } from '@orc/shared/node';
import { z } from 'zod';
import { createRunnerRuntime } from './runtime';

const CommandSchema = z.enum(['serve', 'healthcheck']);

function writeErr(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function healthcheck(): Promise<number> {
  const config = loadRunnerConfig();
  const client = createRunnerClient({
    socketPath: config.runnerSocketPath,
    requestTimeoutMs: 5000,
  });
  try {
    const hello = await client.hello();
    if (hello.protocol !== PROTOCOL_VERSION) {
      writeErr(`runner protocol ${String(hello.protocol)} unsupported`);
      return 1;
    }
    return 0;
  } catch (e) {
    writeErr(`runner healthcheck failed: ${serializeError(e).message}`);
    return 1;
  } finally {
    await client.close();
  }
}

async function serve(): Promise<void> {
  const config = loadRunnerConfig();
  const logger = createLogger({
    service: 'runner',
    level: config.logLevel,
    pretty: config.logPretty,
    version: config.appVersion,
    env: config.nodeEnv,
  });
  // Files the launcher creates (state, socket before chmod) are private by default.
  process.umask(0o077);
  const runtime = createRunnerRuntime(config, logger);

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });

  let signalled = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (signalled) {
      logger.warn({ signal }, 'second signal: exiting immediately');
      process.exit(1);
    }
    signalled = true;
    logger.info({ signal }, 'runner shutting down');
    runtime.stop().then(
      () => process.exit(0),
      (e: unknown) => {
        logger.fatal({ err: e }, 'runner shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  try {
    await runtime.start();
  } catch (e) {
    logger.fatal({ err: e }, 'runner failed to start');
    await runtime.stop().catch(() => undefined);
    process.exit(1);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const parsed = CommandSchema.safeParse(argv[2] ?? 'serve');
  if (!parsed.success) {
    writeErr('usage: runner [serve|healthcheck]');
    process.exit(2);
  }
  if (parsed.data === 'healthcheck') {
    process.exit(await healthcheck());
  }
  await serve();
}

main(process.argv).catch((e: unknown) => {
  writeErr(`runner: ${serializeError(e).message}`);
  process.exit(1);
});
