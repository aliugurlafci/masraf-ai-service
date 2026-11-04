// Egress proxy entry point (contract §16.4, §19): config -> logger -> proxy -> signal handling.
import { createLogger, serializeError } from '@orc/logger';
import { loadEgressProxyConfig } from '@orc/shared/node';
import { createEgressProxy, settingsFromConfig } from './proxy.js';

/** Time open tunnels get to finish after SIGTERM; compose stop_grace_period is 10 s. */
const SHUTDOWN_GRACE_MS = 5_000;

async function main(): Promise<void> {
  const config = loadEgressProxyConfig();
  const logger = createLogger({
    service: 'egress-proxy',
    level: config.logLevel,
    pretty: config.logPretty,
    version: config.appVersion,
    env: config.nodeEnv,
  });
  if (config.egressAuthToken === null) {
    logger.warn(
      { event: 'egress_auth_disabled' },
      'EGRESS_AUTH_TOKEN is not set: proxy authentication is disabled (never allowed in production)',
    );
  }

  const proxy = createEgressProxy({ settings: settingsFromConfig(config), logger });
  const address = await proxy.listen(config.egressPort, config.egressHost);
  logger.info(
    {
      event: 'egress_listening',
      host: address.address,
      port: address.port,
      allowedHosts: config.egressAllowedHosts,
      allowedPorts: config.egressAllowedPorts,
      denyPrivateIps: config.egressDenyPrivateIps,
      maxConnections: config.egressMaxConnections,
    },
    'egress proxy listening',
  );

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      logger.warn({ signal }, 'second signal received: exiting immediately');
      process.exit(1);
    }
    stopping = true;
    logger.info({ signal, activeTunnels: proxy.activeTunnels() }, 'egress proxy shutting down');
    proxy.close(SHUTDOWN_GRACE_MS).then(
      () => {
        logger.info('egress proxy stopped');
        process.exit(0);
      },
      (err: unknown) => {
        logger.error({ err }, 'egress proxy shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err: unknown) => {
  // The logger may not exist yet (invalid configuration); ConfigError never contains values.
  process.stderr.write(
    `${JSON.stringify({
      level: 'fatal',
      time: new Date().toISOString(),
      service: 'egress-proxy',
      msg: 'egress proxy failed to start',
      err: serializeError(err),
    })}\n`,
  );
  process.exitCode = 1;
});
