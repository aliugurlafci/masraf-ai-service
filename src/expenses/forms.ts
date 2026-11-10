import type sql from 'mssql';
import { formatMoney, MAX_AMOUNT, planApprovals, type PlannedStep } from '../approval/flow.ts';
import { loadFlowById, loadUserFlow, type AkisOzet, type RoutingFlow } from '../approval/flow-store.ts';
import { dateOnly, execute, iso, isUniqueViolation, p, query, queryOne, SQL_ERROR, sqlErrorNumber, transaction, type Db, type Executor, type Param } from '../db/sql.ts';
import { loadDefinitions, type Definitions } from '../definitions/fields.ts';
import { display } from '../definitions/display.ts';
import { conflict, forbidden, HttpError, notFound } from '../errors.ts';
import { duplicateKey, FIELD_LABELS, mergeCorrections, missingFields } from '../invoice/effective.ts';
import { InvoiceSchema, type Invoice } from '../invoice/schema.ts';
import {
  COST_CENTRE_KEY,
  formRequiredFields,
  headerKeys,
  isEntryField,
  missingReceiptFields,
  parseReceiptValue,
  receiptOrder,
  receiptRequiredFields,
  ruleValue,
  sameValue,
  valueView,
  type AlanDegeri,
  type FieldDef,
  type FormContext,
  type ReceiptValues,
  type StoredValue,
} from './field-rules.ts';
import { cleanFileName } from '../invoice/storage.ts';
import type { FormRef, NotificationEvent } from '../notifications/events.ts';
import { activeAccountants, NO_MAIL, notify, type NotifySettings } from '../notifications/store.ts';
import type { ReadingStatus } from '../reading/reader.ts';
import type { Simge } from './categories.ts';
import { renderApprovalPdf, type PdfData } from './pdf.ts';
import {
  amountMismatch,
  approvalAmount,
  FORM_STATES,
  invoicesFormTotal,
  isPrivileged,
  localAmount,
  MAX_INVOICES,
  needsEquivalent,
  permissions,
  type Actor,
  type AdimDurum,
  type FormDurum,
  type InvoiceTotal,
  type Izinler,
} from './rules.ts';

export interface KisiOzet {
  readonly id: number;
  readonly adSoyad: string;
}

/** A cost centre as forms show it. */
export interface MasrafMerkeziOzet {
  readonly id: number;
  readonly kod: string;
  readonly aciklama: string | null;
  readonly gosterim: string;
  readonly aktif: boolean;
}

/** An organisation as forms show it. */
export interface OrganizasyonOzet {
  readonly id: number;
  readonly kod: string;
  readonly ad: string;
  readonly aktif: boolean;
}

export interface MasrafOzet {
  readonly id: number;
  readonly baslik: string;
  readonly kategori: { readonly id: number; readonly ad: string; readonly simge: Simge };
  readonly masrafTarihi: string;
  readonly satici: string | null;
  /** Null only on a draft whose amount was left for its invoices to fill. */
  readonly tutar: number | null;
  readonly paraBirimi: string;
  readonly yerelTutar: number | null;
  readonly durum: FormDurum;
  readonly olusturan: KisiOzet;
  readonly olusturma: string;
  readonly gonderim: string | null;
  /** The form's cost centre; null when none is chosen. */
  readonly masrafMerkezi: MasrafMerkeziOzet | null;
  /** The owner's organisation, as of the owner's last save or send; null when they have none. */
  readonly organizasyon: OrganizasyonOzet | null;
  readonly siradakiOnayci: KisiOzet | null;
  /** Invoice record ids in the order they were added; empty for a form without invoices. */
  readonly faturaIdler: readonly string[];
  /** Files of the form not read yet (bekleyen) or whose read failed (hatali); null when there are none. */
  readonly okuma: { readonly bekleyen: number; readonly hatali: number } | null;
}

export interface OnayAdimi {
  readonly id: number;
  readonly tur: number;
  readonly sira: number;
  readonly onayci: KisiOzet;
  readonly altLimit: number;
  readonly ustLimit: number | null;
  readonly durum: AdimDurum;
  readonly aciklama: string | null;
  readonly kararTarihi: string | null;
  readonly yedek: boolean;
}

export interface GecmisSatiri {
  readonly islem: string;
  readonly kullanici: KisiOzet | null;
  readonly aciklama: string | null;
  readonly tarih: string;
}

export interface FaturaOzeti {
  readonly id: string;
  readonly dosyaAdi: string;
  /** SHA-256 of the file read, as in bekleyenFaturalar: which waiting file became this invoice. Null for old records. */
  readonly dosyaOzeti: string | null;
  readonly dosyaVar: boolean;
  readonly mime: string | null;
  readonly faturaNo: string | null;
  readonly faturaTarihi: string | null;
  readonly saticiUnvan: string | null;
  readonly genelToplam: number | null;
  readonly paraBirimi: string | null;
  /** Base-currency equivalent the sender entered; set only while the invoice needs one. */
  readonly yerelKarsilik: number | null;
  /** The invoice is in a third currency: the form cannot be sent without `yerelKarsilik`. */
  readonly karsilikGerekli: boolean;
  // The fields above that come from the invoice and these are its effective data (the correction, if any).
  readonly saticiVergiNo: string | null;
  readonly aliciUnvan: string | null;
  readonly aliciVergiNo: string | null;
  readonly araToplam: number | null;
  readonly kdvToplam: number | null;
  readonly kalemler: Invoice['kalemler'];
  /** The user corrected the invoice on this form. */
  readonly duzeltildi: boolean;
  /** The read result while the invoice is corrected, else null. */
  readonly okunan: Invoice | null;
  /** Receipt field values entered for this invoice (active fields), by field key. */
  readonly alanlar: Readonly<Record<string, AlanDegeri>>;
  /** Required fields that are empty: header fields in the effective data first, then receipt fields. */
  readonly eksikAlanlar: readonly string[];
}

/** A file added to the form before it was read (docs/onay-sistemi.md, section 3, "Arka planda okuma"). */
export interface BekleyenFatura {
  readonly dosyaOzeti: string;
  readonly dosyaAdi: string;
  readonly mime: string;
  readonly boyut: number;
  readonly eklenme: string;
  /** sirada: waits for a free reader; okunuyor: Claude reads it now; hata: the read failed. */
  readonly durum: 'sirada' | 'okunuyor' | 'hata';
  /** While sirada and placed: its place among the files waiting for Claude (1 = next). */
  readonly kuyrukSirasi: number | null;
  /** Files read before it (being read now or waiting ahead); set together with kuyrukSirasi. */
  readonly onundeki: number | null;
  readonly hata: { readonly kod: string; readonly mesaj: string } | null;
  /** Receipt field values entered for this file (active fields), by field key. */
  readonly alanlar: Readonly<Record<string, AlanDegeri>>;
  /** Required receipt fields that are empty (header fields are not known before the read). */
  readonly eksikAlanlar: readonly string[];
}

export interface MasrafDetay extends MasrafOzet {
  readonly aciklama: string | null;
  readonly kur: number | null;
  readonly onayTutari: number | null;
  readonly tur: number;
  readonly sonuclanma: string | null;
  readonly odeme: string | null;
  readonly guncelleme: string;
  readonly faturalar: readonly FaturaOzeti[];
  /** Once no file waits any more, the server tries to send the form for approval. */
  readonly okununcaGonder: boolean;
  /** Form-level required fields missing now; only "masrafMerkezi" can be one. */
  readonly eksikAlanlar: readonly string[];
  readonly bekleyenFaturalar: readonly BekleyenFatura[];
  readonly tutarFarki: { readonly fatura: number; readonly beyan: number } | null;
  readonly onaylar: readonly OnayAdimi[];
  readonly gecmis: readonly GecmisSatiri[];
  readonly izinler: Izinler;
}

export interface FormInput {
  readonly baslik: string;
  readonly kategoriId: number;
  readonly masrafTarihi: string;
  /** Left out or null on a draft: the invoices fill it once they are read. */
  readonly tutar?: number | null | undefined;
  readonly paraBirimi?: string | undefined;
  readonly kur?: number | null | undefined;
  readonly satici?: string | null | undefined;
  readonly aciklama?: string | null | undefined;
  /** The whole invoice list; on update it replaces the form's invoices, left out it keeps them. */
  readonly faturaIdler?: readonly string[] | undefined;
  /**
   * Base-currency equivalents by invoice id, for invoices in a third currency. On update it replaces
   * them all; left out, the equivalents of the invoices still on the form stay.
   */
  readonly yerelKarsiliklar?: Readonly<Record<string, number>> | undefined;
  /**
   * Corrections by invoice id: a value replaces the invoice's correction on this form, null removes it,
   * invoices left out keep theirs. Only for invoices on the form after `faturaIdler` is applied.
   */
  readonly faturaDuzeltmeleri?: Readonly<Record<string, Invoice | null>> | undefined;
  /**
   * SHA-256 of files still being read that the form waits for; on update it replaces the waiting files,
   * left out it keeps them. A file read meanwhile joins the invoice list instead.
   */
  readonly bekleyenFaturalar?: readonly string[] | undefined;
  /** Send the form for approval once no file waits any more. */
  readonly okununcaGonder?: boolean | undefined;
  /**
   * The form's cost centre: one assigned to the owner and active, or null. On update, left out keeps it;
   * on create, left out picks the owner's only active cost centre.
   */
  readonly masrafMerkeziId?: number | null | undefined;
  /**
   * Receipt field values by receipt (an invoice id or a file's SHA-256), each replacing that receipt's
   * values of the active receipt fields. Receipts left out keep theirs.
   */
  readonly fisAlanlari?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
}

export type FormPatch = Partial<FormInput>;

export interface ListQuery {
  readonly kapsam: 'benim' | 'tumu';
  readonly durum?: readonly FormDurum[] | undefined;
  readonly q?: string | undefined;
  readonly sayfa: number;
  readonly adet: number;
}

export interface Onizleme {
  readonly onayTutari: number;
  readonly paraBirimi: string;
  /** The flow the expense would go to. */
  readonly akis: AkisOzet | null;
  readonly adimlar: ReadonlyArray<{ readonly sira: number; readonly onayci: KisiOzet; readonly durum: PlannedStep['durum']; readonly yedek: boolean }>;
  /** Set when nobody could approve such a form. */
  readonly uyari: string | null;
}

export interface Ozet {
  readonly paraBirimi: string;
  readonly benim: Readonly<Record<'taslak' | 'onayda' | 'onaylandi' | 'reddedildi' | 'odendi', number>> & {
    readonly buAyToplam: number;
    readonly bekleyenTutar: number;
  };
  readonly bekleyenOnay: number;
  readonly sonMasraflar: readonly MasrafOzet[];
  readonly genel: {
    readonly onayda: number;
    readonly odemeBekleyen: number;
    readonly odemeBekleyenTutar: number;
    readonly buAyOnaylanan: number;
  } | null;
}

export interface ExportRow extends MasrafOzet {
  readonly kur: number | null;
  readonly departman: string | null;
  readonly sonuclanma: string | null;
  readonly odeme: string | null;
  /** Invoice numbers of the form, comma separated; null when none was read. */
  readonly faturaNo: string | null;
}

interface FormRow {
  id: number;
  olusturan_id: number;
  olusturan_ad: string;
  baslik: string;
  aciklama: string | null;
  kategori_id: number;
  kategori_ad: string;
  kategori_simge: Simge;
  masraf_tarihi: Date;
  satici: string | null;
  tutar: number | null;
  para_birimi: string;
  kur: number | null;
  yerel_tutar: number | null;
  onay_tutari: number | null;
  okununca_gonder: boolean;
  /** Waiting (bekliyor) and failed (hata) files of the form; null when it has none. */
  okuma_bekleyen: number | null;
  okuma_hatali: number | null;
  /** Invoice record ids, comma separated, in order; null without invoices. */
  fatura_idler: string | null;
  durum: FormDurum;
  tur: number;
  olusturma: Date;
  guncelleme: Date;
  gonderim: Date | null;
  sonuclanma: Date | null;
  odeme: Date | null;
  bekleyen_onayci_id: number | null;
  bekleyen_onayci_ad: string | null;
  masraf_merkezi_id: number | null;
  mm_kod: string | null;
  mm_aciklama: string | null;
  mm_aktif: boolean | null;
  organizasyon_id: number | null;
  org_kod: string | null;
  org_ad: string | null;
  org_aktif: boolean | null;
}

/** A receipt field value of an invoice or a waiting file, with its option's text. */
interface ValueRow {
  alan_id: number;
  secenek_id: number | null;
  metin: string | null;
  secenek_kod: string | null;
  secenek_ad: string | null;
}

/** One stored value of a receipt, by field id. */
type FieldValue = StoredValue & { readonly alanId: number; readonly optionText: string | null };

/** A file of the form waiting to be read, or whose read failed (bekleyen_faturalar, without its bytes). */
interface WaitingRow {
  id: number;
  dosya_ozeti: string;
  dosya_adi: string;
  mime: string;
  boyut: number;
  durum: 'bekliyor' | 'hata';
  hata_kodu: string | null;
  hata_mesaji: string | null;
  olusturma: Date;
}

/** What a save does to the waiting files and the invoice list (planWaiting). */
interface WaitingPlan {
  /** The invoice list, with the files read meanwhile at its end. */
  readonly invoices: string[];
  /** The `alanlar` key of each invoice, for errors about it. */
  readonly fields: string[];
  /** Files still being read that start waiting on the form, with their bytes. */
  readonly add: Array<{ readonly hash: string; readonly buffer: Buffer; readonly mime: string; readonly name: string }>;
  /** Waiting files taken off the form. */
  readonly drop: number[];
  /** Waiting files the form has after the save. */
  readonly count: number;
}

const FORM_COLUMNS = `f.id, f.olusturan_id, u.ad_soyad AS olusturan_ad, f.baslik, f.aciklama, f.kategori_id,
  k.ad AS kategori_ad, k.simge AS kategori_simge, f.masraf_tarihi, f.satici, f.tutar, f.para_birimi, f.kur,
  f.yerel_tutar, f.onay_tutari, f.okununca_gonder, ok.bekleyen AS okuma_bekleyen, ok.hatali AS okuma_hatali,
  (SELECT STRING_AGG(ff.kayit_id, ',') WITHIN GROUP (ORDER BY ff.sira) FROM dbo.form_faturalari ff WHERE ff.form_id = f.id) AS fatura_idler,
  f.durum, f.tur, f.olusturma, f.guncelleme, f.gonderim,
  f.sonuclanma, f.odeme, b.onayci_id AS bekleyen_onayci_id, bu.ad_soyad AS bekleyen_onayci_ad,
  f.masraf_merkezi_id, mm.kod AS mm_kod, mm.aciklama AS mm_aciklama, mm.aktif AS mm_aktif,
  f.organizasyon_id, org.kod AS org_kod, org.ad AS org_ad, org.aktif AS org_aktif`;

// At most one step per form is 'bekliyor' (unique filtered index), so the join never repeats a form.
const formFrom = (lock: boolean): string => `
  FROM dbo.masraf_formlari f ${lock ? 'WITH (UPDLOCK, ROWLOCK)' : ''}
  JOIN dbo.kullanicilar u ON u.id = f.olusturan_id
  JOIN dbo.masraf_kategorileri k ON k.id = f.kategori_id
  LEFT JOIN dbo.masraf_merkezleri mm ON mm.id = f.masraf_merkezi_id
  LEFT JOIN dbo.organizasyonlar org ON org.id = f.organizasyon_id
  LEFT JOIN dbo.form_onaylari b ON b.form_id = f.id AND b.durum = 'bekliyor'
  LEFT JOIN dbo.kullanicilar bu ON bu.id = b.onayci_id
  OUTER APPLY (SELECT SUM(CASE WHEN bf.durum = 'bekliyor' THEN 1 ELSE 0 END) AS bekleyen,
                      SUM(CASE WHEN bf.durum = 'hata' THEN 1 ELSE 0 END) AS hatali
               FROM dbo.bekleyen_faturalar bf WHERE bf.form_id = f.id) ok`;

const num = (v: number | null): number | null => (v === null ? null : Number(v));

/** Columns of fatura_kayitlari (alias r) an invoice's read result is built from. */
const READ_COLUMNS = 'r.sonuc, r.fatura_no, r.fatura_tarihi, r.satici_unvan, r.genel_toplam, r.para_birimi';

interface ReadRow {
  sonuc: string;
  fatura_no: string | null;
  fatura_tarihi: Date | null;
  satici_unvan: string | null;
  genel_toplam: number | null;
  para_birimi: string | null;
}

/** Invoice JSON from the database, or null when it is missing or no longer fits the schema. */
function parseInvoice(text: string | null): Invoice | null {
  if (text === null) return null;
  try {
    const parsed = InvoiceSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The read result; a record whose JSON no longer fits the schema falls back to its list columns. */
function readResult(r: ReadRow): Invoice {
  return (
    parseInvoice(r.sonuc) ?? {
      fatura: {
        faturaNo: r.fatura_no,
        faturaTarihi: dateOnly(r.fatura_tarihi),
        saticiUnvan: r.satici_unvan,
        saticiVergiNo: null,
        aliciUnvan: null,
        aliciVergiNo: null,
        paraBirimi: r.para_birimi,
        araToplam: null,
        kdvToplam: null,
        genelToplam: r.genel_toplam,
      },
      kalemler: [],
    }
  );
}

/** One invoice on a form: its read result, the user's correction on this form and the entered equivalent. */
interface FormInvoice {
  readonly id: string;
  readonly dosyaAdi: string;
  readonly dosyaOzeti: string | null;
  readonly mime: string | null;
  readonly read: Invoice;
  readonly correction: Invoice | null;
  readonly yerelKarsilik: number | null;
}

/** The data every calculation of the form uses: the correction when there is one, else the read result. */
const effectiveOf = (x: Pick<FormInvoice, 'read' | 'correction'>): Invoice => x.correction ?? x.read;

const totalOf = (invoice: Invoice, yerelKarsilik: number | null = null): InvoiceTotal & { yerelKarsilik: number | null } => ({
  genelToplam: invoice.fatura.genelToplam,
  paraBirimi: invoice.fatura.paraBirimi,
  yerelKarsilik,
});

/** Lines of at most 500 characters (form_gecmisi.aciklama) for the history, so a long note is not cut. */
function historyNotes(parts: readonly string[]): Array<string | null> {
  const lines: string[] = [];
  for (const part of parts) {
    const last = lines.length - 1;
    if (last >= 0 && (lines[last] as string).length + 1 + part.length <= 500) lines[last] = `${lines[last]} ${part}`;
    else lines.push(part);
  }
  return lines.length === 0 ? [null] : lines;
}

/** The field definitions of one request, looked up by id and key, with the active receipt fields in order. */
interface FieldContext {
  readonly defs: Definitions;
  readonly byId: ReadonlyMap<number, FieldDef>;
  readonly byKey: ReadonlyMap<string, FieldDef>;
  /** The receipt fields a sender fills in that are active, in display order. */
  readonly entry: readonly FieldDef[];
}

function fieldContext(defs: Definitions): FieldContext {
  return {
    defs,
    byId: new Map(defs.fields.map((f) => [f.id, f])),
    byKey: new Map(defs.fields.map((f) => [f.anahtar, f])),
    entry: defs.fields.filter((f) => f.aktif && isEntryField(f)).sort(receiptOrder),
  };
}

const formOf = (r: Pick<FormRow, 'kategori_id' | 'masraf_merkezi_id'>): FormContext => ({ kategoriId: r.kategori_id, masrafMerkeziId: r.masraf_merkezi_id });

const toFieldValue = (r: ValueRow): FieldValue =>
  r.secenek_id !== null
    ? { alanId: r.alan_id, secenekId: r.secenek_id, metin: null, optionText: r.secenek_kod === null ? null : display(r.secenek_kod, r.secenek_ad) }
    : { alanId: r.alan_id, secenekId: null, metin: r.metin ?? '', optionText: null };

function groupValues<R extends ValueRow, K>(rows: readonly R[], keyOf: (r: R) => K): Map<K, FieldValue[]> {
  const out = new Map<K, FieldValue[]>();
  for (const r of rows) {
    const key = keyOf(r);
    const list = out.get(key) ?? [];
    list.push(toFieldValue(r));
    out.set(key, list);
  }
  return out;
}

/** A receipt's values by field key, as the rules read them (src/expenses/field-rules.ts). */
function valuesByKey(ctx: FieldContext, values: readonly FieldValue[] | undefined): ReceiptValues {
  const out: Record<string, number | string> = {};
  for (const v of values ?? []) {
    const f = ctx.byId.get(v.alanId);
    if (f !== undefined) out[f.anahtar] = ruleValue(v);
  }
  return out;
}

/** The API view of a receipt's values: active receipt fields only, in field order. */
function valuesView(ctx: FieldContext, values: readonly FieldValue[] | undefined): Record<string, AlanDegeri> {
  const out: Record<string, AlanDegeri> = {};
  for (const f of ctx.entry) {
    const v = values?.find((x) => x.alanId === f.id);
    if (v !== undefined) out[f.anahtar] = valueView(f.tur, v, v.optionText);
  }
  return out;
}

/** The required fields of one receipt and those empty on it. `header` is null for a file not read yet. */
function receiptCheck(ctx: FieldContext, form: FormContext, values: readonly FieldValue[] | undefined, header: Invoice['fatura'] | null): { required: FieldDef[]; missing: string[] } {
  const byKey = valuesByKey(ctx, values);
  const required = receiptRequiredFields(ctx.defs.fields, ctx.defs.rules, form, byKey);
  return { required, missing: missingReceiptFields(required, byKey, header) };
}

/** A file waiting on the form after a save (kept or new), which `fisAlanlari` may name by its SHA-256. */
interface WaitingTarget {
  readonly hash: string;
  readonly name: string;
  /** Its bekleyen_faturalar row; null for a file this save adds. */
  readonly id: number | null;
}

/** What `fisAlanlari` does to a form's receipts (planReceipts). */
interface ReceiptPlan {
  /** The values of every invoice on the form after the save; setInvoices writes them back. */
  readonly invoices: Map<string, FieldValue[]>;
  /** The whole new value set of each waiting file the request names, by SHA-256. */
  readonly waiting: Map<string, FieldValue[]>;
  /** "1. faturanın alanları değişti: Etiket." for the history. */
  readonly notes: string[];
}

const HASH = /^[a-f0-9]{64}$/;

function toSummary(r: FormRow): MasrafOzet {
  return {
    id: r.id,
    baslik: r.baslik,
    kategori: { id: r.kategori_id, ad: r.kategori_ad, simge: r.kategori_simge },
    masrafTarihi: dateOnly(r.masraf_tarihi) ?? '',
    satici: r.satici,
    tutar: num(r.tutar),
    paraBirimi: r.para_birimi,
    yerelTutar: num(r.yerel_tutar),
    durum: r.durum,
    olusturan: { id: r.olusturan_id, adSoyad: r.olusturan_ad },
    olusturma: iso(r.olusturma) ?? '',
    gonderim: iso(r.gonderim),
    masrafMerkezi:
      r.masraf_merkezi_id === null || r.mm_kod === null
        ? null
        : { id: r.masraf_merkezi_id, kod: r.mm_kod, aciklama: r.mm_aciklama, gosterim: display(r.mm_kod, r.mm_aciklama), aktif: r.mm_aktif === true },
    organizasyon:
      r.organizasyon_id === null || r.org_kod === null ? null : { id: r.organizasyon_id, kod: r.org_kod, ad: r.org_ad ?? '', aktif: r.org_aktif === true },
    siradakiOnayci: r.durum === 'onayda' && r.bekleyen_onayci_id !== null ? { id: r.bekleyen_onayci_id, adSoyad: r.bekleyen_onayci_ad ?? '' } : null,
    faturaIdler: invoiceIdsOf(r),
    okuma: waitingOf(r).bekleyen + waitingOf(r).hatali === 0 ? null : waitingOf(r),
  };
}

/** The form's waiting and failed files, from its row. */
const waitingOf = (r: FormRow): { bekleyen: number; hatali: number } => ({ bekleyen: r.okuma_bekleyen ?? 0, hatali: r.okuma_hatali ?? 0 });

const invoiceIdsOf = (r: FormRow): string[] => (r.fatura_idler === null || r.fatura_idler === '' ? [] : r.fatura_idler.split(','));

const facts = (r: FormRow): { durum: FormDurum; olusturanId: number; bekleyenOnayciId: number | null } => ({
  durum: r.durum,
  olusturanId: r.olusturan_id,
  bekleyenOnayciId: r.bekleyen_onayci_id,
});

const STATE_NAMES: Record<FormDurum, string> = {
  taslak: 'taslak',
  onayda: 'onayda',
  onaylandi: 'onaylandı',
  reddedildi: 'reddedildi',
  iptal: 'iptal edildi',
  odendi: 'ödendi',
};

/** Why `actor` may not do `action` on this form, as the matching HTTP error. */
function refusal(action: keyof Izinler, row: FormRow, actor: Actor): HttpError {
  const wrongState = conflict('gecersiz_durum', `Form "${STATE_NAMES[row.durum]}" durumunda; bu işlem yapılamaz.`);
  switch (action) {
    case 'duzenle':
    case 'gonder':
    case 'geriCek':
    case 'iptal':
      return row.olusturan_id === actor.id ? wrongState : forbidden('Bu işlemi yalnızca formu oluşturan kişi yapabilir.');
    case 'onayla':
    case 'reddet':
      return notWaiting();
    case 'odendi':
      return isPrivileged(actor) ? wrongState : forbidden('Ödeme işaretini yalnızca muhasebe veya yönetici koyabilir.');
    case 'devret':
      return actor.rol === 'yonetici' ? wrongState : forbidden('Onayı yalnızca yönetici devredebilir.');
  }
}

const notWaiting = (): HttpError => conflict('onay_beklemiyor', 'Bu masraf formu sizin onayınızı beklemiyor.');

const fieldError = (alan: string, mesaj: string): HttpError => new HttpError(400, 'gecersiz_istek', mesaj, { alanlar: { [alan]: mesaj } });

/** Today's date where the server runs (the service is local, so this is the user's day). */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfMonth(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

const likePattern = (q: string): string => `%${q.replace(/[%_[]/g, '[$&]')}%`;

interface CheckedInput {
  readonly baslik: string;
  readonly kategoriId: number;
  readonly masrafTarihi: string;
  readonly tutar: number | null;
  readonly paraBirimi: string;
  readonly kur: number | null;
  readonly yerelTutar: number | null;
  readonly satici: string | null;
  readonly aciklama: string | null;
}

export interface ExpenseService {
  list(actor: Actor, q: ListQuery): Promise<{ kayitlar: MasrafOzet[]; toplam: number; sayfa: number; adet: number }>;
  detail(id: number, actor: Actor): Promise<MasrafDetay>;
  create(actor: Actor, input: FormInput, gonder: boolean): Promise<MasrafDetay>;
  update(id: number, actor: Actor, patch: FormPatch): Promise<MasrafDetay>;
  submit(id: number, actor: Actor): Promise<MasrafDetay>;
  withdraw(id: number, actor: Actor): Promise<MasrafDetay>;
  cancel(id: number, actor: Actor): Promise<MasrafDetay>;
  approve(id: number, actor: Actor, aciklama: string | null): Promise<MasrafDetay>;
  reject(id: number, actor: Actor, aciklama: string): Promise<MasrafDetay>;
  markPaid(id: number, actor: Actor): Promise<MasrafDetay>;
  reassign(id: number, actor: Actor, onayId: number, yeniOnayciId: number): Promise<MasrafDetay>;
  /** `akisId` (administrators only) tries a saved flow instead of the actor's own. */
  preview(
    actor: Actor,
    input: {
      tutar: number;
      paraBirimi?: string | undefined;
      kur?: number | null | undefined;
      faturaIdler?: readonly string[] | undefined;
      yerelKarsiliklar?: Readonly<Record<string, number>> | undefined;
      faturaDuzeltmeleri?: Readonly<Record<string, Invoice | null>> | undefined;
      akisId?: number | undefined;
    },
  ): Promise<Onizleme>;
  inbox(actor: Actor, durum: 'bekleyen' | 'karar'): Promise<MasrafOzet[]>;
  pendingCount(actor: Actor): Promise<number>;
  summary(actor: Actor): Promise<Ozet>;
  exportRows(actor: Actor, filter: { durum?: readonly FormDurum[] | undefined; baslangic?: string | undefined; bitis?: string | undefined }): Promise<ExportRow[]>;
  /** The approval document, for whoever may see the form; only while it is onaylandi or odendi. */
  pdf(id: number, actor: Actor): Promise<Buffer>;
  /** The approval document for a queued mail, from the form as it is now; null when the form is gone. */
  pdfForMail(id: number): Promise<Buffer | null>;
  /** Puts the form's failed files back in the reading queue (owner, editable form). */
  retryReads(id: number, actor: Actor): Promise<MasrafDetay>;
  /** Waiting files to read (without their bytes): those with these ids, or every waiting one (start-up). */
  waitingFiles(ids?: readonly number[]): Promise<WaitingFile[]>;
  /** The bytes of a waiting file; null once it no longer waits. */
  waitingContent(id: number): Promise<Buffer | null>;
  /**
   * Start-up: tries "okununca gönder" on forms that still have it on with nothing left to wait for (the
   * server stopped between the last read and the send). Returns how many were tried.
   */
  resumeSends(): Promise<number>;
  /**
   * The read of a waiting file ended: a read invoice joins the form, a failure stays on it. When it was
   * the form's last waiting file, empty fields are filled, the owner is told and, if asked, the form is sent.
   */
  settleWaiting(id: number, outcome: ReadOutcome): Promise<void>;
}

/** A file of a form waiting to be read (bekleyen_faturalar), as the background reader needs it. */
export interface WaitingFile {
  readonly id: number;
  readonly formId: number;
  readonly kullanici: KisiOzet;
  readonly dosyaAdi: string;
  readonly dosyaOzeti: string;
  readonly mime: string;
}

export type ReadOutcome = { readonly kayitId: string } | { readonly hata: { readonly kod: string; readonly mesaj: string } };

/** What the form service needs from the reading queue. */
export interface ReadingLink {
  /** A file `kullaniciId` sent that is still being read, by SHA-256; null when none. */
  file(dosyaOzeti: string, kullaniciId: number): { readonly buffer: Buffer; readonly mime: string; readonly name: string } | null;
  /** Where the read of this file stands; null when no read of it runs. */
  status(dosyaOzeti: string): ReadingStatus | null;
  /** Called after a commit left files waiting (new or read again), so their reads start or are joined. */
  waiting(ids: readonly number[]): void;
}

export const NO_READING: ReadingLink = { file: () => null, status: () => null, waiting: () => {} };

export interface ExpenseServiceOptions {
  readonly baseCurrency: string;
  /** Mail settings of the notifications; default: mails written as skipped. */
  readonly notifications?: NotifySettings | undefined;
  /** The reading queue; default: none (a form cannot take files that are still being read). */
  readonly reading?: ReadingLink | undefined;
}

export function createExpenseService(db: Db, opts: ExpenseServiceOptions): ExpenseService {
  const base = opts.baseCurrency;
  const mail = opts.notifications ?? NO_MAIL;
  const reading = opts.reading ?? NO_READING;

  /** What notifications say about the form, in the state it has after the action. */
  const refOf = (row: FormRow, durum: FormDurum): FormRef => ({
    id: row.id,
    baslik: row.baslik,
    sahip: { id: row.olusturan_id, adSoyad: row.olusturan_ad },
    tutar: num(row.tutar),
    paraBirimi: row.para_birimi,
    durum,
  });

  /** Writes the notifications of an action in its transaction. */
  const tell = (tx: sql.Transaction, event: NotificationEvent, actor: Actor): Promise<void> => notify(tx, event, actor.id, mail);

  async function readRow(ex: Executor, id: number, lock: boolean): Promise<FormRow | null> {
    return queryOne<FormRow>(ex, `SELECT ${FORM_COLUMNS} ${formFrom(lock)} WHERE f.id = @id`, { id: p.int(id) });
  }

  async function canSee(ex: Executor, row: FormRow, actor: Actor): Promise<boolean> {
    if (row.olusturan_id === actor.id || isPrivileged(actor)) return true;
    const hit = await queryOne(ex, 'SELECT TOP (1) 1 AS x FROM dbo.form_onaylari WHERE form_id = @f AND onayci_id = @u', {
      f: p.int(row.id),
      u: p.int(actor.id),
    });
    return hit !== null;
  }

  /** The form, locked for this transaction, or 404 when it does not exist or the actor may not see it. */
  async function lockForm(tx: sql.Transaction, id: number, actor: Actor): Promise<FormRow> {
    const row = await readRow(tx, id, true);
    if (row === null || !(await canSee(tx, row, actor))) throw notFound('Masraf formu bulunamadı.');
    return row;
  }

  async function history(ex: Executor, formId: number, kullaniciId: number | null, islem: string, aciklama: string | null = null): Promise<void> {
    await execute(ex, 'INSERT INTO dbo.form_gecmisi (form_id, kullanici_id, islem, aciklama) VALUES (@f, @k, @i, @a)', {
      f: p.int(formId),
      k: p.int(kullaniciId),
      i: p.ascii(islem, 24),
      a: p.str(aciklama === null ? null : aciklama.slice(0, 500), 500),
    });
  }

  /** Runs one state change with the form row locked, after checking the actor may do it. */
  async function act(id: number, actor: Actor, action: keyof Izinler, fn: (tx: sql.Transaction, row: FormRow) => Promise<void>): Promise<MasrafDetay> {
    await transaction(db, async (tx) => {
      const row = await lockForm(tx, id, actor);
      if (!permissions(facts(row), actor)[action]) throw refusal(action, row, actor);
      await fn(tx, row);
    });
    return detail(id, actor);
  }

  /** `@i0, @i1, …` and their parameters, for `IN (…)` over invoice record ids. */
  function idList(ids: readonly string[]): { list: string; params: Record<string, Param> } {
    return {
      list: ids.map((_, i) => `@i${i}`).join(', '),
      params: Object.fromEntries(ids.map((id, i) => [`i${i}`, p.ascii(id, 24)])),
    };
  }

  /** The read result of each invoice record in `ids`. */
  async function readInvoices(ex: Executor, ids: readonly string[]): Promise<Map<string, Invoice>> {
    if (ids.length === 0) return new Map();
    const { list, params } = idList(ids);
    const rows = await query<ReadRow & { id: string }>(ex, `SELECT r.id, ${READ_COLUMNS} FROM dbo.fatura_kayitlari r WHERE r.id IN (${list})`, params);
    return new Map(rows.map((r) => [r.id, readResult(r)]));
  }

  /** The form's invoices in order, with their corrections and the equivalents entered for them. */
  async function formInvoices(ex: Executor, formId: number): Promise<FormInvoice[]> {
    const rows = await query<
      ReadRow & { kayit_id: string; dosya_adi: string; dosya_ozeti: string | null; mime: string | null; yerel_karsilik: number | null; duzeltme: string | null }
    >(
      ex,
      `SELECT ff.kayit_id, ff.yerel_karsilik, ff.duzeltme, r.dosya_adi, r.dosya_ozeti, d.mime, ${READ_COLUMNS}
       FROM dbo.form_faturalari ff
       JOIN dbo.fatura_kayitlari r ON r.id = ff.kayit_id
       LEFT JOIN dbo.fatura_dosyalari d ON d.kayit_id = r.id
       WHERE ff.form_id = @f ORDER BY ff.sira`,
      { f: p.int(formId) },
    );
    return rows.map((r) => ({
      id: r.kayit_id,
      dosyaAdi: r.dosya_adi,
      dosyaOzeti: r.dosya_ozeti,
      mime: r.mime,
      read: readResult(r),
      correction: parseInvoice(r.duzeltme),
      yerelKarsilik: num(r.yerel_karsilik),
    }));
  }

  /**
   * The equivalents to store for `ids` on a form in `formCurrency`: only for invoices that need one,
   * judged by their effective data in `invoices`. With `strict`, an equivalent for an invoice not in
   * `ids` is refused.
   */
  function equivalentsFor(
    ids: readonly string[],
    invoices: ReadonlyMap<string, Invoice>,
    given: Readonly<Record<string, number>>,
    formCurrency: string,
    strict: boolean,
  ): Map<string, number> {
    if (strict) {
      const stray = Object.keys(given).find((id) => !ids.includes(id));
      if (stray !== undefined) fail(`yerelKarsiliklar.${stray}`, 'Bu fatura masrafta yok.');
    }
    const kept = new Map<string, number>();
    for (const id of ids) {
      const value = given[id];
      const invoice = invoices.get(id);
      if (value !== undefined && invoice !== undefined && needsEquivalent(formCurrency, base, totalOf(invoice))) kept.set(id, value);
    }
    return kept;
  }

  /**
   * The corrections the form keeps after a request (see mergeCorrections), the effective data of every
   * invoice and the history notes. A correction for an invoice that is not on the form is refused.
   */
  function correctionsFor(
    ids: readonly string[],
    reads: ReadonlyMap<string, Invoice>,
    stored: ReadonlyMap<string, Invoice>,
    given: Readonly<Record<string, Invoice | null>> | undefined,
  ): { corrections: Map<string, Invoice>; effective: Map<string, Invoice>; notes: string[] } {
    const stray = Object.keys(given ?? {}).find((id) => !ids.includes(id));
    if (stray !== undefined) fail(`faturaDuzeltmeleri.${stray}`, 'Bu fatura masrafta yok.');
    const { corrections, notes } = mergeCorrections(ids, reads, stored, given);
    const effective = new Map<string, Invoice>();
    for (const id of ids) {
      const invoice = corrections.get(id) ?? reads.get(id);
      if (invoice !== undefined) effective.set(id, invoice);
    }
    return { corrections, effective, notes };
  }

  /** The ids among `ids` that `actor` uploaded. */
  async function uploadedBy(ex: Executor, actor: Actor, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const { list, params } = idList(ids);
    const rows = await query<{ kayit_id: string }>(
      ex,
      `SELECT DISTINCT kayit_id FROM dbo.fatura_yuklemeleri WHERE kullanici_id = @u AND kayit_id IN (${list})`,
      { ...params, u: p.int(actor.id) },
    );
    return new Set(rows.map((r) => r.kayit_id));
  }

  /**
   * Each invoice must be the actor's own upload, listed once, and not claimed by another live form.
   * `fields` names each invoice in the errors (default `faturaIdler.<i>`); invoices that joined the list
   * from `bekleyenFaturalar` are named by that list.
   */
  async function checkInvoices(ex: Executor, actor: Actor, ids: readonly string[], formId: number | null, fields: readonly string[] = []): Promise<void> {
    const which = (i: number): string => (ids.length === 1 ? 'Fatura' : `${i + 1}. fatura`);
    const field = (i: number): string => fields[i] ?? `faturaIdler.${i}`;
    if (ids.length > MAX_INVOICES) fail('faturaIdler', `Bir masrafa en fazla ${MAX_INVOICES} fatura eklenebilir.`);
    const twice = ids.findIndex((id, i) => ids.indexOf(id) !== i);
    if (twice >= 0) fail(field(twice), 'Aynı fatura bir forma iki kez eklenemez.');
    if (ids.length === 0) return;
    const own = await uploadedBy(ex, actor, ids);
    const foreign = ids.findIndex((id) => !own.has(id));
    if (foreign >= 0) fail(field(foreign), `${which(foreign)} bulunamadı. Yalnızca kendi yüklediğiniz faturaları ekleyebilirsiniz.`);
    const { list, params } = idList(ids);
    const used = await query<{ kayit_id: string; form_id: number; olusturan_id: number }>(
      ex,
      `SELECT ff.kayit_id, ff.form_id, f.olusturan_id FROM dbo.form_faturalari ff JOIN dbo.masraf_formlari f ON f.id = ff.form_id
       WHERE ff.aktif = 1 AND ff.kayit_id IN (${list}) AND (@self IS NULL OR ff.form_id <> @self)`,
      { ...params, self: p.int(formId) },
    );
    if (used.length === 0) return;
    const byInvoice = new Map(used.map((u) => [u.kayit_id, u]));
    const i = ids.findIndex((id) => byInvoice.has(id));
    const hit = byInvoice.get(ids[i] ?? '');
    // Someone else who uploaded the same file must not learn their form's number.
    const where = hit !== undefined && hit.olusturan_id === actor.id ? `#${hit.form_id} numaralı masraf formunda` : 'başka bir masraf formunda';
    const mesaj = `${ids.length === 1 ? 'Bu fatura' : `${i + 1}. fatura`} ${where} kullanılıyor.`;
    throw new HttpError(409, 'fatura_kullaniliyor', mesaj, { alanlar: { [field(i)]: mesaj } });
  }

  /** The form's waiting and failed files, in the order they were added (without their bytes). */
  function waitingRows(ex: Executor, formId: number): Promise<WaitingRow[]> {
    return query<WaitingRow>(
      ex,
      `SELECT id, dosya_ozeti, dosya_adi, mime, boyut, durum, hata_kodu, hata_mesaji, olusturma
       FROM dbo.bekleyen_faturalar WHERE form_id = @f ORDER BY id`,
      { f: p.int(formId) },
    );
  }

  /** The newest record read from the file with this SHA-256 that `actor` uploaded, or null. */
  async function ownRecordOf(ex: Executor, actor: Actor, hash: string): Promise<string | null> {
    const row = await queryOne<{ id: string }>(
      ex,
      `SELECT TOP (1) r.id FROM dbo.fatura_kayitlari r
       WHERE r.dosya_ozeti = @h
         AND (r.yukleyen_id = @u OR EXISTS (SELECT 1 FROM dbo.fatura_yuklemeleri y WHERE y.kayit_id = r.id AND y.kullanici_id = @u))
       ORDER BY r.olusturma DESC, r.id DESC`,
      { h: p.ascii(hash, 64), u: p.int(actor.id) },
    );
    return row?.id ?? null;
  }

  /** The receipt field values of the form's invoices, by invoice record id. */
  async function invoiceValues(ex: Executor, formId: number): Promise<Map<string, FieldValue[]>> {
    const rows = await query<ValueRow & { kayit_id: string }>(
      ex,
      `SELECT v.kayit_id, v.alan_id, v.secenek_id, v.metin, s.kod AS secenek_kod, s.ad AS secenek_ad
       FROM dbo.fis_alan_degerleri v LEFT JOIN dbo.alan_secenekleri s ON s.id = v.secenek_id
       WHERE v.form_id = @f`,
      { f: p.int(formId) },
    );
    return groupValues(rows, (r) => r.kayit_id);
  }

  /** The receipt field values of the form's waiting files, by their bekleyen_faturalar id. */
  async function waitingValues(ex: Executor, formId: number): Promise<Map<number, FieldValue[]>> {
    const rows = await query<ValueRow & { bekleyen_id: number }>(
      ex,
      `SELECT v.bekleyen_id, v.alan_id, v.secenek_id, v.metin, s.kod AS secenek_kod, s.ad AS secenek_ad
       FROM dbo.bekleyen_alan_degerleri v
       JOIN dbo.bekleyen_faturalar b ON b.id = v.bekleyen_id
       LEFT JOIN dbo.alan_secenekleri s ON s.id = v.secenek_id
       WHERE b.form_id = @f`,
      { f: p.int(formId) },
    );
    return groupValues(rows, (r) => r.bekleyen_id);
  }

  /** `(@a0, @s0, @m0), …` rows of receipt field values and their parameters. */
  function valueRows(values: readonly FieldValue[], prefix: string): { rows: string[]; params: Record<string, Param> } {
    const params: Record<string, Param> = {};
    const rows = values.map((v, i) => {
      params[`a${i}`] = p.int(v.alanId);
      params[`s${i}`] = p.int(v.secenekId);
      params[`m${i}`] = p.str(v.metin, 1000);
      return `(${prefix}, @a${i}, @s${i}, @m${i})`;
    });
    return { rows, params };
  }

  /** Writes the receipt field values of an invoice whose link was just inserted. */
  async function insertInvoiceValues(tx: sql.Transaction, formId: number, kayitId: string, values: readonly FieldValue[]): Promise<void> {
    if (values.length === 0) return;
    const { rows, params } = valueRows(values, '@f, @k');
    await execute(tx, `INSERT INTO dbo.fis_alan_degerleri (form_id, kayit_id, alan_id, secenek_id, metin) VALUES ${rows.join(', ')}`, {
      ...params,
      f: p.int(formId),
      k: p.ascii(kayitId, 24),
    });
  }

  /** Replaces the receipt field values of the form's waiting files named in `waiting` (by SHA-256). */
  async function writeWaitingValues(tx: sql.Transaction, formId: number, waiting: ReadonlyMap<string, FieldValue[]>): Promise<void> {
    for (const [hash, values] of waiting) {
      const file = await queryOne<{ id: number }>(tx, 'SELECT id FROM dbo.bekleyen_faturalar WHERE form_id = @f AND dosya_ozeti = @h', {
        f: p.int(formId),
        h: p.ascii(hash, 64),
      });
      if (file === null) continue;
      await execute(tx, 'DELETE FROM dbo.bekleyen_alan_degerleri WHERE bekleyen_id = @b', { b: p.int(file.id) });
      if (values.length === 0) continue;
      const { rows, params } = valueRows(values, '@b');
      await execute(tx, `INSERT INTO dbo.bekleyen_alan_degerleri (bekleyen_id, alan_id, secenek_id, metin) VALUES ${rows.join(', ')}`, {
        ...params,
        b: p.int(file.id),
      });
    }
  }

  /** The SHA-256 of the file each invoice was read from, for those that have one. */
  async function fileHashes(ex: Executor, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { list, params } = idList(ids);
    const rows = await query<{ id: string; dosya_ozeti: string | null }>(ex, `SELECT id, dosya_ozeti FROM dbo.fatura_kayitlari WHERE id IN (${list})`, params);
    return new Map(rows.flatMap((r) => (r.dosya_ozeti === null ? [] : [[r.id, r.dosya_ozeti] as const])));
  }

  /**
   * What `fisAlanlari` (section 6) does to the form's receipts after this request's list changes:
   * `invoices` and `waiting` are the receipts the form has then, `storedInvoices` and `storedWaiting`
   * their values now. Each named receipt's active receipt field values are replaced; values of inactive
   * fields stay; receipts left out keep theirs. Writes nothing.
   */
  async function planReceipts(
    ex: Executor,
    ctx: FieldContext,
    given: FormInput['fisAlanlari'],
    invoices: readonly string[],
    waiting: readonly WaitingTarget[],
    storedInvoices: ReadonlyMap<string, FieldValue[]>,
    storedWaiting: ReadonlyMap<number, FieldValue[]>,
  ): Promise<ReceiptPlan> {
    const plan: ReceiptPlan = { invoices: new Map(invoices.map((id) => [id, storedInvoices.get(id) ?? []])), waiting: new Map(), notes: [] };
    if (given === undefined) return plan;

    // Which receipt each key names: an invoice by its id, or by the SHA-256 of its file (read since the
    // client last looked), else a waiting file by its SHA-256.
    const keys = Object.keys(given);
    const hashes = keys.some((k) => HASH.test(k)) ? await fileHashes(ex, invoices) : new Map<string, string>();
    const named = new Set<string>();
    const receipts = keys.map((key) => {
      let invoice = invoices.includes(key) ? key : undefined;
      let file: WaitingTarget | undefined;
      if (invoice === undefined && HASH.test(key)) {
        invoice = invoices.find((id) => hashes.get(id) === key);
        if (invoice === undefined) file = waiting.find((w) => w.hash === key);
      }
      if (invoice === undefined && file === undefined) fail(`fisAlanlari.${key}`, 'Bu fiş formda yok.');
      const which = invoice !== undefined ? `fatura:${invoice}` : `dosya:${(file as WaitingTarget).hash}`;
      if (named.has(which)) fail(`fisAlanlari.${key}`, 'Bu fiş istekte iki kez yazılmış.');
      named.add(which);
      const stored = invoice !== undefined ? (storedInvoices.get(invoice) ?? []) : file?.id === null ? [] : (storedWaiting.get(file?.id as number) ?? []);
      return { key, invoice, file, stored, values: new Map<number, StoredValue>() };
    });

    // The values, checked by their field's type.
    for (const r of receipts) {
      for (const [fieldKey, raw] of Object.entries(given[r.key] ?? {})) {
        const field = ctx.byKey.get(fieldKey);
        const path = `fisAlanlari.${r.key}.${fieldKey}`;
        if (field === undefined || !field.aktif || !isEntryField(field)) fail(path, 'Bu alan fişte kullanılmıyor.');
        const parsed = parseReceiptValue(field, raw);
        if (!parsed.ok) fail(path, parsed.mesaj);
        if (parsed.value !== null) r.values.set(field.id, parsed.value);
      }
    }

    // An option must be one of the field's; a new choice must be active, a kept one may have become inactive.
    const optionIds = [...new Set(receipts.flatMap((r) => [...r.values.values()].flatMap((v) => (v.secenekId === null ? [] : [v.secenekId]))))];
    const options = new Map<number, { alan_id: number; aktif: boolean; kod: string; ad: string | null }>();
    if (optionIds.length > 0) {
      const rows = await query<{ id: number; alan_id: number; aktif: boolean; kod: string; ad: string | null }>(
        ex,
        `SELECT id, alan_id, aktif, kod, ad FROM dbo.alan_secenekleri WHERE id IN (${optionIds.map((_, i) => `@o${i}`).join(', ')})`,
        Object.fromEntries(optionIds.map((id, i) => [`o${i}`, p.int(id)])),
      );
      for (const o of rows) options.set(o.id, o);
    }
    for (const r of receipts) {
      for (const [alanId, v] of r.values) {
        if (v.secenekId === null) continue;
        const path = `fisAlanlari.${r.key}.${(ctx.byId.get(alanId) as FieldDef).anahtar}`;
        const option = options.get(v.secenekId);
        if (option === undefined || option.alan_id !== alanId) fail(path, 'Bu seçenek bu alanın listesinde yok.');
        const before = r.stored.find((s) => s.alanId === alanId);
        if (!option.aktif && before?.secenekId !== v.secenekId) fail(path, 'Bu seçenek pasif; başka birini seçin.');
      }
    }

    const changes = new Map<string, string[]>();
    for (const r of receipts) {
      const isActiveEntry = (alanId: number): boolean => ctx.entry.some((f) => f.id === alanId);
      const next: FieldValue[] = [
        ...r.stored.filter((s) => !isActiveEntry(s.alanId)),
        ...[...r.values].map(([alanId, v]): FieldValue => {
          const option = v.secenekId === null ? undefined : options.get(v.secenekId);
          return { ...v, alanId, optionText: option === undefined ? null : display(option.kod, option.ad) };
        }),
      ];
      const changed = ctx.entry.filter((f) => !sameValue(r.stored.find((s) => s.alanId === f.id), r.values.get(f.id))).map((f) => f.ad);
      if (r.invoice !== undefined) {
        plan.invoices.set(r.invoice, next);
        if (changed.length > 0) changes.set(`fatura:${r.invoice}`, changed);
      } else {
        const hash = (r.file as WaitingTarget).hash;
        plan.waiting.set(hash, next);
        if (changed.length > 0) changes.set(`dosya:${hash}`, changed);
      }
    }
    // Notes in the form's order: invoices, then waiting files.
    invoices.forEach((id, i) => {
      const changed = changes.get(`fatura:${id}`);
      if (changed !== undefined) plan.notes.push(`${i + 1}. faturanın alanları değişti: ${changed.join(', ')}.`);
    });
    for (const w of waiting) {
      const changed = changes.get(`dosya:${w.hash}`);
      if (changed !== undefined) plan.notes.push(`${w.name} dosyasının alanları değişti: ${changed.join(', ')}.`);
    }
    return plan;
  }

  /** A cost centre with its owner's assignment, or null when it does not exist. */
  async function costCentreOf(
    ex: Executor,
    ownerId: number,
    id: number,
  ): Promise<{ kod: string; aciklama: string | null; aktif: boolean; atanmis: boolean } | null> {
    return queryOne(
      ex,
      `SELECT m.kod, m.aciklama, m.aktif,
         CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.kullanici_masraf_merkezleri x WHERE x.kullanici_id = @u AND x.masraf_merkezi_id = m.id) THEN 1 ELSE 0 END AS BIT) AS atanmis
       FROM dbo.masraf_merkezleri m WHERE m.id = @id`,
      { u: p.int(ownerId), id: p.int(id) },
    );
  }

  /**
   * The cost centre a save leaves on the form (section 6, `masrafMerkeziId`). `stored` is the form's (null
   * on create). Left out: kept, or on create the owner's only active cost centre. The value stored on the
   * form is always accepted again; another one must be assigned to the owner and active. While the field is
   * inactive a request cannot carry one.
   */
  async function costCentreFor(ex: Executor, ownerId: number, ctx: FieldContext, given: number | null | undefined, stored: number | null, isNew: boolean): Promise<number | null> {
    const active = ctx.byKey.get(COST_CENTRE_KEY)?.aktif === true;
    if (given === undefined) {
      if (!isNew || !active) return stored;
      const own = await query<{ id: number }>(
        ex,
        `SELECT m.id FROM dbo.kullanici_masraf_merkezleri x JOIN dbo.masraf_merkezleri m ON m.id = x.masraf_merkezi_id
         WHERE x.kullanici_id = @u AND m.aktif = 1`,
        { u: p.int(ownerId) },
      );
      return own.length === 1 ? (own[0] as { id: number }).id : null;
    }
    if (!active) fail('masrafMerkeziId', 'Masraf merkezi alanı kullanılmıyor; masraf merkezi seçilemez.');
    if (given === null || given === stored) return given;
    const cc = await costCentreOf(ex, ownerId, given);
    if (cc === null || !cc.atanmis) fail('masrafMerkeziId', 'Bu masraf merkezi size tanımlı değil.');
    if (!cc.aktif) fail('masrafMerkeziId', 'Bu masraf merkezi pasif.');
    return given;
  }

  /** "Masraf merkezi: 11033106 → 12043106." for the history. */
  async function costCentreNote(ex: Executor, row: FormRow, next: number | null): Promise<string> {
    const before = row.mm_kod === null ? 'yok' : display(row.mm_kod, row.mm_aciklama);
    const cc = next === null ? null : await costCentreOf(ex, row.olusturan_id, next);
    return `Masraf merkezi: ${before} → ${cc === null ? 'yok' : display(cc.kod, cc.aciklama)}.`;
  }

  /**
   * What keeps the form's cost centre from a send, as the message of `alanlar.masrafMerkeziId`; null when
   * nothing does. With the field inactive the form goes without one. None chosen is a problem when the
   * field is required (marked or by a rule); a chosen one must still be assigned to the owner and active
   * (checked only with `checkOwner`: the detail checks it while the form can still be sent).
   */
  async function costCentreProblem(ex: Executor, row: FormRow, ctx: FieldContext, checkOwner: boolean): Promise<string | null> {
    if (ctx.byKey.get(COST_CENTRE_KEY)?.aktif !== true) return null;
    if (row.masraf_merkezi_id === null) {
      return formRequiredFields(ctx.defs.fields, ctx.defs.rules, formOf(row)).includes(COST_CENTRE_KEY) ? 'Masraf merkezi seçilmeli.' : null;
    }
    if (!checkOwner) return null;
    const cc = await costCentreOf(ex, row.olusturan_id, row.masraf_merkezi_id);
    return cc !== null && cc.atanmis && cc.aktif ? null : 'Seçili masraf merkezi size artık tanımlı değil; başka birini seçin.';
  }

  /**
   * What `bekleyenFaturalar` (section 6) does to a form whose waiting files are `current` and whose
   * invoice list is `invoices`: each file stays waiting, starts waiting (still being read) or, when it
   * was read meanwhile, joins the invoice list. Left out (undefined), the waiting files stay as they are.
   * Writes nothing; writeWaiting applies the plan once the form exists.
   */
  async function planWaiting(
    ex: Executor,
    actor: Actor,
    current: readonly WaitingRow[],
    hashes: readonly string[] | undefined,
    invoices: readonly string[],
  ): Promise<WaitingPlan> {
    const list = [...invoices];
    const fields = invoices.map((_, i) => `faturaIdler.${i}`);
    if (hashes === undefined) return { invoices: list, fields, add: [], drop: [], count: current.length };
    const add: WaitingPlan['add'][number][] = [];
    let kept = 0;
    for (const [i, hash] of hashes.entries()) {
      if (current.some((w) => w.dosya_ozeti === hash)) {
        kept += 1;
        continue;
      }
      const file = reading.file(hash, actor.id);
      if (file !== null) {
        add.push({ hash, ...file });
        continue;
      }
      // Read since the client last looked: the invoice joins the list instead of being lost.
      const read = await ownRecordOf(ex, actor, hash);
      if (read === null) fail(`bekleyenFaturalar.${i}`, 'Bu dosya sunucuda bulunamadı; faturayı yeniden yükleyin.');
      if (!list.includes(read)) {
        list.push(read);
        fields.push(`bekleyenFaturalar.${i}`);
      }
    }
    const drop = current.filter((w) => !hashes.includes(w.dosya_ozeti)).map((w) => w.id);
    if (list.length + kept + add.length > MAX_INVOICES) {
      fail('bekleyenFaturalar', `Bir masrafa en fazla ${MAX_INVOICES} fatura eklenebilir (okunmayı bekleyenler dahil).`);
    }
    return { invoices: list, fields, add, drop, count: kept + add.length };
  }

  /** Takes the dropped waiting files off the form and adds the new ones; returns the new rows' ids. */
  async function writeWaiting(tx: sql.Transaction, formId: number, actor: Actor, plan: WaitingPlan): Promise<number[]> {
    if (plan.drop.length > 0) {
      await execute(
        tx,
        `DELETE FROM dbo.bekleyen_faturalar WHERE form_id = @f AND id IN (${plan.drop.map((_, i) => `@w${i}`).join(', ')})`,
        { f: p.int(formId), ...Object.fromEntries(plan.drop.map((id, i) => [`w${i}`, p.int(id)])) },
      );
    }
    const ids: number[] = [];
    for (const file of plan.add) {
      const row = await queryOne<{ id: number }>(
        tx,
        `INSERT INTO dbo.bekleyen_faturalar (form_id, kullanici_id, dosya_adi, dosya_ozeti, mime, boyut, icerik)
         OUTPUT inserted.id VALUES (@f, @u, @ad, @h, @m, @b, @i)`,
        {
          f: p.int(formId),
          u: p.int(actor.id),
          ad: p.str(cleanFileName(file.name), 200),
          h: p.ascii(file.hash, 64),
          m: p.ascii(file.mime, 40),
          b: p.int(file.buffer.length),
          i: p.bytes(file.buffer),
        },
      );
      if (row === null) throw new Error('bekleyen fatura eklenemedi');
      ids.push(row.id);
    }
    return ids;
  }

  /** History notes of a change of the waiting files. */
  function waitingNotes(plan: WaitingPlan): string[] {
    return [
      ...(plan.add.length > 0 ? [`${plan.add.length} fatura okunmayı bekliyor.`] : []),
      ...(plan.drop.length > 0 ? [`${plan.drop.length} bekleyen fatura çıkarıldı.`] : []),
    ];
  }

  /**
   * Fills a draft's empty amount and seller from its invoices (section 3, "Arka planda okuma"); fields
   * the user filled stay. Returns the names of the fields filled, for the history.
   */
  async function fillFromInvoices(tx: sql.Transaction, row: FormRow): Promise<string[]> {
    if (row.tutar !== null && row.satici !== null) return [];
    const invoices = await formInvoices(tx, row.id);
    if (invoices.length === 0) return [];
    const filled: string[] = [];
    let tutar = num(row.tutar);
    let satici = row.satici;
    if (tutar === null) {
      const totals = invoices.map((x) => totalOf(effectiveOf(x), x.yerelKarsilik));
      const total = invoicesFormTotal({ paraBirimi: row.para_birimi, kur: num(row.kur) }, base, totals);
      if (total !== null && total > 0 && localAmount(total, num(row.kur)) <= MAX_AMOUNT) {
        tutar = total;
        filled.push('tutar');
      }
    }
    if (satici === null) {
      const name = invoices.map((x) => effectiveOf(x).fatura.saticiUnvan?.trim() ?? '').find((n) => n !== '');
      if (name !== undefined) {
        satici = name.slice(0, 200);
        filled.push('satıcı');
      }
    }
    if (filled.length === 0) return [];
    await execute(tx, 'UPDATE dbo.masraf_formlari SET tutar = @t, yerel_tutar = @y, satici = @s, guncelleme = SYSUTCDATETIME() WHERE id = @f', {
      f: p.int(row.id),
      t: p.money(tutar),
      y: p.money(tutar === null ? null : localAmount(tutar, num(row.kur))),
      s: p.str(satici, 200),
    });
    return filled;
  }

  const filledNote = (filled: readonly string[]): string => (filled.length === 0 ? '' : `Boş bırakılan ${filled.join(' ve ')} faturalardan dolduruldu.`);

  /**
   * Replaces the form's invoices with `ids`, in this order, with their entered equivalents, corrections
   * and receipt field values (deleting a link deletes its values, so every invoice's values are written
   * again). The duplicate key is computed from each invoice's effective data (`effective`).
   */
  async function setInvoices(
    tx: sql.Transaction,
    formId: number,
    ids: readonly string[],
    equivalents: ReadonlyMap<string, number>,
    corrections: ReadonlyMap<string, Invoice>,
    effective: ReadonlyMap<string, Invoice>,
    values: ReadonlyMap<string, readonly FieldValue[]>,
  ): Promise<void> {
    await execute(tx, 'DELETE FROM dbo.form_faturalari WHERE form_id = @f', { f: p.int(formId) });
    if (ids.length === 0) return;
    const { params } = idList(ids);
    const linkParams: Record<string, Param> = {};
    ids.forEach((id, i) => {
      const correction = corrections.get(id);
      const invoice = effective.get(id);
      linkParams[`k${i}`] = p.money(equivalents.get(id) ?? null);
      linkParams[`d${i}`] = p.text(correction === undefined ? null : JSON.stringify(correction));
      linkParams[`m${i}`] = p.str(invoice === undefined ? null : duplicateKey(invoice), 450);
    });
    await execute(
      tx,
      `INSERT INTO dbo.form_faturalari (form_id, kayit_id, sira, yerel_karsilik, duzeltme, mukerrer_anahtari)
       VALUES ${ids.map((_, i) => `(@f, @i${i}, ${i + 1}, @k${i}, @d${i}, @m${i})`).join(', ')}`,
      { ...params, ...linkParams, f: p.int(formId) },
    );
    for (const id of ids) await insertInvoiceValues(tx, formId, id, values.get(id) ?? []);
  }

  /** The waiting files a save leaves on the form: those kept, then those it adds. */
  const waitingTargets = (current: readonly WaitingRow[], plan: WaitingPlan): WaitingTarget[] => [
    ...current.filter((w) => !plan.drop.includes(w.id)).map((w) => ({ hash: w.dosya_ozeti, name: w.dosya_adi, id: w.id })),
    ...plan.add.map((a) => ({ hash: a.hash, name: cleanFileName(a.name), id: null })),
  ];

  /** "2 fatura eklendi, 1 fatura çıkarıldı." for the history, or null when the list kept its invoices. */
  function invoiceChanges(before: readonly string[], after: readonly string[]): string | null {
    const added = after.filter((id) => !before.includes(id)).length;
    const removed = before.filter((id) => !after.includes(id)).length;
    const parts = [added > 0 ? `${added} fatura eklendi` : null, removed > 0 ? `${removed} fatura çıkarıldı` : null].filter((x) => x !== null);
    if (parts.length === 0) return before.join() === after.join() ? null : 'Faturaların sırası değişti.';
    return `${parts.join(', ')}.`.replace(/^./, (c) => c.toUpperCase());
  }

  /**
   * Sending needs every required header field of every invoice (fatura_eksik), in its effective data:
   * those the field management marks required and those a rule requires for this receipt.
   */
  function checkComplete(invoices: readonly FormInvoice[], ctx: FieldContext, form: FormContext, values: ReadonlyMap<string, FieldValue[]>): void {
    const missing = invoices
      .map((inv, i) => {
        const required = receiptRequiredFields(ctx.defs.fields, ctx.defs.rules, form, valuesByKey(ctx, values.get(inv.id)));
        return { inv, i, fields: missingFields(effectiveOf(inv), headerKeys(required)) };
      })
      .filter((m) => m.fields.length > 0);
    const first = missing[0];
    if (first === undefined) return;
    const where = invoices.length === 1 ? 'Faturada' : `${first.i + 1}. faturada`;
    const mesaj = `${where} eksik bilgi var: ${first.fields.map((f) => FIELD_LABELS[f]).join(', ')}. Eksik alanları doldurup yeniden gönderin.`;
    throw new HttpError(409, 'fatura_eksik', mesaj, {
      alanlar: Object.fromEntries(missing.flatMap((m) => m.fields.map((f) => [`faturalar.${m.inv.id}.${f}`, 'Bu alan okunamadı; doldurun.']))),
    });
  }

  /**
   * Sending needs the form's cost centre (chosen when required, and still the owner's and active) and
   * every required receipt field of every invoice (alan_eksik). Header fields are checkComplete's.
   */
  async function checkFields(
    ex: Executor,
    row: FormRow,
    ctx: FieldContext,
    form: FormContext,
    invoices: readonly FormInvoice[],
    values: ReadonlyMap<string, FieldValue[]>,
  ): Promise<void> {
    const alanlar: Record<string, string> = {};
    const costCentre = await costCentreProblem(ex, row, ctx, true);
    if (costCentre !== null) alanlar.masrafMerkeziId = costCentre;
    let mesaj = costCentre;
    invoices.forEach((inv, i) => {
      const missing = receiptCheck(ctx, form, values.get(inv.id), null).missing;
      if (missing.length === 0) return;
      const names = missing.map((key) => ctx.byKey.get(key)?.ad ?? key);
      missing.forEach((key, j) => (alanlar[`fisAlanlari.${inv.id}.${key}`] = `${names[j]} zorunlu.`));
      mesaj ??= `${invoices.length === 1 ? 'Faturada' : `${i + 1}. faturada`} eksik alan var: ${names.join(', ')}. Eksik alanları doldurup yeniden gönderin.`;
    });
    if (mesaj !== null) throw new HttpError(409, 'alan_eksik', mesaj, { alanlar });
  }

  /** Serialises sends, so two forms holding the same invoice cannot both pass the duplicate check. */
  async function lockSends(ex: Executor): Promise<void> {
    await execute(ex, `EXEC sp_getapplock @Resource = N'masraf_gonderim', @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 15000`);
  }

  /**
   * Sending is refused when an invoice on the form has the same duplicate key as another invoice on the
   * form or on any live (aktif) invoice link of another form. Call with the send lock held.
   */
  async function checkDuplicates(ex: Executor, row: FormRow, actor: Actor, invoices: readonly FormInvoice[]): Promise<void> {
    const keys = invoices.map((inv) => duplicateKey(effectiveOf(inv)));
    const which = (i: number): string => (invoices.length === 1 ? 'Bu fatura' : `${i + 1}. fatura`);
    const problems = new Map<string, string>();
    keys.forEach((key, i) => {
      const earlier = key === null ? -1 : keys.indexOf(key);
      if (earlier >= 0 && earlier < i) problems.set((invoices[i] as FormInvoice).id, `${i + 1}. fatura, ${earlier + 1}. faturayla aynı; aynı fatura iki kez beyan edilemez.`);
    });
    const unique = [...new Set(keys.filter((k) => k !== null))];
    if (unique.length > 0) {
      const params: Record<string, Param> = Object.fromEntries(unique.map((k, i) => [`k${i}`, p.str(k, 450)]));
      const hits = await query<{ mukerrer_anahtari: string; form_id: number; olusturan_id: number }>(
        ex,
        `SELECT ff.mukerrer_anahtari, ff.form_id, f.olusturan_id
         FROM dbo.form_faturalari ff JOIN dbo.masraf_formlari f ON f.id = ff.form_id
         WHERE ff.aktif = 1 AND ff.form_id <> @self AND ff.mukerrer_anahtari IN (${unique.map((_, i) => `@k${i}`).join(', ')})
         ORDER BY ff.form_id`,
        { ...params, self: p.int(row.id) },
      );
      // An own form is named; someone else's form number is not given away.
      const byKey = new Map<string, (typeof hits)[number]>();
      for (const h of hits) if (!byKey.has(h.mukerrer_anahtari) || h.olusturan_id === actor.id) byKey.set(h.mukerrer_anahtari, h);
      keys.forEach((key, i) => {
        const hit = key === null ? undefined : byKey.get(key);
        const id = (invoices[i] as FormInvoice).id;
        if (hit === undefined || problems.has(id)) return;
        const where = hit.olusturan_id === actor.id ? `#${hit.form_id} numaralı masraf formundaki` : 'başka bir masraf formundaki';
        problems.set(id, `${which(i)} ${where} bir faturayla aynı; aynı fatura iki kez beyan edilemez.`);
      });
    }
    if (problems.size === 0) return;
    const ordered = invoices.filter((inv) => problems.has(inv.id)).map((inv) => [`faturalar.${inv.id}`, problems.get(inv.id) as string] as const);
    throw new HttpError(409, 'fatura_mukerrer', (ordered[0] as readonly [string, string])[1], { alanlar: Object.fromEntries(ordered) });
  }

  /** Sending needs the base-currency equivalent of every invoice in a third currency. */
  function checkEquivalents(row: FormRow, formInvoiceList: readonly FormInvoice[]): void {
    const invoices = formInvoiceList.map((x) => ({ id: x.id, ...totalOf(effectiveOf(x), x.yerelKarsilik) }));
    const missing = invoices
      .map((inv, i) => ({ inv, i }))
      .filter(({ inv }) => needsEquivalent(row.para_birimi, base, inv) && !(inv.yerelKarsilik !== null && inv.yerelKarsilik > 0));
    if (missing.length === 0) return;
    const text = ({ inv, i }: (typeof missing)[number]): string =>
      `${invoices.length === 1 ? 'Fatura' : `${i + 1}. fatura`} ${inv.paraBirimi} cinsinden; onaya göndermek için ${base} karşılığını girin.`;
    throw new HttpError(409, 'karsilik_eksik', text(missing[0] as (typeof missing)[number]), {
      alanlar: Object.fromEntries(missing.map((m) => [`yerelKarsiliklar.${m.inv.id}`, text(m)])),
    });
  }

  function checkCurrency(paraBirimi: string, kur: number | null | undefined): number | null {
    if (paraBirimi === base) return null;
    if (kur === null || kur === undefined) return fail('kur', `${paraBirimi} cinsinden masraf için ${base} kuru girilmelidir.`);
    return kur;
  }

  function fail(alan: string, mesaj: string): never {
    throw fieldError(alan, mesaj);
  }

  /** Checks what needs the database: category, currency, dates. Invoices are checked by checkInvoices. */
  async function checkInput(ex: Executor, input: FormInput, checkDate = true): Promise<CheckedInput> {
    if (checkDate && input.masrafTarihi > today()) fail('masrafTarihi', 'Masraf tarihi gelecekte olamaz.');
    const category = await queryOne<{ aktif: boolean }>(ex, 'SELECT aktif FROM dbo.masraf_kategorileri WHERE id = @id', { id: p.int(input.kategoriId) });
    if (category === null || !category.aktif) fail('kategoriId', 'Geçerli bir kategori seçin.');
    const paraBirimi = input.paraBirimi ?? base;
    const kur = checkCurrency(paraBirimi, input.kur);
    const tutar = input.tutar ?? null;
    const yerelTutar = tutar === null ? null : localAmount(tutar, kur);
    if (yerelTutar !== null && yerelTutar <= 0) fail('tutar', 'Tutar sıfırdan büyük olmalıdır.');
    return {
      baslik: input.baslik.trim(),
      kategoriId: input.kategoriId,
      masrafTarihi: input.masrafTarihi,
      tutar,
      paraBirimi,
      kur,
      yerelTutar,
      satici: input.satici?.trim() || null,
      aciklama: input.aciklama?.trim() || null,
    };
  }

  /** A concurrent request claimed one of the invoices first (the unique index caught it). */
  const invoiceInUse = (): HttpError => conflict('fatura_kullaniliyor', 'Faturalardan biri başka bir masraf formunda kullanılıyor.');
  // A foreign key failing on save: an administrator deleted a category, cost centre, field or option the
  // save had just checked (section 6, "Masraf formları").
  const definitionGone = (): HttpError =>
    conflict('tanim_degisti', 'Seçtiğiniz bir tanım (kategori, masraf merkezi, alan ya da seçenek) bu sırada silindi. Sayfayı yenileyip yeniden deneyin.');

  const inputParams = (c: CheckedInput): Record<string, Param> => ({
    baslik: p.str(c.baslik, 120),
    kat: p.int(c.kategoriId),
    tarih: p.date(c.masrafTarihi),
    tutar: p.money(c.tutar),
    pb: p.ascii(c.paraBirimi, 3),
    kur: p.rate(c.kur),
    yerel: p.money(c.yerelTutar),
    satici: p.str(c.satici, 200),
    aciklama: p.str(c.aciklama, 1000),
  });

  async function names(ex: Executor, ids: readonly number[]): Promise<Map<number, string>> {
    if (ids.length === 0) return new Map();
    const unique = [...new Set(ids)];
    const rows = await query<{ id: number; ad_soyad: string }>(
      ex,
      `SELECT id, ad_soyad FROM dbo.kullanicilar WHERE id IN (${unique.map((_, i) => `@u${i}`).join(', ')})`,
      Object.fromEntries(unique.map((id, i) => [`u${i}`, p.int(id)])),
    );
    return new Map(rows.map((r) => [r.id, r.ad_soyad]));
  }

  /** The approval rows for `senderId` sending `amount` through `flow` (by default the sender's own flow). */
  async function plan(
    ex: Executor,
    senderId: number,
    amount: number,
    flow?: RoutingFlow | null,
  ): Promise<{ akis: AkisOzet | null; steps: PlannedStep[] | null }> {
    const routing = flow === undefined ? await loadUserFlow(ex, senderId) : flow;
    const admins = await query<{ id: number }>(ex, `SELECT id FROM dbo.kullanicilar WHERE rol = 'yonetici' AND aktif = 1 AND id <> @s ORDER BY id`, {
      s: p.int(senderId),
    });
    const fallbacks = admins.map((a) => a.id);
    return { akis: routing?.akis ?? null, steps: planApprovals(routing?.strateji ?? 'zincir', routing?.adimlar ?? [], amount, senderId, fallbacks) };
  }

  const nobodyToApprove = (): HttpError =>
    conflict('onaylayan_yok', 'Bu masrafı onaylayabilecek başka bir kullanıcı yok. Yöneticinizden onay akışına bir onaycı eklemesini isteyin.');

  const someInvoices = (n: number): string => (n === 1 ? 'Bir fatura' : `${n} fatura`);
  const stillReading = (n: number): HttpError => conflict('okuma_suruyor', `${someInvoices(n)} henüz okunuyor; okumalar bitince gönderebilirsiniz.`);

  /**
   * Sends a locked form: copies the matching approvers, the first one waits for a decision. Checks in
   * the order of the contract: okuma_suruyor, okuma_hatali, tutar_eksik, fatura_eksik, alan_eksik,
   * fatura_mukerrer, karsilik_eksik, onaylayan_yok. Every refusal is thrown before the first write;
   * autoSend relies on it. The form takes its owner's organisation as it is now. `note` opens the history
   * line (e.g. a send the server made on the owner's behalf).
   */
  async function submitLocked(tx: sql.Transaction, row: FormRow, actor: Actor, note?: string): Promise<void> {
    const { bekleyen, hatali } = waitingOf(row);
    if (bekleyen > 0) throw stillReading(bekleyen);
    if (hatali > 0) throw conflict('okuma_hatali', `${someInvoices(hatali)} okunamadı. Yeniden okutun ya da masraftan çıkarın.`);
    const tutar = row.tutar;
    if (tutar === null) {
      const mesaj = 'Onaya göndermek için tutarı girin.';
      throw new HttpError(409, 'tutar_eksik', mesaj, { alanlar: { tutar: mesaj } });
    }
    await lockSends(tx);
    const invoices = await formInvoices(tx, row.id);
    const ctx = fieldContext(await loadDefinitions(tx));
    const values = await invoiceValues(tx, row.id);
    checkComplete(invoices, ctx, formOf(row), values);
    await checkFields(tx, row, ctx, formOf(row), invoices, values);
    await checkDuplicates(tx, row, actor, invoices);
    checkEquivalents(row, invoices);
    const totals = invoices.map((x) => totalOf(effectiveOf(x), x.yerelKarsilik));
    const amount = approvalAmount({ tutar: Number(tutar), paraBirimi: row.para_birimi, kur: num(row.kur) }, base, totals);
    const { akis, steps } = await plan(tx, row.olusturan_id, amount);
    if (steps === null) throw nobodyToApprove();
    const tur = row.tur + 1;
    for (const s of steps) {
      await execute(
        tx,
        `INSERT INTO dbo.form_onaylari (form_id, tur, sira, onayci_id, alt_limit, ust_limit, yedek, durum, aciklama, karar_tarihi)
         VALUES (@f, @t, @s, @o, @a, @u, @y, @d, @ac, CASE WHEN @d = 'atlandi' THEN SYSUTCDATETIME() END)`,
        {
          f: p.int(row.id),
          t: p.int(tur),
          s: p.int(s.sira),
          o: p.int(s.onayciId),
          a: p.money(s.altLimit),
          u: p.money(s.ustLimit),
          y: p.bit(s.yedek),
          d: p.ascii(s.durum, 16),
          ac: p.str(s.durum === 'atlandi' ? 'Kendi masrafı olduğu için atlandı.' : null, 500),
        },
      );
    }
    await execute(
      tx,
      `UPDATE dbo.masraf_formlari SET durum = 'onayda', tur = @t, onay_tutari = @amount, gonderim = SYSUTCDATETIME(),
         sonuclanma = NULL, odeme = NULL, okununca_gonder = 0, guncelleme = SYSUTCDATETIME(),
         organizasyon_id = (SELECT organizasyon_id FROM dbo.kullanicilar WHERE id = @owner) WHERE id = @f`,
      { f: p.int(row.id), t: p.int(tur), amount: p.money(amount), owner: p.int(row.olusturan_id) },
    );
    const who = await names(tx, steps.map((s) => s.onayciId));
    const chain = steps.filter((s) => s.durum !== 'atlandi').map((s) => `${who.get(s.onayciId) ?? s.onayciId}${s.yedek ? ' (yedek)' : ''}`);
    const flowName = akis === null ? '' : ` Onay akışı: ${akis.ad}.`;
    const opening = note === undefined ? '' : `${note} `;
    await history(tx, row.id, actor.id, 'gonderildi', `${opening}Onay tutarı ${formatMoney(amount, base)}.${flowName} Onaycılar: ${chain.join(' → ')}.`);
    for (const s of steps.filter((x) => x.durum === 'atlandi')) {
      await history(tx, row.id, s.onayciId, 'atlandi', 'Kendi masrafı olduğu için bu adım atlandı.');
    }
    const first = steps.find((x) => x.durum === 'bekliyor');
    if (first !== undefined) await tell(tx, { kind: 'onay_bekliyor', form: refOf(row, 'onayda'), onayciId: first.onayciId, sonraki: false }, actor);
  }

  const editable = (durum: FormDurum): boolean => durum === 'taslak' || durum === 'reddedildi';

  /**
   * "Okununca gönder": once no file of the form waits or failed, sends it on the owner's behalf, after
   * filling its empty fields from the invoices. The option ends with this attempt; the owner is told
   * how it went. Does nothing when the option is off or a file still waits. `actorId` is the owner when
   * the attempt follows their own save (nobody is notified of their own action), null in the background.
   */
  async function autoSend(formId: number, actorId: number | null): Promise<void> {
    await transaction(db, async (tx) => {
      let row = await readRow(tx, formId, true);
      if (row === null || !row.okununca_gonder || !editable(row.durum)) return;
      const { bekleyen, hatali } = waitingOf(row);
      if (bekleyen + hatali > 0) return;
      await execute(tx, 'UPDATE dbo.masraf_formlari SET okununca_gonder = 0 WHERE id = @f', { f: p.int(formId) });
      const filled = await fillFromInvoices(tx, row);
      if (filled.length > 0) {
        await history(tx, formId, actorId, 'guncellendi', filledNote(filled));
        row = (await readRow(tx, formId, true)) as FormRow;
      }
      const owner: Actor = { id: row.olusturan_id, rol: 'calisan' };
      try {
        await submitLocked(tx, row, owner, 'Faturalar okununca kendiliğinden gönderildi.');
      } catch (err) {
        // submitLocked refuses before it writes anything, so this transaction goes on without the send.
        if (!(err instanceof HttpError)) throw err;
        await history(tx, formId, actorId, 'guncellendi', `Okununca gönder: masraf onaya gönderilemedi. ${err.message}`);
        await notify(tx, { kind: 'onaya_gonderilemedi', form: refOf(row, row.durum), neden: err.message }, actorId, mail);
        return;
      }
      await notify(tx, { kind: 'onaya_gonderildi', form: refOf(row, 'onayda') }, actorId, mail);
    });
  }

  /**
   * The read of one waiting file ended (see settleWaiting). Returns the form to send when it was the
   * form's last waiting file and the owner asked for "okununca gönder"; null otherwise.
   */
  async function settleOnce(id: number, outcome: ReadOutcome): Promise<number | null> {
    const target = await queryOne<{ form_id: number }>(db, 'SELECT form_id FROM dbo.bekleyen_faturalar WHERE id = @id', { id: p.int(id) });
    if (target === null) return null;
    return transaction(db, async (tx) => {
      // The form first, then its file: the order every change of a form's files takes.
      const row = await readRow(tx, target.form_id, true);
      if (row === null) return null;
      const file = await queryOne<{ durum: string }>(tx, 'SELECT durum FROM dbo.bekleyen_faturalar WITH (UPDLOCK, ROWLOCK) WHERE id = @id AND form_id = @f', {
        id: p.int(id),
        f: p.int(row.id),
      });
      // Taken off the form, or settled already.
      if (file === null || file.durum !== 'bekliyor') return null;
      const drop = (): Promise<number> => execute(tx, 'DELETE FROM dbo.bekleyen_faturalar WHERE id = @id', { id: p.int(id) });
      const failWith = (kod: string, mesaj: string): Promise<number> =>
        execute(tx, `UPDATE dbo.bekleyen_faturalar SET durum = 'hata', hata_kodu = @k, hata_mesaji = @m WHERE id = @id`, {
          id: p.int(id),
          k: p.ascii(kod.slice(0, 40), 40),
          m: p.str(mesaj.slice(0, 500), 500),
        });
      if (!editable(row.durum)) {
        await drop();
        return null;
      }
      if ('hata' in outcome) {
        await failWith(outcome.hata.kod, outcome.hata.mesaj);
      } else {
        await linkRead(tx, row, id, outcome.kayitId, drop, failWith);
      }
      await execute(tx, 'UPDATE dbo.masraf_formlari SET guncelleme = SYSUTCDATETIME() WHERE id = @f', { f: p.int(row.id) });
      const left = await queryOne<{ bekleyen: number | null; hatali: number | null }>(
        tx,
        `SELECT SUM(CASE WHEN durum = 'bekliyor' THEN 1 ELSE 0 END) AS bekleyen, SUM(CASE WHEN durum = 'hata' THEN 1 ELSE 0 END) AS hatali
         FROM dbo.bekleyen_faturalar WHERE form_id = @f`,
        { f: p.int(row.id) },
      );
      if ((left?.bekleyen ?? 0) > 0) return null;
      return (await readsDone(tx, row, left?.hatali ?? 0)) ? row.id : null;
    });
  }

  /**
   * A waiting file was read: its invoice joins the end of the form's list with the file's receipt field
   * values, unless it cannot (the values then stay with the failed file).
   */
  async function linkRead(
    tx: sql.Transaction,
    row: FormRow,
    waitingId: number,
    kayitId: string,
    drop: () => Promise<number>,
    failWith: (kod: string, mesaj: string) => Promise<number>,
  ): Promise<void> {
    const here = await queryOne(tx, 'SELECT 1 AS x FROM dbo.form_faturalari WHERE form_id = @f AND kayit_id = @k', { f: p.int(row.id), k: p.ascii(kayitId, 24) });
    // The same file is on the form already; the invoice keeps its own values.
    if (here !== null) {
      await drop();
      return;
    }
    const used = await queryOne<{ form_id: number; olusturan_id: number }>(
      tx,
      `SELECT TOP (1) ff.form_id, f.olusturan_id FROM dbo.form_faturalari ff JOIN dbo.masraf_formlari f ON f.id = ff.form_id
       WHERE ff.aktif = 1 AND ff.kayit_id = @k`,
      { k: p.ascii(kayitId, 24) },
    );
    if (used !== null) {
      // Someone else who uploaded the same file must not learn their form's number.
      const where = used.olusturan_id === row.olusturan_id ? `#${used.form_id} numaralı masraf formunda` : 'başka bir masraf formunda';
      await failWith('fatura_kullaniliyor', `Bu fatura ${where} kullanılıyor.`);
      return;
    }
    const invoice = (await readInvoices(tx, [kayitId])).get(kayitId);
    if (invoice === undefined) {
      await failWith('kayit_yok', 'Okunan fatura kaydı bulunamadı; faturayı yeniden yükleyin.');
      return;
    }
    await execute(
      tx,
      `INSERT INTO dbo.form_faturalari (form_id, kayit_id, sira, mukerrer_anahtari)
       VALUES (@f, @k, (SELECT ISNULL(MAX(sira), 0) + 1 FROM dbo.form_faturalari WHERE form_id = @f), @m)`,
      { f: p.int(row.id), k: p.ascii(kayitId, 24), m: p.str(duplicateKey(invoice), 450) },
    );
    await execute(
      tx,
      `INSERT INTO dbo.fis_alan_degerleri (form_id, kayit_id, alan_id, secenek_id, metin)
       SELECT @f, @k, alan_id, secenek_id, metin FROM dbo.bekleyen_alan_degerleri WHERE bekleyen_id = @b`,
      { f: p.int(row.id), k: p.ascii(kayitId, 24), b: p.int(waitingId) },
    );
    await drop();
  }

  /**
   * The form's last waiting file is settled: fills the empty fields when every file was read, writes the
   * history and tells the owner. Returns true when the form is to be sent ("okununca gönder").
   */
  async function readsDone(tx: sql.Transaction, row: FormRow, failed: number): Promise<boolean> {
    if (failed > 0) {
      await history(tx, row.id, null, 'guncellendi', `Faturaların okunması bitti; ${someInvoices(failed).toLowerCase()} okunamadı.`);
      await notify(tx, { kind: 'okuma_hatasi', form: refOf(row, row.durum), hatali: failed }, null, mail);
      return false;
    }
    const filled = await fillFromInvoices(tx, row);
    await history(tx, row.id, null, 'guncellendi', `Faturaların okunması bitti.${filled.length > 0 ? ` ${filledNote(filled)}` : ''}`);
    if (row.okununca_gonder) return true;
    const now = filled.length > 0 ? ((await readRow(tx, row.id, true)) as FormRow) : row;
    await notify(tx, { kind: 'okuma_bitti', form: refOf(now, now.durum) }, null, mail);
    return false;
  }

  async function detail(id: number, actor: Actor): Promise<MasrafDetay> {
    const row = await readRow(db, id, false);
    if (row === null || !(await canSee(db, row, actor))) throw notFound('Masraf formu bulunamadı.');
    const [invoices, waiting, steps, events] = await Promise.all([
      formInvoices(db, id),
      waitingRows(db, id),
      query<{
        id: number;
        tur: number;
        sira: number;
        onayci_id: number;
        ad_soyad: string;
        alt_limit: number;
        ust_limit: number | null;
        durum: AdimDurum;
        aciklama: string | null;
        karar_tarihi: Date | null;
        yedek: boolean;
      }>(
        db,
        `SELECT o.id, o.tur, o.sira, o.onayci_id, k.ad_soyad, o.alt_limit, o.ust_limit, o.durum, o.aciklama, o.karar_tarihi, o.yedek
         FROM dbo.form_onaylari o JOIN dbo.kullanicilar k ON k.id = o.onayci_id
         WHERE o.form_id = @f AND o.tur = @t ORDER BY o.sira`,
        { f: p.int(id), t: p.int(row.tur) },
      ),
      query<{ islem: string; kullanici_id: number | null; ad_soyad: string | null; aciklama: string | null; tarih: Date }>(
        db,
        `SELECT g.islem, g.kullanici_id, k.ad_soyad, g.aciklama, g.tarih
         FROM dbo.form_gecmisi g LEFT JOIN dbo.kullanicilar k ON k.id = g.kullanici_id
         WHERE g.form_id = @f ORDER BY g.id`,
        { f: p.int(id) },
      ),
    ]);
    const [defs, invoiceVals, waitingVals] = await Promise.all([loadDefinitions(db), invoiceValues(db, id), waitingValues(db, id)]);
    const ctx = fieldContext(defs);
    const form = formOf(row);
    // Whether a chosen cost centre is still the owner's matters only while the form can be sent.
    const costCentre = await costCentreProblem(db, row, ctx, editable(row.durum));
    const faturalar: FaturaOzeti[] = invoices.map((invoice) => {
      const f = effectiveOf(invoice).fatura;
      const values = invoiceVals.get(invoice.id);
      return {
        id: invoice.id,
        dosyaAdi: invoice.dosyaAdi,
        dosyaOzeti: invoice.dosyaOzeti,
        dosyaVar: invoice.mime !== null,
        mime: invoice.mime,
        faturaNo: f.faturaNo,
        faturaTarihi: f.faturaTarihi,
        saticiUnvan: f.saticiUnvan,
        genelToplam: f.genelToplam,
        paraBirimi: f.paraBirimi,
        yerelKarsilik: invoice.yerelKarsilik,
        karsilikGerekli: needsEquivalent(row.para_birimi, base, { paraBirimi: f.paraBirimi }),
        saticiVergiNo: f.saticiVergiNo,
        aliciUnvan: f.aliciUnvan,
        aliciVergiNo: f.aliciVergiNo,
        araToplam: f.araToplam,
        kdvToplam: f.kdvToplam,
        kalemler: effectiveOf(invoice).kalemler,
        duzeltildi: invoice.correction !== null,
        okunan: invoice.correction === null ? null : invoice.read,
        alanlar: valuesView(ctx, values),
        eksikAlanlar: receiptCheck(ctx, form, values, f).missing,
      };
    });
    return {
      ...toSummary(row),
      aciklama: row.aciklama,
      kur: num(row.kur),
      onayTutari: num(row.onay_tutari),
      tur: row.tur,
      sonuclanma: iso(row.sonuclanma),
      odeme: iso(row.odeme),
      guncelleme: iso(row.guncelleme) ?? '',
      faturalar,
      okununcaGonder: row.okununca_gonder,
      eksikAlanlar: costCentre === null ? [] : [COST_CENTRE_KEY],
      bekleyenFaturalar: waiting.map((w): BekleyenFatura => {
        const values = waitingVals.get(w.id);
        const fields = { alanlar: valuesView(ctx, values), eksikAlanlar: receiptCheck(ctx, form, values, null).missing };
        const common = { dosyaOzeti: w.dosya_ozeti, dosyaAdi: w.dosya_adi, mime: w.mime, boyut: w.boyut, eklenme: iso(w.olusturma) ?? '' };
        if (w.durum === 'hata') {
          const hata = { kod: w.hata_kodu ?? 'okunamadi', mesaj: w.hata_mesaji ?? 'Fatura okunamadı.' };
          return { ...common, durum: 'hata', kuyrukSirasi: null, onundeki: null, hata, ...fields };
        }
        // A file whose read has not started yet (or is just ending) shows as waiting, without a place.
        const status = reading.status(w.dosya_ozeti);
        const place = status?.place ?? null;
        return { ...common, durum: status?.durum ?? 'sirada', kuyrukSirasi: place?.kuyrukSirasi ?? null, onundeki: place?.onundeki ?? null, hata: null, ...fields };
      }),
      tutarFarki: row.tutar === null ? null : amountMismatch({ tutar: Number(row.tutar), paraBirimi: row.para_birimi, kur: num(row.kur) }, base, faturalar),
      onaylar: steps.map((s) => ({
        id: s.id,
        tur: s.tur,
        sira: s.sira,
        onayci: { id: s.onayci_id, adSoyad: s.ad_soyad },
        altLimit: Number(s.alt_limit),
        ustLimit: num(s.ust_limit),
        durum: s.durum,
        aciklama: s.aciklama,
        kararTarihi: iso(s.karar_tarihi),
        yedek: s.yedek,
      })),
      gecmis: events.map((e) => ({
        islem: e.islem,
        kullanici: e.kullanici_id === null ? null : { id: e.kullanici_id, adSoyad: e.ad_soyad ?? '' },
        aciklama: e.aciklama,
        tarih: iso(e.tarih) ?? '',
      })),
      izinler: permissions(facts(row), actor),
    };
  }

  /** The approval document of a form, from the form as it is now. */
  async function renderPdf(row: FormRow): Promise<Buffer> {
    // The owner always sees the form; the permissions in the detail are not used here.
    const d = await detail(row.id, { id: row.olusturan_id, rol: 'calisan' });
    const owner = await queryOne<{ departman: string | null }>(db, 'SELECT departman FROM dbo.kullanicilar WHERE id = @u', { u: p.int(row.olusturan_id) });
    const ctx = fieldContext(await loadDefinitions(db));
    const data: PdfData = {
      form: {
        id: d.id,
        baslik: d.baslik,
        sahip: d.olusturan.adSoyad,
        departman: owner?.departman ?? null,
        organizasyon: d.organizasyon === null ? null : display(d.organizasyon.kod, d.organizasyon.ad),
        masrafMerkezi: d.masrafMerkezi?.gosterim ?? null,
        kategori: d.kategori.ad,
        masrafTarihi: d.masrafTarihi,
        tutar: d.tutar,
        paraBirimi: d.paraBirimi,
        kur: d.kur,
        onayTutari: d.onayTutari,
        durum: d.durum,
      },
      base,
      // Each invoice's receipt field values, labelled with the field's name, in field order.
      faturalar: d.faturalar.map((x) => ({
        ...x,
        alanlar: Object.entries(x.alanlar).map(([key, v]) => ({ ad: ctx.byKey.get(key)?.ad ?? key, gosterim: v.gosterim })),
      })),
      onaylar: d.onaylar.map((s) => ({
        sira: s.sira,
        onayci: s.onayci.adSoyad,
        durum: s.durum,
        kararTarihi: s.kararTarihi === null ? null : new Date(s.kararTarihi),
        aciklama: s.aciklama,
        yedek: s.yedek,
      })),
      olusturma: new Date(),
    };
    return renderApprovalPdf(data);
  }

  async function pendingCount(actor: Actor): Promise<number> {
    const row = await queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM dbo.form_onaylari o JOIN dbo.masraf_formlari f ON f.id = o.form_id
       WHERE o.onayci_id = @u AND o.durum = 'bekliyor' AND f.durum = 'onayda'`,
      { u: p.int(actor.id) },
    );
    return row?.n ?? 0;
  }

  function stateFilter(states: readonly FormDurum[] | undefined, params: Record<string, Param>): string | null {
    const list = (states ?? []).filter((s) => (FORM_STATES as readonly string[]).includes(s));
    if (list.length === 0) return null;
    list.forEach((s, i) => (params[`d${i}`] = p.ascii(s, 16)));
    return `f.durum IN (${list.map((_, i) => `@d${i}`).join(', ')})`;
  }

  return {
    async list(actor, { kapsam, durum, q, sayfa, adet }) {
      if (kapsam === 'tumu' && !isPrivileged(actor)) throw forbidden('Tüm masrafları yalnızca muhasebe ve yönetici görebilir.');
      const params: Record<string, Param> = { off: p.int((sayfa - 1) * adet), n: p.int(adet) };
      const where: string[] = [];
      if (kapsam === 'benim') {
        where.push('f.olusturan_id = @me');
        params.me = p.int(actor.id);
      }
      const states = stateFilter(durum, params);
      if (states !== null) where.push(states);
      const text = q?.trim();
      if (text !== undefined && text !== '') {
        const asId = /^#?\d{1,9}$/.test(text) ? Number(text.replace('#', '')) : null;
        where.push(`(f.baslik LIKE @q OR f.satici LIKE @q OR u.ad_soyad LIKE @q OR k.ad LIKE @q${asId !== null ? ' OR f.id = @qid' : ''})`);
        params.q = p.str(likePattern(text), 300);
        if (asId !== null) params.qid = p.int(asId);
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const [rows, count] = await Promise.all([
        query<FormRow>(db, `SELECT ${FORM_COLUMNS} ${formFrom(false)} ${whereSql} ORDER BY f.olusturma DESC, f.id DESC OFFSET @off ROWS FETCH NEXT @n ROWS ONLY`, params),
        queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n ${formFrom(false)} ${whereSql}`, params),
      ]);
      return { kayitlar: rows.map(toSummary), toplam: count?.n ?? 0, sayfa, adet };
    },

    detail,

    async create(actor, input, gonder) {
      let id: number;
      let waiting: number[] = [];
      try {
        id = await transaction(db, async (tx) => {
          // Taken before the invoices are inserted, so a send running meanwhile never waits on them.
          if (gonder) await lockSends(tx);
          const ctx = fieldContext(await loadDefinitions(tx));
          const c = await checkInput(tx, input);
          const masrafMerkeziId = await costCentreFor(tx, actor.id, ctx, input.masrafMerkeziId, null, true);
          const plan = await planWaiting(tx, actor, [], input.bekleyenFaturalar, input.faturaIdler ?? []);
          if (gonder && plan.count > 0) throw stillReading(plan.count);
          const invoices = plan.invoices;
          await checkInvoices(tx, actor, invoices, null, plan.fields);
          const reads = await readInvoices(tx, invoices);
          const { corrections, effective, notes } = correctionsFor(invoices, reads, new Map(), input.faturaDuzeltmeleri);
          const equivalents = equivalentsFor(invoices, effective, input.yerelKarsiliklar ?? {}, c.paraBirimi, true);
          // The values a new form starts with are not changes; they get no history note.
          const receipts = await planReceipts(tx, ctx, input.fisAlanlari, invoices, waitingTargets([], plan), new Map(), new Map());
          const row = await queryOne<{ id: number }>(
            tx,
            `INSERT INTO dbo.masraf_formlari
               (olusturan_id, baslik, aciklama, kategori_id, masraf_tarihi, satici, tutar, para_birimi, kur, yerel_tutar, durum, okununca_gonder,
                masraf_merkezi_id, organizasyon_id)
             OUTPUT inserted.id
             VALUES (@me, @baslik, @aciklama, @kat, @tarih, @satici, @tutar, @pb, @kur, @yerel, 'taslak', @og,
                     @mm, (SELECT organizasyon_id FROM dbo.kullanicilar WHERE id = @me))`,
            { me: p.int(actor.id), ...inputParams(c), og: p.bit(input.okununcaGonder === true), mm: p.int(masrafMerkeziId) },
          );
          if (row === null) throw new Error('masraf formu eklenemedi');
          await setInvoices(tx, row.id, invoices, equivalents, corrections, effective, receipts.invoices);
          waiting = await writeWaiting(tx, row.id, actor, plan);
          await writeWaitingValues(tx, row.id, receipts.waiting);
          await history(tx, row.id, actor.id, 'olusturuldu');
          const extra = [...notes, ...waitingNotes(plan)];
          if (extra.length > 0) for (const note of historyNotes(extra)) await history(tx, row.id, actor.id, 'guncellendi', note);
          if (gonder) await submitLocked(tx, await lockForm(tx, row.id, actor), actor);
          return row.id;
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw invoiceInUse();
        if (sqlErrorNumber(err) === SQL_ERROR.foreignKey) throw definitionGone();
        throw err;
      }
      reading.waiting(waiting);
      // With nothing left to wait for, "okununca gönder" sends at once.
      if (input.okununcaGonder === true) await autoSend(id, actor.id);
      return detail(id, actor);
    },

    async update(id, actor, patch) {
      let waiting: number[] = [];
      let sendWhenRead = false;
      try {
        await transaction(db, async (tx) => {
          const row = await lockForm(tx, id, actor);
          if (!permissions(facts(row), actor).duzenle) throw refusal('duzenle', row, actor);
          const ctx = fieldContext(await loadDefinitions(tx));
          // A rate belongs to its currency: a new currency without a new rate must not keep the old one.
          const currencyChanged = patch.paraBirimi !== undefined && patch.paraBirimi !== row.para_birimi;
          const merged: FormInput = {
            baslik: patch.baslik ?? row.baslik,
            kategoriId: patch.kategoriId ?? row.kategori_id,
            masrafTarihi: patch.masrafTarihi ?? dateOnly(row.masraf_tarihi) ?? '',
            tutar: patch.tutar !== undefined ? patch.tutar : num(row.tutar),
            paraBirimi: patch.paraBirimi ?? row.para_birimi,
            kur: patch.kur !== undefined ? patch.kur : currencyChanged ? null : num(row.kur),
            satici: patch.satici !== undefined ? patch.satici : row.satici,
            aciklama: patch.aciklama !== undefined ? patch.aciklama : row.aciklama,
          };
          // A changed date is checked; an untouched one stays as it was.
          const c = await checkInput(tx, merged, patch.masrafTarihi !== undefined);
          // Only a draft may wait for its invoices to fill the amount; a rejected form was sent with one.
          if (c.tutar === null && row.durum !== 'taslak') fail('tutar', 'Reddedilen masrafın tutarı boş bırakılamaz.');
          const masrafMerkeziId = await costCentreFor(tx, row.olusturan_id, ctx, patch.masrafMerkeziId, row.masraf_merkezi_id, false);
          // A new list replaces the invoices; without one they stay as they are. Equivalents follow the
          // same rule, and only those the invoices still need on this form (its currency may change) are kept.
          // The waiting files follow bekleyenFaturalar the same way; one read meanwhile joins the invoices.
          const before = invoiceIdsOf(row);
          const currentWaiting = await waitingRows(tx, row.id);
          const plan = await planWaiting(tx, actor, currentWaiting, patch.bekleyenFaturalar, patch.faturaIdler ?? before);
          const invoices = plan.invoices;
          if (patch.faturaIdler !== undefined || patch.bekleyenFaturalar !== undefined) await checkInvoices(tx, actor, invoices, row.id, plan.fields);
          if (patch.bekleyenFaturalar === undefined && invoices.length + plan.count > MAX_INVOICES) {
            fail('faturaIdler', `Bir masrafa en fazla ${MAX_INVOICES} fatura eklenebilir (okunmayı bekleyenler dahil).`);
          }
          // Corrections follow the invoices: those of invoices taken off the form are dropped.
          const current = await formInvoices(tx, row.id);
          const stored = Object.fromEntries(current.flatMap((x) => (x.yerelKarsilik === null ? [] : [[x.id, x.yerelKarsilik]])));
          const storedCorrections = new Map(current.flatMap((x) => (x.correction === null ? [] : [[x.id, x.correction] as const])));
          const reads = await readInvoices(tx, invoices);
          const { corrections, effective, notes } = correctionsFor(invoices, reads, storedCorrections, patch.faturaDuzeltmeleri);
          const given = patch.yerelKarsiliklar ?? stored;
          const equivalents = equivalentsFor(invoices, effective, given, c.paraBirimi, patch.yerelKarsiliklar !== undefined);
          // Receipt field values follow their receipts: those of invoices or files taken off the form go.
          const receipts = await planReceipts(
            tx,
            ctx,
            patch.fisAlanlari,
            invoices,
            waitingTargets(currentWaiting, plan),
            await invoiceValues(tx, row.id),
            await waitingValues(tx, row.id),
          );
          await setInvoices(tx, row.id, invoices, equivalents, corrections, effective, receipts.invoices);
          sendWhenRead = patch.okununcaGonder ?? row.okununca_gonder;
          // The organisation is the owner's as it is at each of their saves.
          await execute(
            tx,
            `UPDATE dbo.masraf_formlari SET baslik = @baslik, aciklama = @aciklama, kategori_id = @kat, masraf_tarihi = @tarih,
               satici = @satici, tutar = @tutar, para_birimi = @pb, kur = @kur, yerel_tutar = @yerel,
               okununca_gonder = @og, masraf_merkezi_id = @mm,
               organizasyon_id = (SELECT organizasyon_id FROM dbo.kullanicilar WHERE id = @owner), guncelleme = SYSUTCDATETIME()
             WHERE id = @id`,
            { id: p.int(row.id), ...inputParams(c), og: p.bit(sendWhenRead), mm: p.int(masrafMerkeziId), owner: p.int(row.olusturan_id) },
          );
          waiting = await writeWaiting(tx, row.id, actor, plan);
          await writeWaitingValues(tx, row.id, receipts.waiting);
          const listChange = invoiceChanges(before, invoices);
          const costCentreChange = masrafMerkeziId === row.masraf_merkezi_id ? [] : [await costCentreNote(tx, row, masrafMerkeziId)];
          const changes = [...(listChange === null ? [] : [listChange]), ...notes, ...waitingNotes(plan), ...costCentreChange, ...receipts.notes];
          for (const note of historyNotes(changes)) {
            await history(tx, row.id, actor.id, 'guncellendi', note);
          }
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw invoiceInUse();
        if (sqlErrorNumber(err) === SQL_ERROR.foreignKey) throw definitionGone();
        throw err;
      }
      reading.waiting(waiting);
      // Taking the last waiting (or failed) file off the form ends the wait.
      if (sendWhenRead) await autoSend(id, actor.id);
      return detail(id, actor);
    },

    submit(id, actor) {
      return act(id, actor, 'gonder', (tx, row) => submitLocked(tx, row, actor));
    },

    withdraw(id, actor) {
      return act(id, actor, 'geriCek', async (tx, row) => {
        await execute(tx, `UPDATE dbo.form_onaylari SET durum = 'iptal' WHERE form_id = @f AND tur = @t AND durum IN ('bekliyor', 'sirada')`, {
          f: p.int(row.id),
          t: p.int(row.tur),
        });
        await execute(tx, `UPDATE dbo.masraf_formlari SET durum = 'taslak', guncelleme = SYSUTCDATETIME() WHERE id = @f`, { f: p.int(row.id) });
        await history(tx, row.id, actor.id, 'geri_cekildi');
      });
    },

    cancel(id, actor) {
      return act(id, actor, 'iptal', async (tx, row) => {
        await execute(tx, `UPDATE dbo.masraf_formlari SET durum = 'iptal', okununca_gonder = 0, guncelleme = SYSUTCDATETIME() WHERE id = @f`, { f: p.int(row.id) });
        // The cancelled form keeps showing its invoices; another form may now use them.
        await execute(tx, 'UPDATE dbo.form_faturalari SET aktif = 0 WHERE form_id = @f', { f: p.int(row.id) });
        // Files still waiting leave the form; their reads go on and end up in the owner's invoice list.
        await execute(tx, 'DELETE FROM dbo.bekleyen_faturalar WHERE form_id = @f', { f: p.int(row.id) });
        await history(tx, row.id, actor.id, 'iptal_edildi');
      });
    },

    approve(id, actor, aciklama) {
      return act(id, actor, 'onayla', async (tx, row) => {
        const decided = await execute(
          tx,
          `UPDATE dbo.form_onaylari SET durum = 'onaylandi', aciklama = @a, karar_tarihi = SYSUTCDATETIME()
           WHERE form_id = @f AND tur = @t AND durum = 'bekliyor' AND onayci_id = @u`,
          { f: p.int(row.id), t: p.int(row.tur), u: p.int(actor.id), a: p.str(aciklama, 500) },
        );
        // The form lock makes this unreachable today; it stays so a change of isolation level can never
        // let a second decision complete a form.
        if (decided !== 1) throw notWaiting();
        await history(tx, row.id, actor.id, 'onaylandi', aciklama);
        const next = await query<{ onayci_id: number }>(
          tx,
          `WITH n AS (SELECT TOP (1) durum, onayci_id FROM dbo.form_onaylari WHERE form_id = @f AND tur = @t AND durum = 'sirada' ORDER BY sira)
           UPDATE n SET durum = 'bekliyor' OUTPUT inserted.onayci_id`,
          { f: p.int(row.id), t: p.int(row.tur) },
        );
        const waiting = next[0];
        if (waiting === undefined) {
          await execute(tx, `UPDATE dbo.masraf_formlari SET durum = 'onaylandi', sonuclanma = SYSUTCDATETIME(), guncelleme = SYSUTCDATETIME() WHERE id = @f`, {
            f: p.int(row.id),
          });
          await history(tx, row.id, null, 'tamamlandi', 'Bütün onaylar tamamlandı.');
          await tell(tx, { kind: 'onaylandi', form: refOf(row, 'onaylandi'), muhasebeIds: await activeAccountants(tx) }, actor);
        } else {
          await execute(tx, 'UPDATE dbo.masraf_formlari SET guncelleme = SYSUTCDATETIME() WHERE id = @f', { f: p.int(row.id) });
          await tell(tx, { kind: 'onay_bekliyor', form: refOf(row, 'onayda'), onayciId: waiting.onayci_id, sonraki: true }, actor);
        }
      });
    },

    reject(id, actor, aciklama) {
      return act(id, actor, 'reddet', async (tx, row) => {
        const decided = await execute(
          tx,
          `UPDATE dbo.form_onaylari SET durum = 'reddedildi', aciklama = @a, karar_tarihi = SYSUTCDATETIME()
           WHERE form_id = @f AND tur = @t AND durum = 'bekliyor' AND onayci_id = @u`,
          { f: p.int(row.id), t: p.int(row.tur), u: p.int(actor.id), a: p.str(aciklama, 500) },
        );
        if (decided !== 1) throw notWaiting();
        await execute(tx, `UPDATE dbo.form_onaylari SET durum = 'iptal' WHERE form_id = @f AND tur = @t AND durum = 'sirada'`, {
          f: p.int(row.id),
          t: p.int(row.tur),
        });
        await execute(tx, `UPDATE dbo.masraf_formlari SET durum = 'reddedildi', sonuclanma = SYSUTCDATETIME(), guncelleme = SYSUTCDATETIME() WHERE id = @f`, {
          f: p.int(row.id),
        });
        await history(tx, row.id, actor.id, 'reddedildi', aciklama);
        const who = await names(tx, [actor.id]);
        await tell(tx, { kind: 'reddedildi', form: refOf(row, 'reddedildi'), reddeden: who.get(actor.id) ?? '', gerekce: aciklama }, actor);
      });
    },

    markPaid(id, actor) {
      return act(id, actor, 'odendi', async (tx, row) => {
        await execute(tx, `UPDATE dbo.masraf_formlari SET durum = 'odendi', odeme = SYSUTCDATETIME(), guncelleme = SYSUTCDATETIME() WHERE id = @f`, {
          f: p.int(row.id),
        });
        await history(tx, row.id, actor.id, 'odendi');
        await tell(tx, { kind: 'odendi', form: refOf(row, 'odendi') }, actor);
      });
    },

    reassign(id, actor, onayId, yeniOnayciId) {
      return act(id, actor, 'devret', async (tx, row) => {
        const step = await queryOne<{ onayci_id: number; sira: number; durum: AdimDurum }>(
          tx,
          `SELECT onayci_id, sira, durum FROM dbo.form_onaylari WHERE id = @o AND form_id = @f AND tur = @t AND durum IN ('bekliyor', 'sirada')`,
          { o: p.int(onayId), f: p.int(row.id), t: p.int(row.tur) },
        );
        if (step === null) fail('onayId', 'Bu adım karar beklemiyor; yalnızca karar verilmemiş adımlar devredilebilir.');
        if (step.onayci_id === yeniOnayciId) fail('yeniOnayciId', 'Adım zaten bu kullanıcıda.');
        if (yeniOnayciId === row.olusturan_id) fail('yeniOnayciId', 'Masrafı oluşturan kişi kendi masrafını onaylayamaz.');
        const target = await queryOne<{ aktif: boolean }>(tx, 'SELECT aktif FROM dbo.kullanicilar WHERE id = @u', { u: p.int(yeniOnayciId) });
        if (target === null || !target.aktif) fail('yeniOnayciId', 'Aktif bir kullanıcı seçin.');
        const twice = await queryOne(
          tx,
          `SELECT TOP (1) 1 AS x FROM dbo.form_onaylari WHERE form_id = @f AND tur = @t AND onayci_id = @u AND durum IN ('bekliyor', 'sirada')`,
          { f: p.int(row.id), t: p.int(row.tur), u: p.int(yeniOnayciId) },
        );
        if (twice !== null) fail('yeniOnayciId', 'Bu kullanıcının bu formda zaten karar bekleyen bir adımı var.');
        await execute(tx, 'UPDATE dbo.form_onaylari SET onayci_id = @u WHERE id = @o', { u: p.int(yeniOnayciId), o: p.int(onayId) });
        await execute(tx, 'UPDATE dbo.masraf_formlari SET guncelleme = SYSUTCDATETIME() WHERE id = @f', { f: p.int(row.id) });
        const who = await names(tx, [step.onayci_id, yeniOnayciId]);
        await history(tx, row.id, actor.id, 'devredildi', `${step.sira}. adım: ${who.get(step.onayci_id) ?? step.onayci_id} → ${who.get(yeniOnayciId) ?? yeniOnayciId}`);
        await tell(
          tx,
          { kind: 'devredildi', form: refOf(row, 'onayda'), onayciId: yeniOnayciId, sira: step.sira, bekliyor: step.durum === 'bekliyor' },
          actor,
        );
      });
    },

    async preview(actor, { tutar, paraBirimi, kur, faturaIdler, yerelKarsiliklar, faturaDuzeltmeleri, akisId }) {
      let chosen: RoutingFlow | undefined;
      if (akisId !== undefined) {
        if (actor.rol !== 'yonetici') throw forbidden('Başka bir onay akışını yalnızca yönetici deneyebilir.');
        const found = await loadFlowById(db, akisId);
        if (found === null) throw notFound('Onay akışı bulunamadı.');
        chosen = found;
      }
      const pb = paraBirimi ?? base;
      const k = checkCurrency(pb, kur);
      // Only the actor's own uploads count; other ids are ignored, as the preview binds nothing.
      const requested = [...new Set(faturaIdler ?? [])].slice(0, MAX_INVOICES);
      const own = await uploadedBy(db, actor, requested);
      const reads = await readInvoices(
        db,
        requested.filter((id) => own.has(id)),
      );
      // Corrections count like on the form; those of other invoices are ignored.
      const invoices = [...reads].map(([id, read]) => totalOf(faturaDuzeltmeleri?.[id] ?? read, yerelKarsiliklar?.[id] ?? null));
      const amount = approvalAmount({ tutar, paraBirimi: pb, kur: k }, base, invoices);
      const { akis, steps } = await plan(db, actor.id, amount, chosen);
      if (steps === null) return { onayTutari: amount, paraBirimi: base, akis, adimlar: [], uyari: nobodyToApprove().message };
      const who = await names(db, steps.map((s) => s.onayciId));
      return {
        onayTutari: amount,
        paraBirimi: base,
        akis,
        adimlar: steps.map((s) => ({
          sira: s.sira,
          onayci: { id: s.onayciId, adSoyad: who.get(s.onayciId) ?? '' },
          durum: s.durum === 'bekliyor' ? 'sirada' : s.durum,
          yedek: s.yedek,
        })),
        uyari: null,
      };
    },

    async inbox(actor, durum) {
      const rows =
        durum === 'bekleyen'
          ? await query<FormRow>(
              db,
              `SELECT ${FORM_COLUMNS} ${formFrom(false)} WHERE f.durum = 'onayda' AND b.onayci_id = @u ORDER BY f.gonderim, f.id`,
              { u: p.int(actor.id) },
            )
          : await query<FormRow>(
              db,
              `SELECT TOP (200) ${FORM_COLUMNS} ${formFrom(false)}
               CROSS APPLY (SELECT MAX(x.karar_tarihi) AS son FROM dbo.form_onaylari x
                            WHERE x.form_id = f.id AND x.onayci_id = @u AND x.durum IN ('onaylandi', 'reddedildi')) karar
               WHERE karar.son IS NOT NULL ORDER BY karar.son DESC, f.id DESC`,
              { u: p.int(actor.id) },
            );
      return rows.map(toSummary);
    },

    pendingCount,

    async summary(actor) {
      const month = p.time(startOfMonth());
      const mine = await query<{ durum: FormDurum; n: number; toplam: number }>(
        db,
        'SELECT durum, COUNT(*) AS n, SUM(yerel_tutar) AS toplam FROM dbo.masraf_formlari WHERE olusturan_id = @u GROUP BY durum',
        { u: p.int(actor.id) },
      );
      const monthTotal = await queryOne<{ t: number | null }>(
        db,
        `SELECT SUM(yerel_tutar) AS t FROM dbo.masraf_formlari
         WHERE olusturan_id = @u AND gonderim >= @m AND durum IN ('onayda', 'onaylandi', 'reddedildi', 'odendi')`,
        { u: p.int(actor.id), m: month },
      );
      const count = (s: FormDurum): number => mine.find((r) => r.durum === s)?.n ?? 0;
      const [bekleyenOnay, recent] = await Promise.all([
        pendingCount(actor),
        query<FormRow>(db, `SELECT TOP (5) ${FORM_COLUMNS} ${formFrom(false)} WHERE f.olusturan_id = @u ORDER BY f.olusturma DESC, f.id DESC`, {
          u: p.int(actor.id),
        }),
      ]);
      let genel: Ozet['genel'] = null;
      if (isPrivileged(actor)) {
        const g = await queryOne<{ onayda: number; odeme_n: number; odeme_t: number | null; ay: number | null }>(
          db,
          `SELECT
             SUM(CASE WHEN durum = 'onayda' THEN 1 ELSE 0 END) AS onayda,
             SUM(CASE WHEN durum = 'onaylandi' THEN 1 ELSE 0 END) AS odeme_n,
             SUM(CASE WHEN durum = 'onaylandi' THEN yerel_tutar END) AS odeme_t,
             SUM(CASE WHEN durum IN ('onaylandi', 'odendi') AND sonuclanma >= @m THEN yerel_tutar END) AS ay
           FROM dbo.masraf_formlari`,
          { m: month },
        );
        genel = {
          onayda: g?.onayda ?? 0,
          odemeBekleyen: g?.odeme_n ?? 0,
          odemeBekleyenTutar: Number(g?.odeme_t ?? 0),
          buAyOnaylanan: Number(g?.ay ?? 0),
        };
      }
      return {
        paraBirimi: base,
        benim: {
          taslak: count('taslak'),
          onayda: count('onayda'),
          onaylandi: count('onaylandi'),
          reddedildi: count('reddedildi'),
          odendi: count('odendi'),
          buAyToplam: Number(monthTotal?.t ?? 0),
          bekleyenTutar: Number(mine.find((r) => r.durum === 'onayda')?.toplam ?? 0),
        },
        bekleyenOnay,
        sonMasraflar: recent.map(toSummary),
        genel,
      };
    },

    async pdf(id, actor) {
      const row = await readRow(db, id, false);
      if (row === null || !(await canSee(db, row, actor))) throw notFound('Masraf formu bulunamadı.');
      if (row.durum !== 'onaylandi' && row.durum !== 'odendi') {
        throw conflict('gecersiz_durum', 'Onay belgesi yalnızca onaylanan ya da ödenen masraf formları için alınabilir.');
      }
      return renderPdf(row);
    },

    async pdfForMail(id) {
      const row = await readRow(db, id, false);
      return row === null ? null : renderPdf(row);
    },

    async retryReads(id, actor) {
      let waiting: number[] = [];
      await transaction(db, async (tx) => {
        const row = await lockForm(tx, id, actor);
        if (!permissions(facts(row), actor).duzenle) throw refusal('duzenle', row, actor);
        const rows = await query<{ id: number }>(
          tx,
          `UPDATE dbo.bekleyen_faturalar SET durum = 'bekliyor', hata_kodu = NULL, hata_mesaji = NULL
           OUTPUT inserted.id WHERE form_id = @f AND durum = 'hata'`,
          { f: p.int(row.id) },
        );
        if (rows.length > 0) {
          await execute(tx, 'UPDATE dbo.masraf_formlari SET guncelleme = SYSUTCDATETIME() WHERE id = @f', { f: p.int(row.id) });
          await history(tx, row.id, actor.id, 'guncellendi', `${someInvoices(rows.length)} yeniden okunuyor.`);
        }
        // Every waiting file is (re)started: one whose read stopped on a database error waits with no
        // read running; those still being read are skipped by the reading queue.
        const all = await query<{ id: number }>(tx, `SELECT id FROM dbo.bekleyen_faturalar WHERE form_id = @f AND durum = 'bekliyor'`, { f: p.int(row.id) });
        waiting = all.map((r) => r.id);
      });
      reading.waiting(waiting);
      return detail(id, actor);
    },

    async waitingFiles(ids) {
      if (ids !== undefined && ids.length === 0) return [];
      const params: Record<string, Param> = Object.fromEntries((ids ?? []).map((id, i) => [`w${i}`, p.int(id)]));
      const only = ids === undefined ? '' : `AND b.id IN (${ids.map((_, i) => `@w${i}`).join(', ')})`;
      const rows = await query<{
        id: number;
        form_id: number;
        kullanici_id: number;
        ad_soyad: string;
        dosya_adi: string;
        dosya_ozeti: string;
        mime: string;
      }>(
        db,
        `SELECT b.id, b.form_id, b.kullanici_id, u.ad_soyad, b.dosya_adi, b.dosya_ozeti, b.mime
         FROM dbo.bekleyen_faturalar b JOIN dbo.kullanicilar u ON u.id = b.kullanici_id
         WHERE b.durum = 'bekliyor' ${only} ORDER BY b.id`,
        params,
      );
      return rows.map((r) => ({
        id: r.id,
        formId: r.form_id,
        kullanici: { id: r.kullanici_id, adSoyad: r.ad_soyad },
        dosyaAdi: r.dosya_adi,
        dosyaOzeti: r.dosya_ozeti,
        mime: r.mime,
      }));
    },

    async waitingContent(id) {
      const row = await queryOne<{ icerik: Buffer }>(db, `SELECT icerik FROM dbo.bekleyen_faturalar WHERE id = @id AND durum = 'bekliyor'`, { id: p.int(id) });
      return row?.icerik ?? null;
    },

    async resumeSends() {
      const rows = await query<{ id: number }>(
        db,
        `SELECT f.id FROM dbo.masraf_formlari f
         WHERE f.okununca_gonder = 1 AND f.durum IN ('taslak', 'reddedildi')
           AND NOT EXISTS (SELECT 1 FROM dbo.bekleyen_faturalar b WHERE b.form_id = f.id)
         ORDER BY f.id`,
      );
      for (const r of rows) await autoSend(r.id, null);
      return rows.length;
    },

    async settleWaiting(id, outcome) {
      // Two forms may claim the same invoice at once (unique index) or two settles may deadlock; a new
      // attempt then sees the other's result.
      for (let attempt = 1; ; attempt++) {
        let send: number | null;
        try {
          send = await settleOnce(id, outcome);
        } catch (err) {
          if (attempt < 3 && (isUniqueViolation(err) || sqlErrorNumber(err) === SQL_ERROR.deadlock)) continue;
          throw err;
        }
        if (send !== null) await autoSend(send, null);
        return;
      }
    },

    async exportRows(actor, { durum, baslangic, bitis }) {
      if (!isPrivileged(actor)) throw forbidden('Dışa aktarmayı yalnızca muhasebe ve yönetici yapabilir.');
      const params: Record<string, Param> = {};
      const where: string[] = [];
      const states = stateFilter(durum, params);
      if (states !== null) where.push(states);
      if (baslangic !== undefined) {
        where.push('f.masraf_tarihi >= @bas');
        params.bas = p.date(baslangic);
      }
      if (bitis !== undefined) {
        where.push('f.masraf_tarihi <= @bit');
        params.bit = p.date(bitis);
      }
      const rows = await query<FormRow & { departman: string | null; fatura_no: string | null }>(
        db,
        `SELECT TOP (50000) ${FORM_COLUMNS}, u.departman,
           (SELECT STRING_AGG(CAST(CASE WHEN ff.duzeltme IS NULL THEN r.fatura_no ELSE JSON_VALUE(ff.duzeltme, '$.fatura.faturaNo') END AS NVARCHAR(MAX)), N', ')
                   WITHIN GROUP (ORDER BY ff.sira)
            FROM dbo.form_faturalari ff JOIN dbo.fatura_kayitlari r ON r.id = ff.kayit_id WHERE ff.form_id = f.id) AS fatura_no
         ${formFrom(false)}
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY f.masraf_tarihi, f.id`,
        params,
      );
      return rows.map((r) => ({
        ...toSummary(r),
        kur: num(r.kur),
        departman: r.departman,
        sonuclanma: iso(r.sonuclanma),
        odeme: iso(r.odeme),
        faturaNo: r.fatura_no,
      }));
    },
  };
}

/**
 * Fills the duplicate key of live invoice links that have none: links written before the key existed.
 * Every later write computes the key itself, so after the first start only links without an invoice
 * number (whose key is NULL by rule) are read again. Runs at start-up, before the server listens.
 * Returns the number of links that got a key.
 */
export async function fillDuplicateKeys(db: Db): Promise<number> {
  const rows = await query<ReadRow & { form_id: number; kayit_id: string; duzeltme: string | null }>(
    db,
    `SELECT ff.form_id, ff.kayit_id, ff.duzeltme, ${READ_COLUMNS}
     FROM dbo.form_faturalari ff JOIN dbo.fatura_kayitlari r ON r.id = ff.kayit_id
     WHERE ff.aktif = 1 AND ff.mukerrer_anahtari IS NULL`,
  );
  let filled = 0;
  for (const r of rows) {
    const key = duplicateKey(parseInvoice(r.duzeltme) ?? readResult(r));
    if (key === null) continue;
    filled += await execute(
      db,
      `UPDATE dbo.form_faturalari SET mukerrer_anahtari = @k
       WHERE form_id = @f AND kayit_id = @i AND mukerrer_anahtari IS NULL`,
      { k: p.str(key, 450), f: p.int(r.form_id), i: p.ascii(r.kayit_id, 24) },
    );
  }
  return filled;
}
