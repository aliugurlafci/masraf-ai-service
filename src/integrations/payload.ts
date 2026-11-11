// The body an integration sends (docs/onay-sistemi.md, section 9, "Gövde" and "Kaynak alanlar"): which
// fields can be picked, the rules of the aliases and the JSON or XML built from a form. Pure; the data
// comes from src/integrations/form-data.ts.
import { isEntryField, type FieldDef } from '../expenses/field-rules.ts';
import type { Invoice } from '../invoice/schema.ts';

export const FORMATS = ['json', 'xml'] as const;
export type Bicim = (typeof FORMATS)[number];

export const DATE_FORMATS = ['YYYY-AA-GG', 'YYYYAAGG', 'GG.AA.YYYY'] as const;
export type TarihBicimi = (typeof DATE_FORMATS)[number];

export type KaynakTuru = 'metin' | 'sayi' | 'tutar' | 'tarih';

/** A field that can be sent (Kaynak). */
export interface Kaynak {
  readonly anahtar: string;
  readonly ad: string;
  readonly tur: KaynakTuru;
  /** False only for a receipt field that is inactive now: it stays pickable and sends an empty value. */
  readonly aktif: boolean;
}

export interface Catalog {
  readonly form: readonly Kaynak[];
  readonly fis: readonly Kaynak[];
}

/** One row of the mapping: a source sent under an alias; `deger` only for a constant. */
export interface AlanEslemesi {
  readonly kaynak: string;
  readonly alias: string;
  readonly deger?: string | undefined;
}

/** How the body is laid out. */
export interface BodySettings {
  readonly bicim: Bicim;
  /** Root element; required for XML, wraps the JSON body when set. */
  readonly kok: string | null;
  /** XML namespace of the root (written with the ns0 prefix); null for none. */
  readonly xmlAdAlani: string | null;
  readonly fisListesi: string;
  /** The element of each receipt in the XML list. */
  readonly fisOgesi: string;
  readonly tarihBicimi: TarihBicimi;
}

export type Value = string | number | null;

/** A form's values by source key: dates as YYYY-MM-DD, amounts and numbers as numbers. */
export interface PayloadData {
  readonly form: Readonly<Record<string, Value>>;
  /** One entry per invoice on the form, in the form's order. */
  readonly fisler: ReadonlyArray<Readonly<Record<string, Value>>>;
}

export const FORM_CONSTANT = 'form.sabit';
export const RECEIPT_CONSTANT = 'fis.sabit';
/** Prefix of a receipt field's source: fis.alan.<key>, and fis.alan.<key>.ad for an option's name. */
export const RECEIPT_FIELD_PREFIX = 'fis.alan.';

export const MAX_MAPPINGS = 100;
export const MAX_CONSTANT_LENGTH = 200;

const source = (anahtar: string, ad: string, tur: KaynakTuru): Kaynak => ({ anahtar, ad, tur, aktif: true });

export const FORM_SOURCES: readonly Kaynak[] = [
  source('form.no', 'Form No', 'sayi'),
  source('form.baslik', 'Başlık', 'metin'),
  source('form.aciklama', 'Açıklama', 'metin'),
  source('form.masrafTarihi', 'Masraf Tarihi', 'tarih'),
  source('form.tutar', 'Tutar', 'tutar'),
  source('form.paraBirimi', 'Para Birimi', 'metin'),
  source('form.kur', 'Kur', 'sayi'),
  source('form.yerelTutar', 'Yerel Tutar', 'tutar'),
  source('form.onayTutari', 'Onay Tutarı', 'tutar'),
  source('form.satici', 'Satıcı', 'metin'),
  source('form.durum', 'Durum', 'metin'),
  source('form.kategori', 'Kategori', 'metin'),
  source('form.kategoriKodu', 'Kategori Kodu', 'metin'),
  source('form.hesapKodu', 'Hesap Kodu', 'metin'),
  source('form.masrafMerkezi', 'Masraf Merkezi', 'metin'),
  source('form.masrafMerkeziAciklama', 'Masraf Merkezi Açıklaması', 'metin'),
  source('form.organizasyon', 'Organizasyon Kodu', 'metin'),
  source('form.organizasyonAdi', 'Organizasyon Adı', 'metin'),
  source('form.gonderen', 'Gönderen', 'metin'),
  source('form.gonderenEposta', 'Gönderen E-postası', 'metin'),
  source('form.departman', 'Departman', 'metin'),
  source('form.gonderimTarihi', 'Gönderim Tarihi', 'tarih'),
  source('form.onayTarihi', 'Onay Tarihi', 'tarih'),
  source('form.odemeTarihi', 'Ödeme Tarihi', 'tarih'),
  source('form.sonOnaylayan', 'Son Onaylayan', 'metin'),
  source('form.fisSayisi', 'Fiş Sayısı', 'sayi'),
  source(FORM_CONSTANT, 'Sabit değer', 'metin'),
];

/** The invoice header fields in schema order, with the names the field management shows. */
export const HEADER_FIELDS: ReadonlyArray<readonly [keyof Invoice['fatura'], string, KaynakTuru]> = [
  ['faturaNo', 'Fatura No', 'metin'],
  ['faturaTarihi', 'Fatura Tarihi', 'tarih'],
  ['saticiUnvan', 'Satıcı', 'metin'],
  ['saticiVergiNo', 'Satıcı Vergi No', 'metin'],
  ['aliciUnvan', 'Alıcı', 'metin'],
  ['aliciVergiNo', 'Alıcı Vergi No', 'metin'],
  ['paraBirimi', 'Para Birimi', 'metin'],
  ['araToplam', 'Ara Toplam', 'tutar'],
  ['kdvToplam', 'KDV Toplamı', 'tutar'],
  ['genelToplam', 'Genel Toplam', 'tutar'],
];

export const INVOICE_SOURCES: readonly Kaynak[] = [
  source('fis.sira', 'Sıra', 'sayi'),
  source('fis.kimlik', 'Fatura Kimliği', 'metin'),
  source('fis.dosyaAdi', 'Dosya Adı', 'metin'),
  ...HEADER_FIELDS.map(([k, ad, tur]) => source(`fis.${k}`, ad, tur)),
  source('fis.yerelKarsilik', 'Yerel Karşılık', 'tutar'),
  source('fis.yerelTutar', 'Yerel Tutar', 'tutar'),
];

const ENTRY_TYPES: Readonly<Record<string, KaynakTuru>> = { liste: 'metin', metin: 'metin', uzun_metin: 'metin', sayi: 'sayi', tarih: 'tarih' };

/** Every source: the fixed ones and the receipt fields (inactive ones too), then the receipt constant. */
export function buildCatalog(fields: readonly FieldDef[]): Catalog {
  const entries = fields.filter(isEntryField);
  const receipt: Kaynak[] = [];
  for (const f of entries) {
    receipt.push({ anahtar: `${RECEIPT_FIELD_PREFIX}${f.anahtar}`, ad: f.ad, tur: ENTRY_TYPES[f.tur] ?? 'metin', aktif: f.aktif });
    if (f.tur === 'liste') receipt.push({ anahtar: `${RECEIPT_FIELD_PREFIX}${f.anahtar}.ad`, ad: `${f.ad} (açıklama)`, tur: 'metin', aktif: f.aktif });
  }
  return { form: FORM_SOURCES, fis: [...INVOICE_SOURCES, ...receipt, source(RECEIPT_CONSTANT, 'Sabit değer', 'metin')] };
}

export type Level = 'form' | 'fis';

/** The level of a source key from its prefix; null for anything else. */
export const levelOf = (kaynak: string): Level | null => (kaynak.startsWith('form.') ? 'form' : kaynak.startsWith('fis.') ? 'fis' : null);

export const isConstant = (kaynak: string): boolean => kaynak === FORM_CONSTANT || kaynak === RECEIPT_CONSTANT;

function findSource(catalog: Catalog, kaynak: string): Kaynak | null {
  const level = levelOf(kaynak);
  if (level === null) return null;
  return catalog[level].find((k) => k.anahtar === kaynak) ?? null;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/;

/** Why `name` cannot be an element or key name (Turkish), or null when it can. Same rule for JSON and XML. */
export function nameProblem(name: string, label = 'Ad'): string | null {
  if (name === '') return `${label} boş olamaz.`;
  if (name.length > 60) return `${label} en fazla 60 karakter olabilir.`;
  if (!NAME.test(name)) return `${label} harf ya da _ ile başlamalı; yalnızca İngilizce harf, rakam, _, - ve . içermeli.`;
  if (/^xml/i.test(name)) return `${label} "xml" ile başlayamaz.`;
  return null;
}

/** Why the XML namespace cannot be used, or null. */
export function namespaceProblem(ns: string): string | null {
  if (ns.length > 400) return 'Ad alanı en fazla 400 karakter olabilir.';
  if (/[\s"'<>&]/.test(ns)) return 'Ad alanı boşluk, tırnak, <, > ya da & içeremez.';
  return null;
}

/** What the body checks need; the fields not given are taken as set. */
export interface MappingInput extends BodySettings {
  readonly alanlar: readonly AlanEslemesi[];
}

/**
 * Checks the layout and the mapping against the sources, by request path (`kok`, `alanlar.2.alias`, …);
 * an empty result means the body can be built.
 */
export function checkMapping(input: MappingInput, catalog: Catalog): Record<string, string> {
  const errors: Record<string, string> = {};
  const put = (path: string, message: string | null): void => {
    if (message !== null) errors[path] ??= message;
  };
  if (input.kok === null) {
    if (input.bicim === 'xml') put('kok', 'XML gövdede kök öğe adı zorunludur.');
  } else put('kok', nameProblem(input.kok, 'Kök adı'));
  put('fisListesi', nameProblem(input.fisListesi, 'Fiş listesi adı'));
  put('fisOgesi', nameProblem(input.fisOgesi, 'Fiş öğesi adı'));
  if (input.xmlAdAlani !== null) put('xmlAdAlani', namespaceProblem(input.xmlAdAlani));
  if (input.alanlar.length === 0) put('alanlar', 'En az bir alan seçilmelidir.');
  if (input.alanlar.length > MAX_MAPPINGS) put('alanlar', `En fazla ${MAX_MAPPINGS} alan eşlenebilir.`);

  const seen: Record<Level, Map<string, number>> = { form: new Map([[input.fisListesi.toLowerCase(), -1]]), fis: new Map() };
  input.alanlar.forEach((row, i) => {
    const at = `alanlar.${i}`;
    const src = findSource(catalog, row.kaynak);
    if (src === null) put(`${at}.kaynak`, 'Bu kaynak alan yok.');
    const aliasProblem = nameProblem(row.alias, 'Ad');
    put(`${at}.alias`, aliasProblem);
    if (isConstant(row.kaynak)) {
      const value = row.deger ?? '';
      if (value.trim() === '') put(`${at}.deger`, 'Sabit değer girilmelidir.');
      else if (value.length > MAX_CONSTANT_LENGTH) put(`${at}.deger`, `Sabit değer en fazla ${MAX_CONSTANT_LENGTH} karakter olabilir.`);
    } else if (row.deger !== undefined) put(`${at}.deger`, 'Değer yalnızca sabit değer satırında girilir.');
    const level = levelOf(row.kaynak);
    if (level === null || aliasProblem !== null) return;
    const key = row.alias.toLowerCase();
    const other = seen[level].get(key);
    if (other === undefined) seen[level].set(key, i);
    else if (other === -1) put(`${at}.alias`, 'Bu ad fiş listesinin adıyla aynı.');
    else put(`${at}.alias`, `Bu ad ${other + 1}. satırda da kullanılıyor.`);
  });
  return errors;
}

/** Rows of a saved mapping whose source is gone (a deleted receipt field), as the admin sees them. */
export function mappingProblems(alanlar: readonly AlanEslemesi[], catalog: Catalog): string[] {
  const out: string[] = [];
  alanlar.forEach((row, i) => {
    if (findSource(catalog, row.kaynak) === null) out.push(`${i + 1}. satır (${row.kaynak}): bu alan silinmiş.`);
  });
  return out;
}

// ---------- Values ----------

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** A YYYY-MM-DD date in the chosen format; anything that is not such a date is sent as it is. */
export function formatDate(value: string, format: TarihBicimi): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return value;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  if (format === 'YYYYAAGG') return `${y}${mo}${d}`;
  if (format === 'GG.AA.YYYY') return `${d}.${mo}.${y}`;
  return value;
}

/** The server's local calendar date of a moment, as YYYY-MM-DD. */
export function localDate(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** A value ready to write: JSON keeps numbers, XML gets text; null stays empty. */
function prepare(value: Value, tur: KaynakTuru, settings: BodySettings): string | number | null {
  if (value === null || value === undefined) return null;
  if (tur === 'tutar' || tur === 'sayi') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    if (tur === 'tutar') {
      const cents = Math.round(n * 100) / 100;
      return settings.bicim === 'xml' ? cents.toFixed(2) : cents;
    }
    return settings.bicim === 'xml' ? String(n) : n;
  }
  const text = String(value);
  return tur === 'tarih' ? formatDate(text, settings.tarihBicimi) : text;
}

// Characters XML 1.0 does not allow at all; they are dropped.
const XML_INVALID = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu;
const XML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function xmlText(value: string): string {
  return value.replace(XML_INVALID, '').replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

export function contentTypeOf(bicim: Bicim): string {
  return bicim === 'xml' ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8';
}

interface Resolved {
  readonly alias: string;
  readonly value: string | number | null;
}

function resolveRows(rows: readonly AlanEslemesi[], values: Readonly<Record<string, Value>>, catalog: Catalog, settings: BodySettings): Resolved[] {
  return rows.map((row) => {
    if (isConstant(row.kaynak)) return { alias: row.alias, value: row.deger ?? '' };
    const tur = findSource(catalog, row.kaynak)?.tur ?? 'metin';
    return { alias: row.alias, value: prepare(values[row.kaynak] ?? null, tur, settings) };
  });
}

/**
 * The body for `data`. The caller has checked the mapping (checkMapping); a source missing from the
 * catalog is written as text. Form-level rows come first, then the receipt list when any row is at
 * receipt level.
 */
export function renderBody(settings: BodySettings, alanlar: readonly AlanEslemesi[], catalog: Catalog, data: PayloadData): string {
  const formRows = alanlar.filter((r) => levelOf(r.kaynak) === 'form');
  const receiptRows = alanlar.filter((r) => levelOf(r.kaynak) === 'fis');
  const head = resolveRows(formRows, data.form, catalog, settings);
  const receipts = receiptRows.length === 0 ? null : data.fisler.map((values) => resolveRows(receiptRows, values, catalog, settings));
  return settings.bicim === 'xml' ? renderXml(settings, head, receipts) : renderJson(settings, head, receipts);
}

function renderJson(settings: BodySettings, head: readonly Resolved[], receipts: readonly (readonly Resolved[])[] | null): string {
  // Aliases never start with a digit, so the key order is the mapping order.
  const body: Record<string, unknown> = {};
  for (const r of head) body[r.alias] = r.value;
  if (receipts !== null) body[settings.fisListesi] = receipts.map((rows) => Object.fromEntries(rows.map((r) => [r.alias, r.value])));
  return JSON.stringify(settings.kok === null ? body : { [settings.kok]: body }, null, 2);
}

function renderXml(settings: BodySettings, head: readonly Resolved[], receipts: readonly (readonly Resolved[])[] | null): string {
  const element = (indent: string, r: Resolved): string => {
    const value = r.value === null ? '' : xmlText(String(r.value));
    return value === '' ? `${indent}<${r.alias}/>` : `${indent}<${r.alias}>${value}</${r.alias}>`;
  };
  const kok = settings.kok ?? 'Masraf';
  const root = settings.xmlAdAlani === null ? kok : `ns0:${kok}`;
  const open = settings.xmlAdAlani === null ? `<${root}>` : `<${root} xmlns:ns0="${xmlText(settings.xmlAdAlani)}">`;
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', open, ...head.map((r) => element('  ', r))];
  if (receipts !== null) {
    if (receipts.length === 0) lines.push(`  <${settings.fisListesi}/>`);
    else {
      lines.push(`  <${settings.fisListesi}>`);
      for (const rows of receipts) lines.push(`    <${settings.fisOgesi}>`, ...rows.map((r) => element('      ', r)), `    </${settings.fisOgesi}>`);
      lines.push(`  </${settings.fisListesi}>`);
    }
  }
  lines.push(`</${root}>`);
  return lines.join('\n');
}

// ---------- Sample data for the preview ----------

const SAMPLE_FORM: Readonly<Record<string, Value>> = {
  'form.no': 1001,
  'form.baslik': 'Müşteri ziyareti',
  'form.aciklama': 'İzmir müşteri ziyareti masrafları',
  'form.masrafTarihi': '2026-11-05',
  'form.tutar': 2193.39,
  'form.paraBirimi': 'TRY',
  'form.kur': null,
  'form.yerelTutar': 2193.39,
  'form.onayTutari': 2193.39,
  'form.satici': 'Örnek Lokanta',
  'form.durum': 'onaylandi',
  'form.kategori': 'Yemek',
  'form.kategoriKodu': 'YMK',
  'form.hesapKodu': '7701001',
  'form.masrafMerkezi': '11033106',
  'form.masrafMerkeziAciklama': 'Satış Ege',
  'form.organizasyon': '1000',
  'form.organizasyonAdi': 'Örnek A.Ş.',
  'form.gonderen': 'Ayşe Kaya',
  'form.gonderenEposta': 'ayse@firma.com',
  'form.departman': 'Satış',
  'form.gonderimTarihi': '2026-11-06',
  'form.onayTarihi': '2026-11-07',
  'form.odemeTarihi': null,
  'form.sonOnaylayan': 'Mehmet Demir',
  'form.fisSayisi': 2,
};

const SAMPLE_INVOICES: ReadonlyArray<Readonly<Record<string, Value>>> = [
  {
    'fis.sira': 1,
    'fis.kimlik': '20261105-163012-0b9c44d1',
    'fis.dosyaAdi': 'yemek.jpg',
    'fis.faturaNo': 'ABC2026000123',
    'fis.faturaTarihi': '2026-11-05',
    'fis.saticiUnvan': 'Örnek Lokanta',
    'fis.saticiVergiNo': '1234567890',
    'fis.aliciUnvan': 'Örnek A.Ş.',
    'fis.aliciVergiNo': '9876543210',
    'fis.paraBirimi': 'TRY',
    'fis.araToplam': 1525.42,
    'fis.kdvToplam': 274.58,
    'fis.genelToplam': 1800,
    'fis.yerelKarsilik': null,
    'fis.yerelTutar': 1800,
  },
  {
    'fis.sira': 2,
    'fis.kimlik': '20261105-171544-7d1e09aa',
    'fis.dosyaAdi': 'taksi.pdf',
    'fis.faturaNo': 'TX2026000045',
    'fis.faturaTarihi': '2026-11-05',
    'fis.saticiUnvan': 'Örnek Taksi',
    'fis.saticiVergiNo': '5556667770',
    'fis.aliciUnvan': 'Örnek A.Ş.',
    'fis.aliciVergiNo': '9876543210',
    'fis.paraBirimi': 'TRY',
    'fis.araToplam': 364.58,
    'fis.kdvToplam': 28.81,
    'fis.genelToplam': 393.39,
    'fis.yerelKarsilik': null,
    'fis.yerelTutar': 393.39,
  },
];

const SAMPLE_BY_TYPE: Readonly<Record<KaynakTuru, Value>> = { metin: 'ORNEK', sayi: 1, tutar: 100, tarih: '2026-11-05' };

/** Made-up values for every source, so a mapping can be previewed before any form is approved. */
export function sampleData(catalog: Catalog): PayloadData {
  const fisler = SAMPLE_INVOICES.map((invoice) => {
    const values: Record<string, Value> = { ...invoice };
    for (const k of catalog.fis) {
      if (k.anahtar in values || isConstant(k.anahtar)) continue;
      values[k.anahtar] = k.anahtar.endsWith('.ad') ? `Örnek ${k.ad.replace(/ \(açıklama\)$/, '')}` : SAMPLE_BY_TYPE[k.tur];
    }
    return values;
  });
  return { form: SAMPLE_FORM, fisler };
}
