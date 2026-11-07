import type sql from 'mssql';
import { formatMoney, planApprovals, type PlannedStep } from '../approval/flow.ts';
import { loadFlowById, loadUserFlow, type AkisOzet, type RoutingFlow } from '../approval/flow-store.ts';
import { dateOnly, execute, iso, isUniqueViolation, p, query, queryOne, transaction, type Db, type Executor, type Param } from '../db/sql.ts';
import { conflict, forbidden, HttpError, notFound } from '../errors.ts';
import { REQUIRED } from '../invoice/checks.ts';
import { duplicateKey, mergeCorrections, missingFields, type RequiredField } from '../invoice/effective.ts';
import { InvoiceSchema, type Invoice } from '../invoice/schema.ts';
import type { FormRef, NotificationEvent } from '../notifications/events.ts';
import { activeAccountants, NO_MAIL, notify, type NotifySettings } from '../notifications/store.ts';
import type { Simge } from './categories.ts';
import { renderApprovalPdf, type PdfData } from './pdf.ts';
import {
  amountMismatch,
  approvalAmount,
  FORM_STATES,
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

export interface MasrafOzet {
  readonly id: number;
  readonly baslik: string;
  readonly kategori: { readonly id: number; readonly ad: string; readonly simge: Simge };
  readonly masrafTarihi: string;
  readonly satici: string | null;
  readonly tutar: number;
  readonly paraBirimi: string;
  readonly yerelTutar: number;
  readonly durum: FormDurum;
  readonly olusturan: KisiOzet;
  readonly olusturma: string;
  readonly gonderim: string | null;
  readonly siradakiOnayci: KisiOzet | null;
  /** Invoice record ids in the order they were added; empty for a form without invoices. */
  readonly faturaIdler: readonly string[];
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
  /** Required fields empty in the effective data. */
  readonly eksikAlanlar: readonly RequiredField[];
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
  readonly tutarFarki: { readonly fatura: number; readonly beyan: number } | null;
  readonly onaylar: readonly OnayAdimi[];
  readonly gecmis: readonly GecmisSatiri[];
  readonly izinler: Izinler;
}

export interface FormInput {
  readonly baslik: string;
  readonly kategoriId: number;
  readonly masrafTarihi: string;
  readonly tutar: number;
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
  tutar: number;
  para_birimi: string;
  kur: number | null;
  yerel_tutar: number;
  onay_tutari: number | null;
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
}

const FORM_COLUMNS = `f.id, f.olusturan_id, u.ad_soyad AS olusturan_ad, f.baslik, f.aciklama, f.kategori_id,
  k.ad AS kategori_ad, k.simge AS kategori_simge, f.masraf_tarihi, f.satici, f.tutar, f.para_birimi, f.kur,
  f.yerel_tutar, f.onay_tutari,
  (SELECT STRING_AGG(ff.kayit_id, ',') WITHIN GROUP (ORDER BY ff.sira) FROM dbo.form_faturalari ff WHERE ff.form_id = f.id) AS fatura_idler,
  f.durum, f.tur, f.olusturma, f.guncelleme, f.gonderim,
  f.sonuclanma, f.odeme, b.onayci_id AS bekleyen_onayci_id, bu.ad_soyad AS bekleyen_onayci_ad`;

// At most one step per form is 'bekliyor' (unique filtered index), so the join never repeats a form.
const formFrom = (lock: boolean): string => `
  FROM dbo.masraf_formlari f ${lock ? 'WITH (UPDLOCK, ROWLOCK)' : ''}
  JOIN dbo.kullanicilar u ON u.id = f.olusturan_id
  JOIN dbo.masraf_kategorileri k ON k.id = f.kategori_id
  LEFT JOIN dbo.form_onaylari b ON b.form_id = f.id AND b.durum = 'bekliyor'
  LEFT JOIN dbo.kullanicilar bu ON bu.id = b.onayci_id`;

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

function toSummary(r: FormRow): MasrafOzet {
  return {
    id: r.id,
    baslik: r.baslik,
    kategori: { id: r.kategori_id, ad: r.kategori_ad, simge: r.kategori_simge },
    masrafTarihi: dateOnly(r.masraf_tarihi) ?? '',
    satici: r.satici,
    tutar: Number(r.tutar),
    paraBirimi: r.para_birimi,
    yerelTutar: Number(r.yerel_tutar),
    durum: r.durum,
    olusturan: { id: r.olusturan_id, adSoyad: r.olusturan_ad },
    olusturma: iso(r.olusturma) ?? '',
    gonderim: iso(r.gonderim),
    siradakiOnayci: r.durum === 'onayda' && r.bekleyen_onayci_id !== null ? { id: r.bekleyen_onayci_id, adSoyad: r.bekleyen_onayci_ad ?? '' } : null,
    faturaIdler: invoiceIdsOf(r),
  };
}

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
  readonly tutar: number;
  readonly paraBirimi: string;
  readonly kur: number | null;
  readonly yerelTutar: number;
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
}

export interface ExpenseServiceOptions {
  readonly baseCurrency: string;
  /** Mail settings of the notifications; default: mails written as skipped. */
  readonly notifications?: NotifySettings | undefined;
}

export function createExpenseService(db: Db, opts: ExpenseServiceOptions): ExpenseService {
  const base = opts.baseCurrency;
  const mail = opts.notifications ?? NO_MAIL;

  /** What notifications say about the form, in the state it has after the action. */
  const refOf = (row: FormRow, durum: FormDurum): FormRef => ({
    id: row.id,
    baslik: row.baslik,
    sahip: { id: row.olusturan_id, adSoyad: row.olusturan_ad },
    tutar: Number(row.tutar),
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
    const rows = await query<ReadRow & { kayit_id: string; dosya_adi: string; mime: string | null; yerel_karsilik: number | null; duzeltme: string | null }>(
      ex,
      `SELECT ff.kayit_id, ff.yerel_karsilik, ff.duzeltme, r.dosya_adi, d.mime, ${READ_COLUMNS}
       FROM dbo.form_faturalari ff
       JOIN dbo.fatura_kayitlari r ON r.id = ff.kayit_id
       LEFT JOIN dbo.fatura_dosyalari d ON d.kayit_id = r.id
       WHERE ff.form_id = @f ORDER BY ff.sira`,
      { f: p.int(formId) },
    );
    return rows.map((r) => ({
      id: r.kayit_id,
      dosyaAdi: r.dosya_adi,
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

  /** Each invoice must be the actor's own upload, listed once, and not claimed by another live form. */
  async function checkInvoices(ex: Executor, actor: Actor, ids: readonly string[], formId: number | null): Promise<void> {
    const which = (i: number): string => (ids.length === 1 ? 'Fatura' : `${i + 1}. fatura`);
    if (ids.length > MAX_INVOICES) fail('faturaIdler', `Bir masrafa en fazla ${MAX_INVOICES} fatura eklenebilir.`);
    const twice = ids.findIndex((id, i) => ids.indexOf(id) !== i);
    if (twice >= 0) fail(`faturaIdler.${twice}`, 'Aynı fatura bir forma iki kez eklenemez.');
    if (ids.length === 0) return;
    const own = await uploadedBy(ex, actor, ids);
    const foreign = ids.findIndex((id) => !own.has(id));
    if (foreign >= 0) fail(`faturaIdler.${foreign}`, `${which(foreign)} bulunamadı. Yalnızca kendi yüklediğiniz faturaları ekleyebilirsiniz.`);
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
    throw new HttpError(409, 'fatura_kullaniliyor', mesaj, { alanlar: { [`faturaIdler.${i}`]: mesaj } });
  }

  /**
   * Replaces the form's invoices with `ids`, in this order, with their entered equivalents and
   * corrections. The duplicate key is computed from each invoice's effective data (`effective`).
   */
  async function setInvoices(
    tx: sql.Transaction,
    formId: number,
    ids: readonly string[],
    equivalents: ReadonlyMap<string, number>,
    corrections: ReadonlyMap<string, Invoice>,
    effective: ReadonlyMap<string, Invoice>,
  ): Promise<void> {
    await execute(tx, 'DELETE FROM dbo.form_faturalari WHERE form_id = @f', { f: p.int(formId) });
    if (ids.length === 0) return;
    const { params } = idList(ids);
    const values: Record<string, Param> = {};
    ids.forEach((id, i) => {
      const correction = corrections.get(id);
      const invoice = effective.get(id);
      values[`k${i}`] = p.money(equivalents.get(id) ?? null);
      values[`d${i}`] = p.text(correction === undefined ? null : JSON.stringify(correction));
      values[`m${i}`] = p.str(invoice === undefined ? null : duplicateKey(invoice), 450);
    });
    await execute(
      tx,
      `INSERT INTO dbo.form_faturalari (form_id, kayit_id, sira, yerel_karsilik, duzeltme, mukerrer_anahtari)
       VALUES ${ids.map((_, i) => `(@f, @i${i}, ${i + 1}, @k${i}, @d${i}, @m${i})`).join(', ')}`,
      { ...params, ...values, f: p.int(formId) },
    );
  }

  /** "2 fatura eklendi, 1 fatura çıkarıldı." for the history, or null when the list kept its invoices. */
  function invoiceChanges(before: readonly string[], after: readonly string[]): string | null {
    const added = after.filter((id) => !before.includes(id)).length;
    const removed = before.filter((id) => !after.includes(id)).length;
    const parts = [added > 0 ? `${added} fatura eklendi` : null, removed > 0 ? `${removed} fatura çıkarıldı` : null].filter((x) => x !== null);
    if (parts.length === 0) return before.join() === after.join() ? null : 'Faturaların sırası değişti.';
    return `${parts.join(', ')}.`.replace(/^./, (c) => c.toUpperCase());
  }

  /** Sending needs every required field of every invoice, in its effective data. */
  function checkComplete(invoices: readonly FormInvoice[]): void {
    const missing = invoices.map((inv, i) => ({ inv, i, fields: missingFields(effectiveOf(inv)) })).filter((m) => m.fields.length > 0);
    const first = missing[0];
    if (first === undefined) return;
    const labels: Record<string, string> = Object.fromEntries(REQUIRED);
    const where = invoices.length === 1 ? 'Faturada' : `${first.i + 1}. faturada`;
    const mesaj = `${where} eksik bilgi var: ${first.fields.map((f) => labels[f]).join(', ')}. Eksik alanları doldurup yeniden gönderin.`;
    throw new HttpError(409, 'fatura_eksik', mesaj, {
      alanlar: Object.fromEntries(missing.flatMap((m) => m.fields.map((f) => [`faturalar.${m.inv.id}.${f}`, 'Bu alan okunamadı; doldurun.']))),
    });
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
    const yerelTutar = localAmount(input.tutar, kur);
    if (yerelTutar <= 0) fail('tutar', 'Tutar sıfırdan büyük olmalıdır.');
    return {
      baslik: input.baslik.trim(),
      kategoriId: input.kategoriId,
      masrafTarihi: input.masrafTarihi,
      tutar: input.tutar,
      paraBirimi,
      kur,
      yerelTutar,
      satici: input.satici?.trim() || null,
      aciklama: input.aciklama?.trim() || null,
    };
  }

  /** A concurrent request claimed one of the invoices first (the unique index caught it). */
  const invoiceInUse = (): HttpError => conflict('fatura_kullaniliyor', 'Faturalardan biri başka bir masraf formunda kullanılıyor.');

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

  /**
   * Sends a locked form: copies the matching approvers, the first one waits for a decision. Checks in
   * the order of the contract: fatura_eksik, fatura_mukerrer, karsilik_eksik, onaylayan_yok.
   */
  async function submitLocked(tx: sql.Transaction, row: FormRow, actor: Actor): Promise<void> {
    await lockSends(tx);
    const invoices = await formInvoices(tx, row.id);
    checkComplete(invoices);
    await checkDuplicates(tx, row, actor, invoices);
    checkEquivalents(row, invoices);
    const totals = invoices.map((x) => totalOf(effectiveOf(x), x.yerelKarsilik));
    const amount = approvalAmount({ tutar: Number(row.tutar), paraBirimi: row.para_birimi, kur: num(row.kur) }, base, totals);
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
         sonuclanma = NULL, odeme = NULL, guncelleme = SYSUTCDATETIME() WHERE id = @f`,
      { f: p.int(row.id), t: p.int(tur), amount: p.money(amount) },
    );
    const who = await names(tx, steps.map((s) => s.onayciId));
    const chain = steps.filter((s) => s.durum !== 'atlandi').map((s) => `${who.get(s.onayciId) ?? s.onayciId}${s.yedek ? ' (yedek)' : ''}`);
    const flowName = akis === null ? '' : ` Onay akışı: ${akis.ad}.`;
    await history(tx, row.id, actor.id, 'gonderildi', `Onay tutarı ${formatMoney(amount, base)}.${flowName} Onaycılar: ${chain.join(' → ')}.`);
    for (const s of steps.filter((x) => x.durum === 'atlandi')) {
      await history(tx, row.id, s.onayciId, 'atlandi', 'Kendi masrafı olduğu için bu adım atlandı.');
    }
    const first = steps.find((x) => x.durum === 'bekliyor');
    if (first !== undefined) await tell(tx, { kind: 'onay_bekliyor', form: refOf(row, 'onayda'), onayciId: first.onayciId, sonraki: false }, actor);
  }

  async function detail(id: number, actor: Actor): Promise<MasrafDetay> {
    const row = await readRow(db, id, false);
    if (row === null || !(await canSee(db, row, actor))) throw notFound('Masraf formu bulunamadı.');
    const [invoices, steps, events] = await Promise.all([
      formInvoices(db, id),
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
    const faturalar: FaturaOzeti[] = invoices.map((invoice) => {
      const f = effectiveOf(invoice).fatura;
      return {
        id: invoice.id,
        dosyaAdi: invoice.dosyaAdi,
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
        eksikAlanlar: missingFields(effectiveOf(invoice)),
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
      tutarFarki: amountMismatch({ tutar: Number(row.tutar), paraBirimi: row.para_birimi, kur: num(row.kur) }, base, faturalar),
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
    const data: PdfData = {
      form: {
        id: d.id,
        baslik: d.baslik,
        sahip: d.olusturan.adSoyad,
        departman: owner?.departman ?? null,
        kategori: d.kategori.ad,
        masrafTarihi: d.masrafTarihi,
        tutar: d.tutar,
        paraBirimi: d.paraBirimi,
        kur: d.kur,
        onayTutari: d.onayTutari,
        durum: d.durum,
      },
      base,
      faturalar: d.faturalar,
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
      try {
        id = await transaction(db, async (tx) => {
          // Taken before the invoices are inserted, so a send running meanwhile never waits on them.
          if (gonder) await lockSends(tx);
          const c = await checkInput(tx, input);
          const invoices = input.faturaIdler ?? [];
          await checkInvoices(tx, actor, invoices, null);
          const reads = await readInvoices(tx, invoices);
          const { corrections, effective, notes } = correctionsFor(invoices, reads, new Map(), input.faturaDuzeltmeleri);
          const equivalents = equivalentsFor(invoices, effective, input.yerelKarsiliklar ?? {}, c.paraBirimi, true);
          const row = await queryOne<{ id: number }>(
            tx,
            `INSERT INTO dbo.masraf_formlari
               (olusturan_id, baslik, aciklama, kategori_id, masraf_tarihi, satici, tutar, para_birimi, kur, yerel_tutar, durum)
             OUTPUT inserted.id
             VALUES (@me, @baslik, @aciklama, @kat, @tarih, @satici, @tutar, @pb, @kur, @yerel, 'taslak')`,
            { me: p.int(actor.id), ...inputParams(c) },
          );
          if (row === null) throw new Error('masraf formu eklenemedi');
          await setInvoices(tx, row.id, invoices, equivalents, corrections, effective);
          await history(tx, row.id, actor.id, 'olusturuldu');
          if (notes.length > 0) for (const note of historyNotes(notes)) await history(tx, row.id, actor.id, 'guncellendi', note);
          if (gonder) await submitLocked(tx, await lockForm(tx, row.id, actor), actor);
          return row.id;
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw invoiceInUse();
        throw err;
      }
      return detail(id, actor);
    },

    async update(id, actor, patch) {
      try {
        return await act(id, actor, 'duzenle', async (tx, row) => {
          // A rate belongs to its currency: a new currency without a new rate must not keep the old one.
          const currencyChanged = patch.paraBirimi !== undefined && patch.paraBirimi !== row.para_birimi;
          const merged: FormInput = {
            baslik: patch.baslik ?? row.baslik,
            kategoriId: patch.kategoriId ?? row.kategori_id,
            masrafTarihi: patch.masrafTarihi ?? dateOnly(row.masraf_tarihi) ?? '',
            tutar: patch.tutar ?? Number(row.tutar),
            paraBirimi: patch.paraBirimi ?? row.para_birimi,
            kur: patch.kur !== undefined ? patch.kur : currencyChanged ? null : num(row.kur),
            satici: patch.satici !== undefined ? patch.satici : row.satici,
            aciklama: patch.aciklama !== undefined ? patch.aciklama : row.aciklama,
          };
          // A changed date is checked; an untouched one stays as it was.
          const c = await checkInput(tx, merged, patch.masrafTarihi !== undefined);
          // A new list replaces the invoices; without one they stay as they are. Equivalents follow the
          // same rule, and only those the invoices still need on this form (its currency may change) are kept.
          const before = invoiceIdsOf(row);
          const invoices = patch.faturaIdler ?? before;
          if (patch.faturaIdler !== undefined) await checkInvoices(tx, actor, invoices, row.id);
          // Corrections follow the invoices: those of invoices taken off the form are dropped.
          const current = await formInvoices(tx, row.id);
          const stored = Object.fromEntries(current.flatMap((x) => (x.yerelKarsilik === null ? [] : [[x.id, x.yerelKarsilik]])));
          const storedCorrections = new Map(current.flatMap((x) => (x.correction === null ? [] : [[x.id, x.correction] as const])));
          const reads = await readInvoices(tx, invoices);
          const { corrections, effective, notes } = correctionsFor(invoices, reads, storedCorrections, patch.faturaDuzeltmeleri);
          const given = patch.yerelKarsiliklar ?? stored;
          const equivalents = equivalentsFor(invoices, effective, given, c.paraBirimi, patch.yerelKarsiliklar !== undefined);
          await setInvoices(tx, row.id, invoices, equivalents, corrections, effective);
          await execute(
            tx,
            `UPDATE dbo.masraf_formlari SET baslik = @baslik, aciklama = @aciklama, kategori_id = @kat, masraf_tarihi = @tarih,
               satici = @satici, tutar = @tutar, para_birimi = @pb, kur = @kur, yerel_tutar = @yerel,
               guncelleme = SYSUTCDATETIME()
             WHERE id = @id`,
            { id: p.int(row.id), ...inputParams(c) },
          );
          const listChange = invoiceChanges(before, invoices);
          for (const note of historyNotes([...(listChange === null ? [] : [listChange]), ...notes])) {
            await history(tx, row.id, actor.id, 'guncellendi', note);
          }
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw invoiceInUse();
        throw err;
      }
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
        await execute(tx, `UPDATE dbo.masraf_formlari SET durum = 'iptal', guncelleme = SYSUTCDATETIME() WHERE id = @f`, { f: p.int(row.id) });
        // The cancelled form keeps showing its invoices; another form may now use them.
        await execute(tx, 'UPDATE dbo.form_faturalari SET aktif = 0 WHERE form_id = @f', { f: p.int(row.id) });
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
 * Fills the duplicate key of live invoice links that have none: links written before migration 003.
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
