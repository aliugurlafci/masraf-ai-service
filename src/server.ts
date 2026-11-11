import { createApp } from './api/app.ts';
import { lanAddresses, lanHostList } from './api/network.ts';
import { createCascadeExtractor } from './claude/cascade.ts';
import { createClaudeExtractor } from './claude/extractor.ts';
import { ConfigError, loadConfig, loadDbConfig, loadServiceConfig } from './config.ts';
import { DatabaseError, openDatabase } from './db/database.ts';
import { createExpenseService, fillDuplicateKeys } from './expenses/forms.ts';
import { createPayloadLoader } from './integrations/form-data.ts';
import { createSecretBox } from './integrations/secret.ts';
import { createIntegrationSender } from './integrations/sender.ts';
import { createOutbox } from './notifications/outbox.ts';
import { createReminderJob } from './notifications/reminders.ts';
import { smtpSender } from './notifications/smtp.ts';
import type { NotifySettings } from './notifications/store.ts';
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

  // Invoice links written before the duplicate key existed get theirs once.
  const keyed = await fillDuplicateKeys(db);
  if (keyed > 0) console.info(`${keyed} fatura bağının mükerrer anahtarı dolduruldu.`);

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

  const mail: NotifySettings = { mailEnabled: service.mail.enabled, appUrl: service.mail.appUrl };
  // Mail leaves the machine only when the user set MAIL_GONDERIM=smtp.
  const smtp = service.mail.smtp;
  // Renders the approval document attached to a mail, from the form as it is when the mail goes out.
  const documents = createExpenseService(db, { baseCurrency: service.baseCurrency, notifications: mail });
  const outbox =
    service.mail.enabled && smtp !== null && service.mail.gonderen !== null
      ? createOutbox({
          db,
          send: smtpSender(smtp),
          from: service.mail.gonderen,
          maxAttempts: service.mail.maxAttempts,
          attachment: (formId) => documents.pdfForMail(formId),
          secrets: [smtp.sifre, smtp.kullanici],
        })
      : null;
  // Reminders run in every mail mode: the in-app notification always goes out; with mail off the
  // mail is written as skipped (atlandi). Only HATIRLATMA_BEKLEME_SAAT=0 turns them off.
  const reminders = createReminderJob({ db, settings: service.reminder, mail });
  // Approved forms go to the integrations' addresses (docs/onay-sistemi.md, section 9). Nothing is sent
  // until an administrator adds an active integration.
  const box = createSecretBox(service.integration.key);
  const integrations = createIntegrationSender({
    db,
    load: createPayloadLoader(db, documents, service.baseCurrency),
    box,
    maxAttempts: service.integration.maxAttempts,
  });

  const app = createApp({
    extract: createCascadeExtractor(steps, config.maxConcurrent),
    db,
    maxFileBytes: config.maxFileBytes,
    maxConcurrent: config.maxConcurrent,
    port: config.port,
    ...(config.lanAccess ? { lanHosts: lanHostList(config.extraHosts) } : {}),
    auth: service.auth,
    baseCurrency: service.baseCurrency,
    mail,
    // Files of saved forms that were still waiting when the server stopped are read again.
    resumeReads: true,
    integrations: { box, kick: () => integrations.kick() },
  });

  // IPv4 only: the local-network checks (src/api/network.ts) know IPv4 private ranges.
  const listenHost = config.lanAccess ? '0.0.0.0' : '127.0.0.1';
  const server = app.listen(config.port, listenHost, () => {
    console.info(
      `Masraf servisi hazır: http://127.0.0.1:${config.port}  (model: ${config.claudeModels.join(' > ')}, aynı anda ${config.maxConcurrent} fatura, veritabanı: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database})`,
    );
    console.info(
      service.mail.enabled
        ? `Bildirim mailleri açık: ${smtp?.host}:${smtp?.port}.`
        : 'Bildirim mailleri kapalı (MAIL_GONDERIM=kapali); uygulama içi bildirimler oluşur.',
    );
    outbox?.start();
    reminders.start();
    integrations.start();
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
  // Phones keep idle connections for minutes (Android's OkHttp 5 min, iOS similar) and ignore the
  // Keep-Alive header. With Node's default 5 s the server closed them first and a POST sent on such a
  // connection failed as a network error on the phone. Outlast the clients so they close first.
  server.keepAliveTimeout = 330_000;

  const shutdown = (): void => {
    server.close(() => {
      // The jobs finish the mail, reminder or integration send at hand before the pool closes.
      Promise.all([outbox?.stop(), reminders.stop(), integrations.stop()])
        .then(() => db.close())
        .finally(() => process.exit(0));
    });
    // Open live-monitor streams never end on their own.
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
