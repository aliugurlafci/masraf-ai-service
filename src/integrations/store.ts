// Integrations and their send queue in the database (docs/onay-sistemi.md, section 9). The body rules are
// in payload.ts; this module reads and writes the settings, queues sends in the caller's transaction and
// keeps the log. Every change is written to the audit log; the password never is.
import type sql from 'mssql';
import { audit } from '../db/audit.ts';
import { execute, iso, isUniqueViolation, p, query, queryOne, transaction, type Db, type Executor } from '../db/sql.ts';
import { loadDefinitions } from '../definitions/fields.ts';
import { conflict, HttpError, notFound } from '../errors.ts';
import type { Actor } from '../expenses/rules.ts';
import { buildCatalog, checkMapping, mappingProblems, type AlanEslemesi, type Bicim, type BodySettings, type Catalog, type TarihBicimi } from './payload.ts';
import type { SecretBox } from './secret.ts';

export const TRIGGERS = ['onaylandi', 'odendi', 'elle'] as const;
export type Tetikleyici = (typeof TRIGGERS)[number];
export type Yontem = 'POST' | 'PUT';
export type GonderimDurum = 'bekliyor' | 'gonderildi' | 'hata';

export interface Baslik {
  readonly ad: string;
  readonly deger: string;
}

export type KimlikGirdi = { readonly tur: 'yok' } | { readonly tur: 'basic'; readonly kullanici: string; readonly sifre?: string | undefined };

/** POST/PUT body with its defaults applied (EntegrasyonGirdi). */
export interface EntegrasyonGirdi extends BodySettings {
  readonly ad: string;
  readonly aktif: boolean;
  readonly adres: string;
  readonly yontem: Yontem;
  readonly tetikleyici: Tetikleyici;
  readonly kimlik: KimlikGirdi;
  readonly basliklar: readonly Baslik[];
  readonly zamanAsimiSn: number;
  readonly alanlar: readonly AlanEslemesi[];
}

export interface Entegrasyon extends Omit<EntegrasyonGirdi, 'kimlik'> {
  readonly id: number;
  readonly kimlik: { readonly tur: 'yok' | 'basic'; readonly kullanici: string | null; readonly sifreVar: boolean };
  readonly sorunlar: readonly string[];
  readonly sonGonderim: { readonly id: number; readonly durum: GonderimDurum; readonly zaman: string } | null;
  readonly olusturma: string;
  readonly guncelleme: string;
  readonly guncelleyen: { readonly id: number; readonly adSoyad: string } | null;
}

export interface GonderimOzet {
  readonly id: number;
  readonly entegrasyon: { readonly id: number; readonly ad: string };
  readonly form: { readonly id: number; readonly baslik: string };
  readonly tetikleyen: Tetikleyici;
  readonly kullanici: { readonly id: number; readonly adSoyad: string } | null;
  readonly durum: GonderimDurum;
  readonly deneme: number;
  readonly httpDurum: number | null;
  readonly sonHata: string | null;
  readonly olusturma: string;
  readonly gonderim: string | null;
  readonly sonrakiDeneme: string | null;
}

export interface Gonderim extends GonderimOzet {
  readonly govde: string | null;
  readonly icerikTuru: string | null;
  readonly yanit: string | null;
}

/** An integration as the send job needs it, with the sealed password. */
export interface IntegrationForSend extends BodySettings {
  readonly id: number;
  readonly ad: string;
  readonly adres: string;
  readonly yontem: Yontem;
  readonly kimlik: { readonly tur: 'yok' | 'basic'; readonly kullanici: string | null; readonly sifre: Buffer | null };
  readonly basliklar: readonly Baslik[];
  readonly zamanAsimiSn: number;
  readonly alanlar: readonly AlanEslemesi[];
}

interface Row {
  id: number;
  ad: string;
  aktif: boolean;
  adres: string;
  yontem: Yontem;
  bicim: Bicim;
  kok: string | null;
  xml_ad_alani: string | null;
  fis_listesi: string;
  fis_ogesi: string;
  tarih_bicimi: TarihBicimi;
  tetikleyici: Tetikleyici;
  kimlik_turu: 'yok' | 'basic';
  kullanici_adi: string | null;
  sifre_var: boolean;
  basliklar: string;
  alanlar: string;
  zaman_asimi_sn: number;
  olusturma: Date;
  guncelleme: Date;
  guncelleyen_id: number | null;
  guncelleyen_ad: string | null;
  son_id: number | null;
  son_durum: GonderimDurum | null;
  son_zaman: Date | null;
}

const SELECT = `
  SELECT e.id, e.ad, e.aktif, e.adres, e.yontem, e.bicim, e.kok, e.xml_ad_alani, e.fis_listesi, e.fis_ogesi, e.tarih_bicimi,
         e.tetikleyici, e.kimlik_turu, e.kullanici_adi, CAST(CASE WHEN e.sifre IS NULL THEN 0 ELSE 1 END AS BIT) AS sifre_var,
         e.basliklar, e.alanlar, e.zaman_asimi_sn, e.olusturma, e.guncelleme, e.guncelleyen_id, k.ad_soyad AS guncelleyen_ad,
         s.id AS son_id, s.durum AS son_durum, COALESCE(s.gonderim, s.olusturma) AS son_zaman
  FROM dbo.entegrasyonlar e
  LEFT JOIN dbo.kullanicilar k ON k.id = e.guncelleyen_id
  OUTER APPLY (SELECT TOP (1) g.id, g.durum, g.gonderim, g.olusturma FROM dbo.entegrasyon_gonderimleri g WHERE g.entegrasyon_id = e.id ORDER BY g.id DESC) s`;

/** Stored JSON written by this module; anything else reads as empty. */
function parseList<T>(text: string): T[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function toView(row: Row, catalog: Catalog): Entegrasyon {
  const alanlar = parseList<AlanEslemesi>(row.alanlar);
  return {
    id: row.id,
    ad: row.ad,
    aktif: row.aktif,
    adres: row.adres,
    yontem: row.yontem,
    bicim: row.bicim,
    kok: row.kok,
    xmlAdAlani: row.xml_ad_alani,
    fisListesi: row.fis_listesi,
    fisOgesi: row.fis_ogesi,
    tarihBicimi: row.tarih_bicimi,
    tetikleyici: row.tetikleyici,
    kimlik: { tur: row.kimlik_turu, kullanici: row.kullanici_adi, sifreVar: row.sifre_var },
    basliklar: parseList<Baslik>(row.basliklar),
    zamanAsimiSn: row.zaman_asimi_sn,
    alanlar,
    sorunlar: mappingProblems(alanlar, catalog),
    sonGonderim: row.son_id === null || row.son_durum === null ? null : { id: row.son_id, durum: row.son_durum, zaman: iso(row.son_zaman) ?? '' },
    olusturma: iso(row.olusturma) ?? '',
    guncelleme: iso(row.guncelleme) ?? '',
    guncelleyen: row.guncelleyen_id === null ? null : { id: row.guncelleyen_id, adSoyad: row.guncelleyen_ad ?? '' },
  };
}

/** Every source that can be picked now (receipt fields come from the field management). */
export async function loadCatalog(ex: Executor): Promise<Catalog> {
  return buildCatalog((await loadDefinitions(ex)).fields);
}

const integrationGone = (): HttpError => notFound('Entegrasyon bulunamadı.');
const nameTaken = (): HttpError => conflict('entegrasyon_adi_kullaniliyor', 'Bu adla bir entegrasyon zaten var.');
const noKey = (): HttpError =>
  conflict('anahtar_yok', 'Şifreyi saklamak için .env dosyasında ENTEGRASYON_ANAHTARI (en az 32 karakter) tanımlayıp sunucuyu yeniden başlatın.');

function fieldError(alanlar: Record<string, string>): HttpError {
  return new HttpError(400, 'gecersiz_istek', Object.values(alanlar)[0] ?? 'İstek geçersiz.', { alanlar });
}

/** The mapping checks of payload.ts as a 400, with every path under `prefix` (the preview's "entegrasyon."). */
export function assertMapping(input: EntegrasyonGirdi | (BodySettings & { alanlar: readonly AlanEslemesi[] }), catalog: Catalog, prefix = ''): void {
  const errors = checkMapping(input, catalog);
  if (Object.keys(errors).length > 0) throw fieldError(Object.fromEntries(Object.entries(errors).map(([k, v]) => [`${prefix}${k}`, v])));
}

export async function listIntegrations(db: Db): Promise<Entegrasyon[]> {
  const [rows, catalog] = await Promise.all([query<Row>(db, `${SELECT} ORDER BY e.ad, e.id`), loadCatalog(db)]);
  return rows.map((r) => toView(r, catalog));
}

/** One query at a time: `ex` may be a transaction. */
export async function getIntegration(ex: Executor, id: number): Promise<Entegrasyon> {
  const row = await queryOne<Row>(ex, `${SELECT} WHERE e.id = @id`, { id: p.int(id) });
  if (row === null) throw integrationGone();
  return toView(row, await loadCatalog(ex));
}

/** The sealed password to store: a new one sealed, the kept one, or null without Basic. */
function passwordFor(kimlik: KimlikGirdi, kept: Buffer | null, box: SecretBox | null): Buffer | null {
  if (kimlik.tur === 'yok') return null;
  if (kimlik.sifre !== undefined) {
    if (box === null) throw noKey();
    return box.seal(kimlik.sifre);
  }
  if (kept === null) throw fieldError({ 'kimlik.sifre': 'Şifre girilmelidir.' });
  return kept;
}

function params(input: EntegrasyonGirdi, sifre: Buffer | null, actor: Actor) {
  return {
    ad: p.str(input.ad, 80),
    aktif: p.bit(input.aktif),
    adres: p.str(input.adres, 2000),
    yontem: p.ascii(input.yontem, 8),
    bicim: p.ascii(input.bicim, 8),
    kok: p.ascii(input.kok, 60),
    ns: p.str(input.xmlAdAlani, 400),
    liste: p.ascii(input.fisListesi, 60),
    oge: p.ascii(input.fisOgesi, 60),
    tarih: p.ascii(input.tarihBicimi, 12),
    tetik: p.ascii(input.tetikleyici, 12),
    kimlik: p.ascii(input.kimlik.tur, 8),
    kullanici: p.str(input.kimlik.tur === 'basic' ? input.kimlik.kullanici : null, 200),
    sifre: p.bytes(sifre),
    basliklar: p.text(JSON.stringify(input.basliklar)),
    alanlar: p.text(JSON.stringify(input.alanlar.map((a) => (a.deger === undefined ? { kaynak: a.kaynak, alias: a.alias } : a)))),
    zaman: p.int(input.zamanAsimiSn),
    u: p.int(actor.id),
  };
}

const summaryOf = (input: EntegrasyonGirdi): string =>
  `${input.ad} (${input.bicim.toUpperCase()}, ${input.yontem} ${input.adres}, ${input.tetikleyici}, ${input.aktif ? 'aktif' : 'pasif'}): ${input.alanlar.length} alan`;

export async function createIntegration(db: Db, actor: Actor, input: EntegrasyonGirdi, box: SecretBox | null): Promise<Entegrasyon> {
  assertMapping(input, await loadCatalog(db));
  const sifre = passwordFor(input.kimlik, null, box);
  try {
    return await transaction(db, async (tx) => {
      const row = await queryOne<{ id: number }>(
        tx,
        `INSERT INTO dbo.entegrasyonlar (ad, aktif, adres, yontem, bicim, kok, xml_ad_alani, fis_listesi, fis_ogesi, tarih_bicimi, tetikleyici,
           kimlik_turu, kullanici_adi, sifre, basliklar, alanlar, zaman_asimi_sn, guncelleyen_id)
         OUTPUT inserted.id
         VALUES (@ad, @aktif, @adres, @yontem, @bicim, @kok, @ns, @liste, @oge, @tarih, @tetik, @kimlik, @kullanici, @sifre, @basliklar, @alanlar, @zaman, @u)`,
        params(input, sifre, actor),
      );
      if (row === null) throw new Error('entegrasyon eklenemedi');
      await audit(tx, actor.id, 'entegrasyon_ekle', summaryOf(input));
      return getIntegration(tx, row.id);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

export async function updateIntegration(db: Db, actor: Actor, id: number, input: EntegrasyonGirdi, box: SecretBox | null): Promise<Entegrasyon> {
  assertMapping(input, await loadCatalog(db));
  try {
    return await transaction(db, async (tx) => {
      const current = await queryOne<{ sifre: Buffer | null }>(tx, 'SELECT sifre FROM dbo.entegrasyonlar WITH (UPDLOCK, HOLDLOCK) WHERE id = @id', { id: p.int(id) });
      if (current === null) throw integrationGone();
      const sifre = passwordFor(input.kimlik, current.sifre, box);
      await execute(
        tx,
        `UPDATE dbo.entegrasyonlar SET ad = @ad, aktif = @aktif, adres = @adres, yontem = @yontem, bicim = @bicim, kok = @kok, xml_ad_alani = @ns,
           fis_listesi = @liste, fis_ogesi = @oge, tarih_bicimi = @tarih, tetikleyici = @tetik, kimlik_turu = @kimlik, kullanici_adi = @kullanici,
           sifre = @sifre, basliklar = @basliklar, alanlar = @alanlar, zaman_asimi_sn = @zaman, guncelleme = SYSUTCDATETIME(), guncelleyen_id = @u
         WHERE id = @id`,
        { ...params(input, sifre, actor), id: p.int(id) },
      );
      const changed = input.kimlik.tur === 'basic' && input.kimlik.sifre !== undefined ? '; şifre değişti' : '';
      await audit(tx, actor.id, 'entegrasyon_guncelle', `#${id} ${summaryOf(input)}${changed}`);
      return getIntegration(tx, id);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

/** Deletes the integration and its send log. */
export async function deleteIntegration(db: Db, actor: Actor, id: number): Promise<void> {
  await transaction(db, async (tx) => {
    const row = await queryOne<{ ad: string }>(tx, 'SELECT ad FROM dbo.entegrasyonlar WITH (UPDLOCK, HOLDLOCK) WHERE id = @id', { id: p.int(id) });
    if (row === null) throw integrationGone();
    await execute(tx, 'DELETE FROM dbo.entegrasyonlar WHERE id = @id', { id: p.int(id) });
    await audit(tx, actor.id, 'entegrasyon_sil', `#${id} ${row.ad}`);
  });
}

/**
 * Queues a send for every active integration whose trigger is `olay`, in the transaction of the action
 * (the last approval or "ödendi"). Returns how many were queued.
 */
export async function queueIntegrations(tx: sql.Transaction, formId: number, olay: 'onaylandi' | 'odendi'): Promise<number> {
  return execute(
    tx,
    `INSERT INTO dbo.entegrasyon_gonderimleri (entegrasyon_id, form_id, tetikleyen, sonraki_deneme)
     SELECT id, @f, @o, SYSUTCDATETIME() FROM dbo.entegrasyonlar WHERE aktif = 1 AND tetikleyici = @o`,
    { f: p.int(formId), o: p.ascii(olay, 12) },
  );
}

/** An administrator sends an approved or paid form with one integration (active or not); returns the send's id. */
export async function queueManual(db: Db, actor: Actor, id: number, formId: number): Promise<number> {
  return transaction(db, async (tx) => {
    const integration = await queryOne<{ ad: string }>(tx, 'SELECT ad FROM dbo.entegrasyonlar WITH (UPDLOCK, HOLDLOCK) WHERE id = @id', { id: p.int(id) });
    if (integration === null) throw integrationGone();
    const form = await queryOne<{ durum: string }>(tx, 'SELECT durum FROM dbo.masraf_formlari WHERE id = @f', { f: p.int(formId) });
    if (form === null) throw notFound('Masraf formu bulunamadı.');
    if (form.durum !== 'onaylandi' && form.durum !== 'odendi') {
      throw conflict('gecersiz_durum', 'Yalnızca onaylanan ya da ödenen masraf formları gönderilebilir.');
    }
    const row = await queryOne<{ id: number }>(
      tx,
      `INSERT INTO dbo.entegrasyon_gonderimleri (entegrasyon_id, form_id, tetikleyen, kullanici_id, sonraki_deneme)
       OUTPUT inserted.id VALUES (@e, @f, 'elle', @u, SYSUTCDATETIME())`,
      { e: p.int(id), f: p.int(formId), u: p.int(actor.id) },
    );
    if (row === null) throw new Error('gönderim eklenemedi');
    await audit(tx, actor.id, 'entegrasyon_gonder', `${integration.ad}: #${formId} elle gönderildi (gönderim #${row.id})`);
    return row.id;
  });
}

/** The integration with its sealed password, for the send job; null when it was deleted. */
export async function loadForSend(ex: Executor, id: number): Promise<IntegrationForSend | null> {
  const row = await queryOne<{
    id: number;
    ad: string;
    adres: string;
    yontem: Yontem;
    bicim: Bicim;
    kok: string | null;
    xml_ad_alani: string | null;
    fis_listesi: string;
    fis_ogesi: string;
    tarih_bicimi: TarihBicimi;
    kimlik_turu: 'yok' | 'basic';
    kullanici_adi: string | null;
    sifre: Buffer | null;
    basliklar: string;
    alanlar: string;
    zaman_asimi_sn: number;
  }>(
    ex,
    `SELECT id, ad, adres, yontem, bicim, kok, xml_ad_alani, fis_listesi, fis_ogesi, tarih_bicimi, kimlik_turu, kullanici_adi, sifre,
            basliklar, alanlar, zaman_asimi_sn
     FROM dbo.entegrasyonlar WHERE id = @id`,
    { id: p.int(id) },
  );
  if (row === null) return null;
  return {
    id: row.id,
    ad: row.ad,
    adres: row.adres,
    yontem: row.yontem,
    bicim: row.bicim,
    kok: row.kok,
    xmlAdAlani: row.xml_ad_alani,
    fisListesi: row.fis_listesi,
    fisOgesi: row.fis_ogesi,
    tarihBicimi: row.tarih_bicimi,
    kimlik: { tur: row.kimlik_turu, kullanici: row.kullanici_adi, sifre: row.sifre },
    basliklar: parseList<Baslik>(row.basliklar),
    zamanAsimiSn: row.zaman_asimi_sn,
    alanlar: parseList<AlanEslemesi>(row.alanlar),
  };
}

interface SendRow {
  id: number;
  entegrasyon_id: number;
  entegrasyon_ad: string;
  form_id: number;
  form_baslik: string;
  tetikleyen: Tetikleyici;
  kullanici_id: number | null;
  ad_soyad: string | null;
  durum: GonderimDurum;
  deneme: number;
  http_durum: number | null;
  son_hata: string | null;
  olusturma: Date;
  gonderim: Date | null;
  sonraki_deneme: Date | null;
  govde?: string | null;
  icerik_turu?: string | null;
  yanit?: string | null;
}

const SEND_SELECT = `
  SELECT g.id, g.entegrasyon_id, e.ad AS entegrasyon_ad, g.form_id, f.baslik AS form_baslik, g.tetikleyen, g.kullanici_id, k.ad_soyad,
         g.durum, g.deneme, g.http_durum, g.son_hata, g.olusturma, g.gonderim, g.sonraki_deneme`;
const SEND_FROM = `
  FROM dbo.entegrasyon_gonderimleri g
  JOIN dbo.entegrasyonlar e ON e.id = g.entegrasyon_id
  JOIN dbo.masraf_formlari f ON f.id = g.form_id
  LEFT JOIN dbo.kullanicilar k ON k.id = g.kullanici_id`;

const sendSummary = (r: SendRow): GonderimOzet => ({
  id: r.id,
  entegrasyon: { id: r.entegrasyon_id, ad: r.entegrasyon_ad },
  form: { id: r.form_id, baslik: r.form_baslik },
  tetikleyen: r.tetikleyen,
  kullanici: r.kullanici_id === null ? null : { id: r.kullanici_id, adSoyad: r.ad_soyad ?? '' },
  durum: r.durum,
  deneme: r.deneme,
  httpDurum: r.http_durum,
  sonHata: r.son_hata,
  olusturma: iso(r.olusturma) ?? '',
  gonderim: iso(r.gonderim),
  sonrakiDeneme: r.durum === 'bekliyor' ? iso(r.sonraki_deneme) : null,
});

export interface SendFilter {
  readonly entegrasyonId?: number | undefined;
  readonly formId?: number | undefined;
  readonly durum?: GonderimDurum | undefined;
  readonly adet: number;
}

export async function listSends(db: Db, filter: SendFilter): Promise<GonderimOzet[]> {
  const rows = await query<SendRow>(
    db,
    `SELECT TOP (@n) * FROM (${SEND_SELECT} ${SEND_FROM}
       WHERE (@e IS NULL OR g.entegrasyon_id = @e) AND (@f IS NULL OR g.form_id = @f) AND (@d IS NULL OR g.durum = @d)) x
     ORDER BY x.olusturma DESC, x.id DESC`,
    { n: p.int(filter.adet), e: p.int(filter.entegrasyonId ?? null), f: p.int(filter.formId ?? null), d: p.ascii(filter.durum ?? null, 12) },
  );
  return rows.map(sendSummary);
}

export async function getSend(db: Db, id: number): Promise<Gonderim> {
  const row = await queryOne<SendRow>(db, `${SEND_SELECT}, g.govde, g.icerik_turu, g.yanit ${SEND_FROM} WHERE g.id = @id`, { id: p.int(id) });
  if (row === null) throw notFound('Gönderim bulunamadı.');
  return { ...sendSummary(row), govde: row.govde ?? null, icerikTuru: row.icerik_turu ?? null, yanit: row.yanit ?? null };
}

/** Puts a failed send back in the queue with its attempts reset. */
export async function retrySend(db: Db, actor: Actor, id: number): Promise<void> {
  await transaction(db, async (tx) => {
    const row = await queryOne<{ durum: GonderimDurum; ad: string; form_id: number }>(
      tx,
      `SELECT g.durum, e.ad, g.form_id FROM dbo.entegrasyon_gonderimleri g WITH (UPDLOCK, HOLDLOCK)
       JOIN dbo.entegrasyonlar e ON e.id = g.entegrasyon_id WHERE g.id = @id`,
      { id: p.int(id) },
    );
    if (row === null) throw notFound('Gönderim bulunamadı.');
    if (row.durum !== 'hata') throw conflict('gecersiz_durum', 'Yalnızca gönderilemeyen (hata durumundaki) gönderimler yeniden denenebilir.');
    await execute(
      tx,
      `UPDATE dbo.entegrasyon_gonderimleri SET durum = 'bekliyor', deneme = 0, son_hata = NULL, sonraki_deneme = SYSUTCDATETIME() WHERE id = @id`,
      { id: p.int(id) },
    );
    await audit(tx, actor.id, 'entegrasyon_yeniden', `${row.ad}: gönderim #${id} (#${row.form_id}) yeniden sıraya alındı`);
  });
}
