import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadDbConfig, loadServiceConfig } from '../src/config.ts';
import { FAKE_TOKEN } from './helpers.ts';

describe('loadConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fatura-config-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('applies defaults', () => {
    const config = loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN });
    expect(config).toEqual({
      port: 4000,
      claudeBin: 'claude',
      claudeModels: ['haiku', 'opus'],
      claudeEffort: 'low',
      timeoutMs: 180_000,
      maxConcurrent: 2,
      oauthToken: FAKE_TOKEN,
      maxFileBytes: 20 * 1024 * 1024,
      lanAccess: false,
      extraHosts: [],
    });
  });

  it('opens the local network only when asked, with optional extra host names', () => {
    expect(loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, AG_ERISIMI: 'kapali' }).lanAccess).toBe(false);
    const open = loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, AG_ERISIMI: 'yerel', IZINLI_HOSTLAR: ' Masraf-PC.local , 192.168.1.50,' });
    expect(open).toMatchObject({ lanAccess: true, extraHosts: ['masraf-pc.local', '192.168.1.50'] });
  });

  it.each([
    ['AG_ERISIMI', 'acik'],
    ['AG_ERISIMI', 'true'],
    ['IZINLI_HOSTLAR', 'evil.example:80'],
    ['IZINLI_HOSTLAR', 'http://masraf-pc'],
    ['IZINLI_HOSTLAR', 'a b'],
  ])('rejects invalid network setting %s=%s', (key, value) => {
    expect(() => loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, [key]: value })).toThrow(new RegExp(key));
  });

  it('reads the token from a file and trims it', async () => {
    const file = join(dir, 'token.txt');
    await writeFile(file, `${FAKE_TOKEN}\r\n`);
    expect(loadConfig({ CLAUDE_OAUTH_TOKEN_FILE: file }).oauthToken).toBe(FAKE_TOKEN);
  });

  it('explains how to create a missing token file', () => {
    expect(() => loadConfig({ CLAUDE_OAUTH_TOKEN_FILE: join(dir, 'yok.txt') })).toThrow(/claude setup-token/);
  });

  it('rejects a malformed token without echoing it', () => {
    const bad = 'sk-ant-api03-this-is-an-api-key-not-oauth';
    let message = '';
    try {
      loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: bad });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toMatch(/sk-ant-oat/);
    expect(message).not.toContain(bad);
  });

  it.each([
    ['PORT', '0'],
    ['CLAUDE_TIMEOUT_SEC', '5'],
    ['CLAUDE_MAX_CONCURRENT', '20'],
    ['CLAUDE_MAX_CONCURRENT', '5'],
    ['MAX_FILE_MB', '100'],
    ['CLAUDE_MODEL', 'sonnet; rm -rf'],
    ['CLAUDE_MODEL', 'haiku,,opus'],
    ['CLAUDE_MODEL', 'a,b,c,d,e'],
    ['CLAUDE_EFFORT', 'fast'],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, [key]: value })).toThrow(ConfigError);
  });

  it('reads CLAUDE_MODEL as a cascade, cheapest first', () => {
    const config = loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, CLAUDE_MODEL: ' haiku , sonnet,opus ' });
    expect(config.claudeModels).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('accepts overrides', () => {
    const config = loadConfig({
      CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN,
      PORT: '4100',
      CLAUDE_MODEL: 'sonnet',
      CLAUDE_TIMEOUT_SEC: '300',
      MAX_FILE_MB: '5',
    });
    expect(config).toMatchObject({ port: 4100, claudeModels: ['sonnet'], timeoutMs: 300_000, maxFileBytes: 5 * 1024 * 1024 });
  });

  it('maps CLAUDE_EFFORT=default to the CLI default', () => {
    expect(loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, CLAUDE_EFFORT: 'default' }).claudeEffort).toBeUndefined();
    expect(loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, CLAUDE_EFFORT: 'high' }).claudeEffort).toBe('high');
  });
});

describe('loadDbConfig', () => {
  it('applies defaults and needs only the password', () => {
    expect(loadDbConfig({ MSSQL_PASSWORD: 'Gizli_Sifre1' })).toEqual({
      host: '127.0.0.1',
      port: 1433,
      database: 'masraf',
      user: 'sa',
      password: 'Gizli_Sifre1',
      encrypt: true,
      trustServerCertificate: true,
      poolMax: 10,
      connectWaitMs: 60_000,
    });
  });

  it('explains how to set a missing password', () => {
    expect(() => loadDbConfig({})).toThrow(/MSSQL_PASSWORD.*env\.example/);
  });

  it('reads every setting from the environment', () => {
    const config = loadDbConfig({
      MSSQL_HOST: 'db.local',
      MSSQL_PORT: '14333',
      MSSQL_DATABASE: 'masraf_dev',
      MSSQL_USER: 'masraf',
      MSSQL_PASSWORD: 'x',
      MSSQL_ENCRYPT: 'false',
      MSSQL_TRUST_SERVER_CERTIFICATE: '0',
      MSSQL_POOL_MAX: '3',
      MSSQL_CONNECT_WAIT_SEC: '0',
    });
    expect(config).toMatchObject({ host: 'db.local', port: 14333, database: 'masraf_dev', user: 'masraf', encrypt: false, trustServerCertificate: false, poolMax: 3, connectWaitMs: 0 });
  });

  it.each([
    ['MSSQL_DATABASE', 'masraf; DROP DATABASE x'],
    ['MSSQL_DATABASE', '1masraf'],
    ['MSSQL_PORT', '70000'],
    ['MSSQL_ENCRYPT', 'belki'],
    ['MSSQL_POOL_MAX', '0'],
  ])('rejects invalid %s=%s without echoing the password', (key, value) => {
    let message = '';
    try {
      loadDbConfig({ MSSQL_PASSWORD: 'Cok_Gizli_42', [key]: value });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain(key);
    expect(message).not.toContain('Cok_Gizli_42');
  });
});

describe('loadServiceConfig', () => {
  it('applies defaults', () => {
    expect(loadServiceConfig({})).toEqual({
      auth: { sessionTtlMs: 168 * 3_600_000, loginMaxAttempts: 10, loginLockMs: 15 * 60_000, passwordMinLength: 8 },
      baseCurrency: 'TRY',
      firstAdmin: null,
      mail: { enabled: false, smtp: null, gonderen: null, maxAttempts: 5, appUrl: null },
      reminder: { waitHours: 24, hour: 9, minute: 0 },
    });
  });

  it('reads the SMTP settings only when mail is on', () => {
    const smtp = {
      MAIL_GONDERIM: 'smtp',
      SMTP_HOST: 'smtp.firma.com',
      SMTP_PORT: '465',
      SMTP_GUVENLIK: 'tls',
      SMTP_KULLANICI: 'masraf',
      SMTP_SIFRE: 'GizliSmtp1',
      MAIL_GONDEREN: 'Masraf <masraf@firma.com>',
      MAIL_DENEME_SAYISI: '3',
      UYGULAMA_ADRESI: 'http://192.168.1.10:4000/',
    };
    expect(loadServiceConfig(smtp).mail).toEqual({
      enabled: true,
      smtp: { host: 'smtp.firma.com', port: 465, guvenlik: 'tls', kullanici: 'masraf', sifre: 'GizliSmtp1' },
      gonderen: 'Masraf <masraf@firma.com>',
      maxAttempts: 3,
      appUrl: 'http://192.168.1.10:4000',
    });
    // Off, the SMTP values are not used at all.
    expect(loadServiceConfig({ ...smtp, MAIL_GONDERIM: 'kapali' }).mail).toMatchObject({ enabled: false, smtp: null, gonderen: null });
    expect(loadServiceConfig({ MAIL_GONDERIM: 'smtp', SMTP_HOST: 'smtp.firma.com', MAIL_GONDEREN: 'm@f.com' }).mail.smtp).toMatchObject({
      port: 587,
      guvenlik: 'starttls',
      kullanici: null,
      sifre: null,
    });
  });

  it.each([
    [{ MAIL_GONDERIM: 'smtp', MAIL_GONDEREN: 'm@f.com' }, /SMTP_HOST/],
    [{ MAIL_GONDERIM: 'smtp', SMTP_HOST: 'smtp.firma.com' }, /MAIL_GONDEREN/],
    [{ MAIL_GONDERIM: 'acik' }, /MAIL_GONDERIM/],
    [{ SMTP_GUVENLIK: 'ssl' }, /SMTP_GUVENLIK/],
    [{ SMTP_HOST: 'smtp.firma.com\r\nX' }, /SMTP_HOST/],
    [{ MAIL_GONDEREN: 'masraf@firma.com\r\nBcc: x@y.z' }, /MAIL_GONDEREN/],
    [{ MAIL_DENEME_SAYISI: '0' }, /MAIL_DENEME_SAYISI/],
    [{ MAIL_DENEME_SAYISI: '21' }, /MAIL_DENEME_SAYISI/],
    [{ UYGULAMA_ADRESI: 'javascript:alert(1)' }, /UYGULAMA_ADRESI/],
    [{ UYGULAMA_ADRESI: 'ftp://firma' }, /UYGULAMA_ADRESI/],
    [{ HATIRLATMA_BEKLEME_SAAT: '721' }, /HATIRLATMA_BEKLEME_SAAT/],
    [{ HATIRLATMA_SAATI: '24:00' }, /HATIRLATMA_SAATI/],
    [{ HATIRLATMA_SAATI: '9' }, /HATIRLATMA_SAATI/],
  ])('rejects invalid mail or reminder settings %j', (env, pattern) => {
    expect(() => loadServiceConfig(env)).toThrow(pattern);
  });

  it('never echoes the SMTP password', () => {
    expect(() => loadServiceConfig({ MAIL_GONDERIM: 'smtp', SMTP_SIFRE: 'GizliSmtp1', MAIL_GONDEREN: 'm@f.com' })).toThrow(/^(?!.*GizliSmtp1)/);
  });

  it('reads the reminder time, and 0 hours turns reminders off', () => {
    expect(loadServiceConfig({ HATIRLATMA_SAATI: '18:45', HATIRLATMA_BEKLEME_SAAT: '0' }).reminder).toEqual({ waitHours: 0, hour: 18, minute: 45 });
  });

  it('reads the first administrator, e-mail in lower case', () => {
    const config = loadServiceConfig({ ILK_YONETICI_EPOSTA: ' Admin@Firma.com ', ILK_YONETICI_SIFRE: 'Baslangic123', ILK_YONETICI_AD: 'Ayşe Yönetici' });
    expect(config.firstAdmin).toEqual({ eposta: 'admin@firma.com', sifre: 'Baslangic123', adSoyad: 'Ayşe Yönetici' });
  });

  it.each([
    [{ ILK_YONETICI_EPOSTA: 'admin@firma.com' }, /ILK_YONETICI_SIFRE/],
    [{ ILK_YONETICI_EPOSTA: 'admin@firma.com', ILK_YONETICI_SIFRE: 'kisa1' }, /en az 8/],
    [{ ILK_YONETICI_SIFRE: 'Baslangic123' }, /ILK_YONETICI_EPOSTA/],
    [{ ILK_YONETICI_EPOSTA: 'adres-degil', ILK_YONETICI_SIFRE: 'Baslangic123' }, /ILK_YONETICI_EPOSTA/],
  ])('rejects an incomplete first administrator %j', (env, pattern) => {
    expect(() => loadServiceConfig(env)).toThrow(pattern);
  });

  it.each([
    ['PARA_BIRIMI', 'TL'],
    ['OTURUM_SURESI_SAAT', '0'],
    ['GIRIS_DENEME_SINIRI', '1'],
    ['SIFRE_MIN_UZUNLUK', '4'],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => loadServiceConfig({ [key]: value })).toThrow(ConfigError);
  });

  it('reads overrides', () => {
    const config = loadServiceConfig({ OTURUM_SURESI_SAAT: '12', GIRIS_DENEME_SINIRI: '5', GIRIS_KILIT_DAKIKA: '30', SIFRE_MIN_UZUNLUK: '12', PARA_BIRIMI: 'EUR' });
    expect(config).toMatchObject({
      auth: { sessionTtlMs: 12 * 3_600_000, loginMaxAttempts: 5, loginLockMs: 30 * 60_000, passwordMinLength: 12 },
      baseCurrency: 'EUR',
    });
  });
});
