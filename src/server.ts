import { createApp } from './api/app.ts';
import { lanAddresses, lanHostList } from './api/network.ts';
import { createCascadeExtractor } from './claude/cascade.ts';
import { createClaudeExtractor } from './claude/extractor.ts';
import { ConfigError, loadConfig, loadDbConfig, loadServiceConfig } from './config.ts';
import { DatabaseError, openDatabase } from './db/database.ts';
import { ensureFirstAdmin } from './users/users.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  let config, dbConfig, service;
  try {
    config = loadConfig();
    dbConfig = loadDbConfig();
    service = loadServiceConfig();
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }

  let db;
  try {
    db = await openDatabase(dbConfig);
  } catch (err) {
    if (err instanceof DatabaseError) fail(err.message);
    throw err;
  }

  const firstAdmin = await ensureFirstAdmin(db, service.firstAdmin);
  if (firstAdmin === 'ayar_yok') {
    await db.close();
    fail(
      'Veritabanında hiç kullanıcı yok. İlk yöneticiyi oluşturmak için .env dosyasında ILK_YONETICI_EPOSTA ve ILK_YONETICI_SIFRE değerlerini doldurup yeniden başlatın.',
    );
  }
  if (firstAdmin === 'olusturuldu') {
    console.info(
      `İlk yönetici oluşturuldu ve onay akışına eklendi: ${service.firstAdmin?.eposta}. Artık .env dosyasındaki ILK_YONETICI_SIFRE değerini silebilirsiniz.`,
    );
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
    db,
    maxFileBytes: config.maxFileBytes,
    maxConcurrent: config.maxConcurrent,
    port: config.port,
    ...(config.lanAccess ? { lanHosts: lanHostList(config.extraHosts) } : {}),
    auth: service.auth,
    baseCurrency: service.baseCurrency,
  });

  // IPv4 only: the local-network checks (src/api/network.ts) know IPv4 private ranges.
  const listenHost = config.lanAccess ? '0.0.0.0' : '127.0.0.1';
  const server = app.listen(config.port, listenHost, () => {
    console.info(
      `Masraf servisi hazır: http://127.0.0.1:${config.port}  (model: ${config.claudeModels.join(' > ')}, aynı anda ${config.maxConcurrent} fatura, veritabanı: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database})`,
    );
    if (config.lanAccess) {
      const addresses = [...lanAddresses(), ...config.extraHosts];
      console.info(
        addresses.length === 0
          ? 'Yerel ağ erişimi açık, ama bu bilgisayarda özel ağ adresi bulunamadı. Wi-Fi bağlantısını kontrol edin.'
          : `Yerel ağdan: ${addresses.map((a) => `http://${a}:${config.port}`).join('  ')}  (mobil uygulamada EXPO_PUBLIC_API_URL bunlardan biri olmalı)`,
      );
      console.warn(
        'Uyarı: Yerel ağ erişimi açık (AG_ERISIMI=yerel). Bağlantı şifresiz HTTP olduğundan oturumlar ve faturalar aynı ağdakilerce görülebilir; yalnızca güvendiğiniz ağlarda kullanın.',
      );
    }
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    fail(err.code === 'EADDRINUSE' ? `Port ${config.port} kullanımda. .env dosyasında PORT ile başka bir port verin.` : `Sunucu başlatılamadı: ${err.message}`);
  });
  // Large uploads plus a Claude run can take minutes.
  server.requestTimeout = config.timeoutMs + 60_000;
  server.headersTimeout = 60_000;

  const shutdown = (): void => {
    server.close(() => {
      db.close().finally(() => process.exit(0));
    });
    // Open live-monitor streams never end on their own.
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
