import { createApp } from './app.ts';
import { createCascadeExtractor } from './cascade.ts';
import { createClaudeExtractor } from './claude-extractor.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createInvoiceStorage } from './storage.ts';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const steps = config.claudeModels.map((model) => ({
    model,
    extract: createClaudeExtractor({
      claudeBin: config.claudeBin,
      model,
      effort: config.claudeEffort,
      timeoutMs: config.timeoutMs,
      maxConcurrent: config.maxConcurrent,
      oauthToken: config.oauthToken,
    }),
  }));

  const app = createApp({
    extract: createCascadeExtractor(steps, config.maxConcurrent),
    storage: createInvoiceStorage(config.dataDir),
    maxFileBytes: config.maxFileBytes,
    port: config.port,
  });

  const server = app.listen(config.port, '127.0.0.1', () => {
    console.info(
      `Fatura servisi hazır: http://127.0.0.1:${config.port}  (model: ${config.claudeModels.join(' > ')}, kayıtlar: ${config.dataDir})`,
    );
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(
      err.code === 'EADDRINUSE' ? `Port ${config.port} kullanımda. PORT ile başka bir port verin.` : `Sunucu başlatılamadı: ${err.message}`,
    );
    process.exit(1);
  });
  // Large uploads plus a Claude run can take minutes.
  server.requestTimeout = config.timeoutMs + 60_000;
  server.headersTimeout = 60_000;

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
