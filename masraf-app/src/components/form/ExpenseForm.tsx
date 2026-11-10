import { Ionicons } from '@expo/vector-icons';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Switch, View, type ScrollViewInstance } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, errorMessage } from '@/api/client';
import { createMasraf, runMasrafAction, updateMasraf } from '@/api/endpoints';
import { useAlanlar, useBen, useKategoriler, useMasrafChanged, useOzet } from '@/api/queries';
import type { AlanTanimi, FisDegeri, MasrafDetay, MasrafGuncelleIstegi, OkunanFatura, OnizlemeIstegi } from '@/api/types';
import { InvoiceThumb, type InvoiceThumbSource } from '@/components/expense/InvoiceThumb';
import { Button, type IconName } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { IconButton } from '@/components/ui/IconButton';
import { PressableScale } from '@/components/ui/PressableScale';
import { Skeleton } from '@/components/ui/Skeleton';
import { Banner } from '@/components/ui/StateViews';
import { Text } from '@/components/ui/Text';
import { FieldError, FieldLabel, TextField } from '@/components/ui/TextField';
import { useToast, type ToastTone } from '@/components/ui/Toast';
import {
  attachmentId,
  isFailed,
  isPendingFailed,
  isReading,
  pendingHash,
  pendingHashes,
  useInvoiceAttachments,
  type InvoiceAttachment,
} from '@/hooks/useInvoiceAttachments';
import { useMotion } from '@/hooks/useMotion';
import {
  conditionValues,
  isReceipt,
  receiptKey,
  requestKey,
  requestValues,
  useReceiptValues,
  type DraftValue,
} from '@/hooks/useReceiptValues';
import { categoryIcon } from '@/lib/categories';
import {
  COST_CENTRE_KEY,
  costCentreRequired,
  editableReceiptFields,
  EMPTY_HEADER,
  fieldName,
  missingReceiptFields,
  requiredReceiptFields,
  type FormContext,
} from '@/lib/fields';
import { amountToInput, formatDate, formatDateFriendly, formatMoney, formatWeekday, parseAmount, todayIso, toIsoDate } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import {
  invoiceTotalInForm,
  MAX_INVOICES,
  needsEquivalent,
  sameAmounts,
  sameIds,
  type InvoiceMoney,
  type InvoiceSummary,
} from '@/lib/invoices';
import {
  effectiveOf,
  fieldLabel,
  isCorrected,
  isHeaderKey,
  missingOf,
  originalOf,
  REQUIRED_FIELDS,
  sameInvoice,
  type Edits,
  type HeaderKey,
} from '@/lib/invoiceEdit';
import { pickInvoices, type InvoiceSource } from '@/lib/pickers';
import { autoSendFailure } from '@/lib/reading';
import { minTouch, radius, spacing, useTheme } from '@/theme';

import { ApprovalPreview } from './ApprovalPreview';
import { CalendarSheet } from './CalendarSheet';
import { InvoiceEditSheet } from './InvoiceEditSheet';
import { OptionPickerSheet, type PickOption } from './OptionPickerSheet';
import { ReadingCard } from './ReadingCard';
import { ReceiptFields } from './ReceiptFields';
import { SelectField } from './SelectField';
import { SourcePicker, type SourceChoice } from './SourcePicker';

interface Values {
  baslik: string;
  kategoriId: number | null;
  masrafTarihi: string;
  tutar: string;
  /** Empty means the server's local currency. */
  paraBirimi: string;
  kur: string;
  satici: string;
  aciklama: string;
}

type FieldKey = keyof Values | 'faturaIdler' | 'masrafMerkeziId';
const FIELD_KEYS: readonly FieldKey[] = [
  'baslik',
  'kategoriId',
  'masrafTarihi',
  'tutar',
  'paraBirimi',
  'kur',
  'satici',
  'aciklama',
  'faturaIdler',
  'masrafMerkeziId',
];
/** Server errors for a receipt's field values: `fisAlanlari.<invoice id or file SHA-256>[.<field key>]`. */
const RECEIPT_FIELD = /^fisAlanlari\.([^.]+)(?:\.(.+))?$/;
/** Up to this many cost centres show as chips; more open a list. */
const CENTRE_CHIPS_MAX = 4;
/** Server errors for one invoice of the list: `faturaIdler.<index in the sent list>`. */
const INVOICE_FIELD = /^faturaIdler\.(\d+)$/;
/** Server errors for a correction: `faturaDuzeltmeleri.<invoice id>[.<path>]`. */
const CORRECTION_FIELD = /^faturaDuzeltmeleri\.([^.]+)(?:\.(.+))?$/;
/** Server errors for a missing field or a duplicate: `faturalar.<invoice id>[.<field>]`. */
const INVOICE_INFO_FIELD = /^faturalar\.([^.]+)(?:\.(.+))?$/;
/** Server errors for one invoice's base-currency equivalent: `yerelKarsiliklar.<invoice id>`. */
const EQUIVALENT_FIELD = /^yerelKarsiliklar\.(.+)$/;
/** Server errors for a pending file: `bekleyenFaturalar.<index in the sent list>`. */
const PENDING_FIELD = /^bekleyenFaturalar\.(\d+)$/;

/** An equivalent the server accepts: positive, at most 2 decimals. */
const validEquivalent = (value: number | null): value is number => value !== null && value > 0 && /^\d+(\.\d{1,2})?$/.test(String(value));

const BASE_CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP'] as const;

const ADD_SOURCES: readonly { value: InvoiceSource; title: string; icon: IconName; label: string; hint: string }[] = [
  { value: 'kamera', title: 'Kamera', icon: 'camera', label: 'Kamerayla fatura ekle', hint: 'Fişin fotoğrafını çekip listeye ekler' },
  { value: 'galeri', title: 'Galeri', icon: 'images', label: 'Galeriden fatura ekle', hint: 'Kayıtlı fotoğraflardan bir ya da birkaçını ekler' },
  { value: 'dosya', title: 'Dosya', icon: 'document-text', label: 'Dosyadan fatura ekle', hint: 'e-Fatura veya PDF dosyası ekler' },
];

export interface ExpenseFormProps {
  readonly mode: 'create' | 'edit';
  /** The form being edited (edit mode). */
  readonly initial?: MasrafDetay;
  /** Opens this source right away (e.g. "Fiş tara" on the home screen). */
  readonly autoSource?: InvoiceSource;
  /** Edit mode: opens this invoice's "Fatura bilgileri" right away (the "Eksikleri tamamla" path). */
  readonly focusInvoice?: string;
  /** Called after a successful save; `sent` is true when the form went to approval. */
  readonly onDone: (detail: MasrafDetay, sent: boolean) => void;
}

function initialValues(initial: MasrafDetay | undefined): Values {
  if (initial === undefined) {
    return { baslik: '', kategoriId: null, masrafTarihi: todayIso(), tutar: '', paraBirimi: '', kur: '', satici: '', aciklama: '' };
  }
  return {
    baslik: initial.baslik,
    kategoriId: initial.kategori.id,
    masrafTarihi: initial.masrafTarihi,
    tutar: amountToInput(initial.tutar),
    paraBirimi: initial.paraBirimi,
    kur: initial.kur === null ? '' : String(initial.kur).replace('.', ','),
    satici: initial.satici ?? '',
    aciklama: initial.aciklama ?? '',
  };
}

type TextKey = Exclude<keyof Values, 'kategoriId'>;

interface FormState {
  readonly values: Values;
  /** Fields the user typed into; in edit mode also every field the saved form had filled. */
  readonly touched: Partial<Record<keyof Values, boolean>>;
  /** The amount was last set from the invoices, so it keeps following them as they change. */
  readonly amountAuto: boolean;
  /** The amount followed the invoices and none adds to it any more, so it was emptied. */
  readonly amountCleared: boolean;
  /**
   * Base-currency equivalents typed for invoices in a third currency, by invoice id. Kept while the form's
   * currency changes, but only those the invoices need are counted and sent.
   */
  readonly equivalents: Readonly<Record<string, string>>;
}

const cents = (value: number): number => Math.round(value * 100);
const ISO_CURRENCY = /^[A-Z]{3}$/;

function initialState(initial: MasrafDetay | undefined, localCurrency: string): FormState {
  const values = initialValues(initial);
  if (initial === undefined) return { values, touched: {}, amountAuto: false, amountCleared: false, equivalents: {} };
  // The saved form was filled on purpose: an invoice added now only fills fields that are still empty.
  const touched: Partial<Record<keyof Values, boolean>> = {};
  for (const key of Object.keys(values) as (keyof Values)[]) {
    const value = values[key];
    if (value !== null && value !== '') touched[key] = true;
  }
  // A saved amount equal to its invoices' total keeps following them as invoices change (as on the panel).
  const sum = invoiceTotalInForm(initial.paraBirimi, localCurrency.toUpperCase(), initial.kur, initial.faturalar);
  const follows = sum !== null && initial.tutar !== null && cents(sum.total) === cents(initial.tutar);
  if (follows) delete touched.tutar;
  const equivalents: Record<string, string> = {};
  for (const f of initial.faturalar) if (f.yerelKarsilik !== null) equivalents[f.id] = amountToInput(f.yerelKarsilik);
  return { values, touched, amountAuto: follows, amountCleared: false, equivalents };
}

/** What each invoice adds to the total, with the equivalent typed for it. */
function moneyOf(list: readonly InvoiceAttachment[], equivalents: Readonly<Record<string, string>>, edits: Edits): InvoiceMoney[] {
  return list.flatMap((item) => {
    const summary = effectiveOf(item, edits)?.fatura ?? null;
    if (summary === null) return [];
    const id = attachmentId(item);
    const value = id === null ? null : parseAmount(equivalents[id] ?? '');
    return [{ genelToplam: summary.genelToplam, paraBirimi: summary.paraBirimi, yerelKarsilik: validEquivalent(value) ? value : null }];
  });
}

/**
 * Fills the form from its invoices. The first invoice with read data fills the currency, date, seller and
 * title once it is read (`readKey`), but only fields the user has not typed into or that are empty. Until
 * the user types an amount, it is the invoices' total in the form's currency: invoices in that currency
 * plus base-currency invoices and entered equivalents divided by the rate (without a rate only the
 * former). When no invoice adds to it any more, an amount that came from the invoices is emptied rather
 * than left in the wrong currency or for invoices that are gone.
 */
function fillState(
  state: FormState,
  list: readonly InvoiceAttachment[],
  readKey: string | null,
  localCurrency: string,
  edits: Edits,
): FormState {
  const before = state.values;
  const fillable = (key: TextKey): boolean => state.touched[key] !== true || before[key].trim() === '';
  let values = before;
  if (readKey !== null) {
    const first = list.find((item) => effectiveOf(item, edits) !== null);
    const f = first !== undefined && first.key === readKey ? (effectiveOf(first, edits)?.fatura ?? null) : null;
    if (f !== null) {
      const next = { ...values };
      if (f.paraBirimi !== null && ISO_CURRENCY.test(f.paraBirimi) && fillable('paraBirimi')) next.paraBirimi = f.paraBirimi;
      if (f.faturaTarihi !== null && f.faturaTarihi <= todayIso() && fillable('masrafTarihi')) next.masrafTarihi = f.faturaTarihi;
      if (f.saticiUnvan !== null && f.saticiUnvan.trim() !== '') {
        if (fillable('satici')) next.satici = f.saticiUnvan;
        if (fillable('baslik')) next.baslik = f.saticiUnvan.slice(0, 120);
      }
      values = next;
    }
  }
  let { amountAuto, amountCleared } = state;
  const typed = state.touched.tutar === true && !amountAuto && values.tutar.trim() !== '';
  if (!typed) {
    const baseCurrency = localCurrency.toUpperCase();
    const currency = (values.paraBirimi === '' ? baseCurrency : values.paraBirimi).toUpperCase();
    const rate = currency === baseCurrency ? null : parseAmount(values.kur);
    const sum = invoiceTotalInForm(currency, baseCurrency, rate, moneyOf(list, state.equivalents, edits));
    if (sum !== null) {
      const tutar = amountToInput(sum.total);
      if (values.tutar !== tutar) values = { ...values, tutar };
      amountAuto = true;
      amountCleared = false;
    } else if (amountAuto && values.tutar !== '') {
      values = { ...values, tutar: '' };
      amountAuto = false;
      amountCleared = true;
    } else {
      amountAuto = false;
    }
  }
  return { ...state, values, amountAuto, amountCleared };
}

/** The saved form's fields as a PATCH would carry them; the base edits are measured against. */
interface SavedFields {
  readonly baslik: string;
  readonly kategoriId: number;
  readonly masrafTarihi: string;
  /** Null: left empty on a draft, the server fills it once the invoices are read. */
  readonly tutar: number | null;
  readonly paraBirimi: string;
  readonly kur: number | null;
  readonly satici: string | null;
  readonly aciklama: string | null;
  readonly faturaIdler: readonly string[];
  readonly yerelKarsiliklar: Readonly<Record<string, number>>;
  /** SHA-256 of the pending invoice files. */
  readonly bekleyenFaturalar: readonly string[];
  readonly okununcaGonder: boolean;
  readonly masrafMerkeziId: number | null;
}

const emptyToNull = (text: string | null): string | null => (text === null || text.trim() === '' ? null : text);

function savedFields(d: MasrafDetay): SavedFields {
  return {
    baslik: d.baslik,
    kategoriId: d.kategori.id,
    masrafTarihi: d.masrafTarihi,
    tutar: d.tutar,
    paraBirimi: d.paraBirimi,
    kur: d.kur,
    satici: emptyToNull(d.satici),
    aciklama: emptyToNull(d.aciklama),
    faturaIdler: d.faturalar.map((f) => f.id),
    yerelKarsiliklar: Object.fromEntries(d.faturalar.flatMap((f) => (f.yerelKarsilik === null ? [] : [[f.id, f.yerelKarsilik] as const]))),
    bekleyenFaturalar: d.bekleyenFaturalar.map((b) => b.dosyaOzeti),
    okununcaGonder: d.okununcaGonder,
    masrafMerkeziId: d.masrafMerkezi?.id ?? null,
  };
}

/**
 * The form's fields as this screen would save them. `okununcaGonder` undefined leaves the option as it
 * is; `masrafMerkeziId` undefined leaves the cost centre alone (the field is off or not known yet).
 */
type NextFields = Omit<SavedFields, 'okununcaGonder' | 'masrafMerkeziId'> & {
  readonly okununcaGonder: boolean | undefined;
  readonly masrafMerkeziId: number | null | undefined;
};

/** Receipt field values by receipt, as `fisAlanlari` carries them. */
type ReceiptPayload = Record<string, Record<string, FisDegeri>>;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

const sameAmount = (a: number | null, b: number | null): boolean => (a === null || b === null ? a === b : cents(a) === cents(b));

/**
 * Only what the user changed since the screen opened. PATCH leaves fields it does not get as they are, so
 * a change made elsewhere meanwhile (e.g. an invoice added on the web panel) is not overwritten by stale
 * values. A rate belongs to its currency, so the two always go together.
 */
function editPatch(
  next: NextFields,
  base: SavedFields,
  faturaDuzeltmeleri: Readonly<Record<string, OkunanFatura | null>>,
  fisAlanlari: ReceiptPayload,
): MasrafGuncelleIstegi {
  const patch: Mutable<MasrafGuncelleIstegi> = {};
  if (next.baslik !== base.baslik) patch.baslik = next.baslik;
  if (next.kategoriId !== base.kategoriId) patch.kategoriId = next.kategoriId;
  if (next.masrafTarihi !== base.masrafTarihi) patch.masrafTarihi = next.masrafTarihi;
  if (!sameAmount(next.tutar, base.tutar)) patch.tutar = next.tutar;
  if (next.paraBirimi !== base.paraBirimi || next.kur !== base.kur) {
    patch.paraBirimi = next.paraBirimi;
    patch.kur = next.kur;
  }
  if (next.satici !== base.satici) patch.satici = next.satici;
  if (next.aciklama !== base.aciklama) patch.aciklama = next.aciklama;
  // The list replaces the form's invoices entirely, so it goes only when it changed.
  if (!sameIds(next.faturaIdler, base.faturaIdler)) patch.faturaIdler = next.faturaIdler;
  // With a new list the files still being read always go too: an invoice the server added meanwhile from
  // one of them is then put back on the list (contract section 6, rule 3) instead of being dropped.
  if (patch.faturaIdler !== undefined || !sameSet(next.bekleyenFaturalar, base.bekleyenFaturalar)) patch.bekleyenFaturalar = next.bekleyenFaturalar;
  // The equivalents replace the stored ones as a whole: sent when they changed, and with a new list.
  if (patch.faturaIdler !== undefined || !sameAmounts(next.yerelKarsiliklar, base.yerelKarsiliklar)) patch.yerelKarsiliklar = next.yerelKarsiliklar;
  if (next.okununcaGonder !== undefined && next.okununcaGonder !== base.okununcaGonder) patch.okununcaGonder = next.okununcaGonder;
  // Only the corrections that changed; the server keeps the others.
  if (Object.keys(faturaDuzeltmeleri).length > 0) patch.faturaDuzeltmeleri = faturaDuzeltmeleri;
  if (next.masrafMerkeziId !== undefined && next.masrafMerkeziId !== base.masrafMerkeziId) patch.masrafMerkeziId = next.masrafMerkeziId;
  // Only receipts whose values changed; each listed receipt's values are replaced as a whole.
  if (Object.keys(fisAlanlari).length > 0) patch.fisAlanlari = fisAlanlari;
  return patch;
}

/** The receipt's name as the user knows it: the file name, else the invoice number. */
function itemName(item: InvoiceAttachment): string {
  if (item.kind === 'server') return item.fatura.dosyaAdi ?? item.fatura.faturaNo ?? 'Fatura';
  if (item.kind === 'pending') return item.bekleyen.dosyaAdi;
  return item.file.name;
}

/** What the field rules say about one receipt. */
interface ReceiptState {
  /** receiptKey: where its values live. */
  readonly rk: string;
  /** Required fields (header and receipt fields); null while the definitions are not known. */
  readonly required: readonly string[] | null;
  readonly requiredSet: ReadonlySet<string>;
  /** Required receipt fields (not header fields) still empty. */
  readonly missingFields: readonly string[];
  /** Required header fields empty in the effective information; read invoices only. */
  readonly missingHeader: readonly HeaderKey[];
}

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * What a save led to, for the toast and the caller: sent (by the user, or by "okununca gönder" right after
 * the save when nothing was left to read), or what happens next while invoices are read in the background.
 */
function savedOutcome(
  detail: MasrafDetay,
  send: boolean,
  autoSend: boolean,
  created: boolean,
): { readonly message: string; readonly tone: ToastTone; readonly sent: boolean } {
  if (send || detail.durum === 'onayda') return { message: 'Masraf onaya gönderildi.', tone: 'success', sent: true };
  const saved = created ? 'Taslak kaydedildi.' : 'Değişiklikler kaydedildi.';
  const reading = detail.bekleyenFaturalar.filter((b) => b.durum !== 'hata').length;
  if (reading > 0) {
    const when = reading === 1 ? 'Fatura okununca' : 'Faturalar okununca';
    return {
      message: detail.okununcaGonder ? `${saved} ${when} masraf onaya gönderilecek ve bildirim gelecek.` : `${saved} ${when} bildirim gelecek.`,
      tone: 'success',
      sent: false,
    };
  }
  if (detail.bekleyenFaturalar.length > 0) return { message: `${saved} Okunamayan faturaları yeniden okutun ya da kaldırın.`, tone: 'info', sent: false };
  // The option was on and nothing was left to read: the server tried at once and could not send. No
  // notification comes for the user's own save; the reason is in the form's history.
  if (autoSend && !detail.okununcaGonder) return { message: `${saved} ${autoSendFailure(detail)}`, tone: 'info', sent: false };
  return { message: saved, tone: 'success', sent: false };
}

function without2<V>(record: Readonly<Record<string, V>>, key: string): Readonly<Record<string, V>> {
  if (!(key in record)) return record;
  const next: Record<string, V> = { ...record };
  delete next[key];
  return next;
}

function without(record: Readonly<Record<string, string>>, key: string): Readonly<Record<string, string>> {
  if (!(key in record)) return record;
  const next: Record<string, string> = { ...record };
  delete next[key];
  return next;
}

export function ExpenseForm({ mode, initial, autoSource, focusInvoice, onDone }: ExpenseFormProps) {
  const { colors } = useTheme();
  const motion = useMotion();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const toast = useToast();
  const changed = useMasrafChanged();
  const kategoriler = useKategoriler();
  const ozet = useOzet();
  // Field definitions and rules (receipt fields, cost centre); the user's own cost centres come with GET /api/ben.
  const alanlar = useAlanlar();
  const ben = useBen();
  const scrollRef = useRef<ScrollViewInstance>(null);
  // Keys of the invoices in the last list sent to the server, to place `faturaIdler.<i>` errors.
  const sentKeys = useRef<readonly string[]>([]);
  // File names of the pending files in the last `bekleyenFaturalar` sent, to word `bekleyenFaturalar.<i>` errors.
  const sentPendingNames = useRef<readonly string[]>([]);
  const picking = useRef(false);
  const autoStarted = useRef(false);
  // Set synchronously when a save starts, so a tap in the same frame cannot add or remove invoices.
  const saving = useRef(false);
  const mounted = useRef(false);

  // The base currency (PARA_BIRIMI) comes from GET /api/ozet; TRY until it has loaded.
  const localCurrency = ozet.data?.paraBirimi ?? 'TRY';
  const [form, setForm] = useState<FormState>(() => initialState(initial, localCurrency));
  // The saved form as it was when this screen opened. `initial` is refetched in the background (focus,
  // staleness); the form must neither reset what the user entered nor measure changes against a newer
  // copy, which would drop invoices or fields changed elsewhere meanwhile.
  const [base, setBase] = useState<SavedFields | null>(() => (initial === undefined ? null : savedFields(initial)));
  const values = form.values;
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [invoiceErrors, setInvoiceErrors] = useState<Readonly<Record<string, string>>>({});
  // Errors for equivalents, by invoice id.
  const [equivalentErrors, setEquivalentErrors] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [manual, setManual] = useState(mode === 'edit');
  const [busy, setBusy] = useState<'draft' | 'send' | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  // Corrections made on this screen, by invoice id. The ref is the latest value inside async callbacks.
  const [edits, setEditsState] = useState<Edits>({});
  const editsRef = useRef<Edits>({});
  // What the server already holds of those corrections (as JSON), so a second save does not send them again.
  const savedEdits = useRef<Record<string, string>>({});
  // The invoice whose "Fatura bilgileri" sheet is open (its list key).
  const [editingKey, setEditingKey] = useState<string | null>(null);
  // Server errors on an invoice's fields, by invoice id: `fatura.<field>` or `kalemler.<i>.<field>`.
  const [editErrors, setEditErrors] = useState<Readonly<Record<string, Readonly<Record<string, string>>>>>({});
  // "Okumalar bitince onaya gönder". It follows the saved form until the user flips it here.
  const [autoSend, setAutoSend] = useState(initial?.okununcaGonder ?? false);
  const autoSendTouched = useRef(false);
  // Edit mode: the copy of the saved form the list was last brought up to (see the sync effect below).
  const synced = useRef(initial);
  const [rereading, setRereading] = useState(false);
  // Receipt field values by receipt (see receiptKey), and which receipts' "Fiş bilgileri" the user opened or closed.
  const receipts = useReceiptValues(initial);
  const [opened, setOpened] = useState<Readonly<Record<string, boolean>>>({});
  // The cost centre: the saved one, or what the user picked (touched also when they cleared it).
  const [centre, setCentre] = useState<{ readonly id: number | null; readonly touched: boolean }>({
    id: initial?.masrafMerkezi?.id ?? null,
    touched: false,
  });
  const [centreSheet, setCentreSheet] = useState(false);
  // The receipt field whose option list or calendar is open; kept after closing so the sheet can slide out.
  const [pick, setPick] = useState<{ readonly rk: string; readonly field: AlanTanimi; readonly name: string } | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [dateTarget, setDateTarget] = useState<{ readonly rk: string; readonly field: AlanTanimi } | null>(null);
  const [dateOpen, setDateOpen] = useState(false);

  const baseCurrency = localCurrency.toUpperCase();
  const currencyOf = (paraBirimi: string): string => (paraBirimi === '' ? localCurrency : paraBirimi).toUpperCase();
  const currency = currencyOf(values.paraBirimi);
  const needsKur = currency !== localCurrency.toUpperCase();
  const amount = parseAmount(values.tutar);
  const kur = parseAmount(values.kur);

  const fillFromInvoices = (list: readonly InvoiceAttachment[], readKey: string | null): void => {
    setForm((f) => fillState(f, list, readKey, localCurrency, editsRef.current));
  };

  const attachments = useInvoiceAttachments(initial?.faturalar ?? [], initial?.bekleyenFaturalar ?? [], {
    onRead: (key, list) => {
      fillFromInvoices(list, key);
      haptics.success();
    },
    onDuplicate: () => {
      haptics.warning();
      toast('Bu fatura masrafa zaten ekli; ikinci kez eklenmedi.', 'info');
    },
    onFailed: () => haptics.warning(),
  });

  const items = attachments.items;
  const attached = items.flatMap((item) => {
    const id = attachmentId(item);
    return id === null ? [] : [{ key: item.key, id, summary: effectiveOf(item, edits)?.fatura ?? null }];
  });
  const faturaIdler = attached.map((a) => a.id);
  const readingCount = items.filter(isReading).length;
  const pendingFailedCount = items.filter(isPendingFailed).length;
  // Files still to be read (here or in the background) or that the server could not read: the form can be
  // saved as a draft but not sent.
  const hasPending = attachments.reading || pendingFailedCount > 0;
  const bekleyenFaturalar = pendingHashes(items);
  // A draft's amount may stay empty; a returned form's amount cannot be cleared (contract section 6).
  const draftOnly = mode === 'create' || initial?.durum === 'taslak';
  const canSend = mode === 'create' || initial?.izinler.gonder === true;
  // While invoices are still to be read, an amount that follows them (or is empty) is not saved: the server
  // fills it once all are read. A part total saved now would count as typed and stay as it is.
  const amountDeferred = draftOnly && hasPending && (values.tutar.trim() === '' || form.amountAuto);
  const kurValid = kur !== null && kur > 0;
  const money = moneyOf(items, form.equivalents, edits);
  const invoiceSum = invoiceTotalInForm(currency, baseCurrency, needsKur ? kur : null, money);
  // Base-currency amounts that would count once a rate is typed.
  const waitingForRate = needsKur && !kurValid && (invoiceTotalInForm(currency, baseCurrency, 1, money)?.count ?? 0) > (invoiceSum?.count ?? 0);
  // Invoices in a third currency need their base-currency equivalent; only theirs are counted and sent.
  const equivalentOf = (id: string): number | null => parseAmount(form.equivalents[id] ?? '');
  const needingEquivalent = attached.filter((a) => a.summary !== null && needsEquivalent(currency, baseCurrency, a.summary));
  const yerelKarsiliklar: Record<string, number> = {};
  for (const a of needingEquivalent) {
    const value = equivalentOf(a.id);
    if (validEquivalent(value)) yerelKarsiliklar[a.id] = value;
  }
  const missingEquivalents = needingEquivalent.filter((a) => yerelKarsiliklar[a.id] === undefined).length;
  const hasEquivalents = Object.keys(yerelKarsiliklar).length > 0;

  // --- Fields and rules (contract section 3): the cost centre and each receipt's fields ---
  const defs = alanlar.data;
  const receiptFieldDefs = defs === undefined ? [] : editableReceiptFields(defs);
  // Only active fields come back; without the cost centre among them the form has none (and may send none).
  const centreField = defs?.alanlar.find((f) => f.anahtar === COST_CENTRE_KEY && f.aktif);
  const assignedCentres = ben.data?.kullanici.masrafMerkezleri ?? [];
  const activeCentres = assignedCentres.filter((m) => m.aktif);
  const storedCentre = initial?.masrafMerkezi ?? null;
  // A user with exactly one active cost centre has it chosen until they choose otherwise.
  const onlyCentre = activeCentres.length === 1 ? (activeCentres[0]?.id ?? null) : null;
  const masrafMerkeziId = centre.touched || centre.id !== null ? centre.id : onlyCentre;
  const centreOptions: PickOption[] = [
    ...activeCentres.map((m) => ({ id: m.id, gosterim: m.gosterim })),
    // The saved value stays on show (and can be saved again) after it was deactivated or unassigned.
    ...(storedCentre !== null && !activeCentres.some((m) => m.id === storedCentre.id)
      ? [{ id: storedCentre.id, gosterim: storedCentre.gosterim, note: storedCentre.aktif ? 'Size artık tanımlı değil' : 'Pasif' }]
      : []),
  ];
  const chosenCentre = centreOptions.find((o) => o.id === masrafMerkeziId) ?? null;
  const formContext: FormContext = { kategoriId: values.kategoriId, masrafMerkeziId };
  const centreRequired = defs !== undefined && costCentreRequired(defs, formContext);
  const headerHelp: Record<string, string> = {};
  for (const f of defs?.alanlar ?? []) if (f.tur === 'fatura' && f.aciklama !== null) headerHelp[f.anahtar] = f.aciklama;

  /** Required and missing fields of one receipt, from its own values and the form's category and cost centre. */
  const receiptState = (item: InvoiceAttachment): ReceiptState => {
    const rk = receiptKey(item);
    if (defs === undefined) return { rk, required: null, requiredSet: NO_KEYS, missingFields: [], missingHeader: missingOf(item, edits, null) };
    const own = conditionValues(receipts.of(rk));
    const required = requiredReceiptFields(defs, formContext, own);
    // A file not read yet has no header to check.
    const header = attachmentId(item) === null ? null : (effectiveOf(item, edits)?.fatura ?? EMPTY_HEADER);
    return {
      rk,
      required,
      requiredSet: new Set(required),
      missingFields: missingReceiptFields(defs, formContext, own, header).filter((key) => !isHeaderKey(key)),
      missingHeader: missingOf(item, edits, required),
    };
  };
  const states = new Map(items.map((item) => [item.key, receiptState(item)] as const));
  const stateOf = (item: InvoiceAttachment): ReceiptState => states.get(item.key) ?? receiptState(item);
  // A file that could not be read on this device is not saved, so it has no fields.
  const hasFields = (item: InvoiceAttachment): boolean => receiptFieldDefs.length > 0 && !isFailed(item);
  const incompleteReceipts = items.filter((item) => hasFields(item) && stateOf(item).missingFields.length > 0).length;
  const expandedOf = (rk: string): boolean => opened[rk] ?? items.length === 1;

  const setCentreId = (id: number | null): void => {
    setCentre({ id, touched: true });
    if (errors.masrafMerkeziId !== undefined) setErrors((e) => ({ ...e, masrafMerkeziId: undefined }));
  };

  const setReceiptValue = (rk: string, anahtar: string, value: DraftValue | null): void => {
    if (saving.current) return;
    receipts.set(rk, anahtar, value);
  };

  /**
   * `fisAlanlari` for the save: on a new form every receipt with a value, on a saved one the receipts
   * whose values changed here. A receipt is keyed by its invoice id, or by its file's SHA-256 while read.
   * Values that cannot go (a number that is not one) come back as errors by receipt.
   */
  const receiptPayload = (): { readonly payload: ReceiptPayload; readonly sent: readonly string[] } | { readonly errors: Record<string, Record<string, string>> } => {
    const payload: ReceiptPayload = {};
    const sent: string[] = [];
    const errs: Record<string, Record<string, string>> = {};
    if (defs === undefined) return { payload, sent };
    for (const item of items) {
      const key = requestKey(item);
      if (isFailed(item) || key === null) continue;
      const rk = receiptKey(item);
      const draft = receipts.of(rk);
      if (mode === 'create' ? Object.keys(draft).length === 0 : !receipts.changed(rk)) continue;
      const result = requestValues(receiptFieldDefs, draft);
      if ('errors' in result) {
        errs[rk] = result.errors;
        continue;
      }
      if (mode === 'create' && Object.keys(result.values).length === 0) continue;
      payload[key] = result.values;
      sent.push(rk);
    }
    return Object.keys(errs).length > 0 ? { errors: errs } : { payload, sent };
  };

  const openPicker = (item: InvoiceAttachment, field: AlanTanimi): void => {
    if (saving.current) return;
    setPick({ rk: receiptKey(item), field, name: itemName(item) });
    setPickOpen(true);
  };

  const openDate = (item: InvoiceAttachment, field: AlanTanimi): void => {
    if (saving.current) return;
    setDateTarget({ rk: receiptKey(item), field });
    setDateOpen(true);
  };

  const set = <K extends keyof Values>(key: K, value: Values[K]): void => {
    setForm((f) => ({
      ...f,
      values: { ...f.values, [key]: value },
      touched: { ...f.touched, [key]: true },
      // A typed amount stops following the invoices.
      ...(key === 'tutar' ? { amountAuto: false, amountCleared: false } : {}),
    }));
    if (errors[key] !== undefined) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const choose = async (choice: SourceChoice): Promise<void> => {
    if (choice === 'elle') {
      setManual(true);
      return;
    }
    if (saving.current) return;
    const room = MAX_INVOICES - items.length;
    if (room <= 0) {
      haptics.warning();
      toast(`Bir masrafa en çok ${MAX_INVOICES} fatura eklenebilir.`, 'info');
      return;
    }
    if (picking.current) return;
    picking.current = true;
    try {
      const files = await pickInvoices(choice, room);
      // The screen may have closed while the system picker was open; nothing can be attached any more.
      if (!mounted.current || files.length === 0) return;
      if (saving.current) {
        toast('Kaydedilirken fatura eklenemez; kayıt bitince tekrar ekleyin.', 'info');
        return;
      }
      setFormError(null);
      setErrors((e) => ({ ...e, faturaIdler: undefined }));
      const accepted = files.slice(0, room);
      for (const file of accepted) attachments.add(file);
      if (accepted.length < files.length) {
        toast(`Bir masrafa en çok ${MAX_INVOICES} fatura eklenebilir; ilk ${accepted.length} dosya eklendi.`, 'info');
      }
    } catch (err) {
      haptics.error();
      setFormError(err instanceof Error && err.message !== '' ? `Dosya seçilemedi: ${err.message}` : 'Dosya seçilemedi.');
    } finally {
      picking.current = false;
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // "Eksikleri tamamla" lands on the invoice with the missing information: its "Fatura bilgileri" when a
  // header field is missing, else its "Fiş bilgileri" opened.
  useEffect(() => {
    if (focusInvoice === undefined) return;
    const target = items.find((i) => attachmentId(i) === focusInvoice);
    if (target === undefined) return;
    if (target.kind === 'server' && !target.fatura.eksikAlanlar.some(isHeaderKey)) setOpened((o) => ({ ...o, [receiptKey(target)]: true }));
    else setEditingKey(target.key);
    // Once, when the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Fiş tara" opens the camera as soon as the screen is up.
  useEffect(() => {
    if (autoSource === undefined || autoStarted.current) return;
    autoStarted.current = true;
    void choose(autoSource);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSource]);

  const removeInvoice = (key: string): void => {
    if (saving.current) return;
    const removed = items.find((item) => item.key === key);
    const removedId = removed === undefined ? null : attachmentId(removed);
    // A typed equivalent stays in memory, so re-adding the invoice brings it back.
    if (removedId !== null) setEquivalentErrors((e) => without(e, removedId));
    const list = attachments.remove(key);
    setInvoiceErrors((e) => without(e, key));
    setErrors((e) => ({ ...e, faturaIdler: undefined }));
    if (list.length === 0) setManual(true);
    fillFromInvoices(list, null);
  };

  const setEquivalent = (id: string, text: string): void => {
    const clean = text.replace(/[^0-9.,]/g, '');
    setForm((f) => ({ ...f, equivalents: { ...f.equivalents, [id]: clean } }));
    setEquivalentErrors((e) => without(e, id));
    fillFromInvoices(items, null);
  };

  const retryInvoice = (key: string): void => {
    if (saving.current) return;
    setInvoiceErrors((e) => without(e, key));
    attachments.retry(key);
  };

  /**
   * Edit mode: takes in a newer copy of the saved form. Pending invoices follow the server; invoices the
   * server added from them fill the form like any read invoice, without overwriting what the user typed.
   * The amount and seller the server filled by itself are taken over where the form is still empty, and
   * become the base so saving does not clear them.
   */
  const applyServerCopy = (detail: MasrafDetay): void => {
    const { list, arrived, newIds } = attachments.sync(detail);
    // Receipt values the user has not changed here follow the server (a file read into an invoice keeps its own).
    receipts.adopt(detail);
    const filledTutar = base !== null && base.tutar === null ? detail.tutar : null;
    const filledSatici = base !== null && base.satici === null ? emptyToNull(detail.satici) : null;
    setForm((f) => {
      let next = arrived.reduce((state, a) => fillState(state, list, a.key, localCurrency, editsRef.current), f);
      if (filledTutar !== null && next.values.tutar.trim() === '') {
        next = { ...next, values: { ...next.values, tutar: amountToInput(filledTutar) }, amountAuto: true, amountCleared: false };
      }
      if (filledSatici !== null && next.values.satici.trim() === '') next = { ...next, values: { ...next.values, satici: filledSatici } };
      return next;
    });
    setBase((b) =>
      b === null
        ? b
        : {
            ...b,
            // Every invoice the server added counts as saved, also one not shown because the user removed its
            // file here: the list on screen then differs, so a save sends it and the server drops that invoice.
            faturaIdler: [...b.faturaIdler, ...newIds.filter((id) => !b.faturaIdler.includes(id))],
            bekleyenFaturalar: detail.bekleyenFaturalar.map((p) => p.dosyaOzeti),
            okununcaGonder: detail.okununcaGonder,
            tutar: b.tutar ?? detail.tutar,
            satici: b.satici ?? emptyToNull(detail.satici),
          },
    );
    if (!autoSendTouched.current) setAutoSend(detail.okununcaGonder);
  };

  // The edit screen's copy of the form is asked again every few seconds while invoices are read in the
  // background (useMasraf); each newer copy brings the list up to date. Skipped while saving: the save's
  // own answer comes in the same way right after.
  useEffect(() => {
    if (mode !== 'edit' || initial === undefined || initial === synced.current || saving.current) return;
    synced.current = initial;
    applyServerCopy(initial);
    // Only when a new copy arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  /** Puts the form's failed pending invoices back in the reading queue (all of them, as the server does). */
  const rereadPending = async (): Promise<void> => {
    if (initial === undefined || saving.current || rereading) return;
    setRereading(true);
    try {
      const detail = await runMasrafAction(initial.id, 'yeniden-oku');
      // The new copy reaches the list through the sync effect above.
      await changed(detail);
      haptics.success();
      toast('Okunamayan faturalar yeniden okuma sırasına alındı.', 'success');
    } catch (err) {
      haptics.error();
      toast(errorMessage(err), 'danger');
    } finally {
      if (mounted.current) setRereading(false);
    }
  };

  /** Corrections to send: only changed ones, only for invoices on the form (contract section 6). */
  const correctionPayload = (): Record<string, OkunanFatura | null> => {
    const out: Record<string, OkunanFatura | null> = {};
    for (const [id, value] of Object.entries(edits)) {
      const item = items.find((i) => attachmentId(i) === id);
      if (item === undefined) continue;
      // Going back to the read result matters only where the server holds a correction.
      if (value === null && !(item.kind === 'server' && item.fatura.duzeltildi)) continue;
      if (JSON.stringify(value) === savedEdits.current[id]) continue;
      out[id] = value;
    }
    return out;
  };
  const corrections = correctionPayload();
  const hasCorrections = Object.keys(corrections).length > 0;

  const openEditor = (key: string): void => {
    if (saving.current) return;
    haptics.tap();
    setEditingKey(key);
  };

  const saveEdit = (item: InvoiceAttachment, value: OkunanFatura | null): void => {
    const id = attachmentId(item);
    if (id === null) return;
    const original = originalOf(item);
    // A value equal to the read result is no correction.
    const next = value !== null && original !== null && sameInvoice(value, original) ? null : value;
    const merged: Edits = { ...editsRef.current, [id]: next };
    editsRef.current = merged;
    setEditsState(merged);
    setEditErrors((e) => without2(e, id));
    setInvoiceErrors((e) => without(e, item.key));
    setEditingKey(null);
    haptics.success();
    // The corrected total follows into the amount; the corrected date into the date (the usual filling rules).
    setForm((f) => fillState(f, items, item.key, localCurrency, merged));
  };

  // The approval amount follows the corrected totals: every corrected invoice goes to the preview.
  const previewCorrections: Record<string, OkunanFatura> = {};
  for (const item of items) {
    const id = attachmentId(item);
    const value = effectiveOf(item, edits);
    if (id !== null && value !== null && isCorrected(item, edits)) previewCorrections[id] = value;
  }

  // No route for an amount that is not final yet (it is not saved; the server fills it once all are read).
  const previewRequest: OnizlemeIstegi | null =
    !amountDeferred && amount !== null && amount > 0 && (!needsKur || (kur !== null && kur > 0))
      ? {
          tutar: amount,
          paraBirimi: currency,
          ...(needsKur && kur !== null ? { kur } : {}),
          ...(faturaIdler.length > 0 ? { faturaIdler } : {}),
          ...(hasEquivalents ? { yerelKarsiliklar } : {}),
          ...(Object.keys(previewCorrections).length > 0 ? { faturaDuzeltmeleri: previewCorrections } : {}),
        }
      : null;

  /**
   * Quick checks for instant feedback; the server's answer is what counts. Sending also needs every
   * equivalent (contract rule 6); a draft can be saved without them, and a draft's amount may stay empty.
   */
  const validate = (send: boolean): boolean => {
    const local: Partial<Record<FieldKey, string>> = {};
    if (values.baslik.trim() === '') local.baslik = 'Başlık girin.';
    if (values.kategoriId === null) local.kategoriId = 'Bir kategori seçin.';
    const amountOptional = !send && draftOnly && (amountDeferred || values.tutar.trim() === '');
    if (!amountOptional && (amount === null || amount <= 0)) local.tutar = 'Geçerli bir tutar girin.';
    if (needsKur && (kur === null || kur <= 0)) local.kur = `${currency} için kur girin.`;
    const equivalents: Record<string, string> = {};
    for (const a of needingEquivalent) {
      const typed = (form.equivalents[a.id] ?? '').trim() !== '';
      const value = equivalentOf(a.id);
      if (typed && (value === null || value <= 0)) equivalents[a.id] = 'Geçerli bir tutar girin.';
      else if (typed && !validEquivalent(value)) equivalents[a.id] = 'Tutar en fazla 2 ondalık basamak olabilir.';
      else if (send && !typed) equivalents[a.id] = `Onaya göndermek için ${baseCurrency} karşılığını girin.`;
    }
    setErrors(local);
    setEquivalentErrors(equivalents);
    // Receipt values that cannot go (e.g. a number that is not one): shown in their receipts, opened.
    const built = receiptPayload();
    const receiptErrors = 'errors' in built ? built.errors : {};
    receipts.setErrors(receiptErrors);
    if (Object.keys(receiptErrors).length > 0) setOpened((o) => ({ ...o, ...Object.fromEntries(Object.keys(receiptErrors).map((rk) => [rk, true])) }));
    if (Object.keys(equivalents).length > 0 || Object.keys(receiptErrors).length > 0) {
      setFormError(
        send && missingEquivalents > 0
          ? `Onaya göndermek için ${baseCurrency} karşılığı eksik faturalar var. Taslak olarak kaydedebilirsiniz.`
          : 'Bazı alanları düzeltin.',
      );
      scrollRef.current?.scrollTo({ y: 0, animated: !motion.reduced });
    }
    return Object.keys(local).length === 0 && Object.keys(equivalents).length === 0 && Object.keys(receiptErrors).length === 0;
  };

  const applyServerError = (err: unknown): void => {
    haptics.error();
    if (err instanceof ApiError) {
      const fieldErrors: Partial<Record<FieldKey, string>> = {};
      const itemErrors: Record<string, string> = {};
      const equivalentErrorsNext: Record<string, string> = {};
      const editErrorsNext: Record<string, Record<string, string>> = {};
      // Receipt field errors by receipt (receiptKey), then by field key.
      const receiptErrorsNext: Record<string, Record<string, string>> = {};
      const other: string[] = [];
      // Binds a path under an invoice id to that invoice: a field path, or the invoice as a whole.
      const bindToInvoice = (id: string, rest: string | undefined, message: string, prefix: string): boolean => {
        const item = items.find((i) => attachmentId(i) === id);
        if (item === undefined) return false;
        if (rest === undefined) itemErrors[item.key] = message;
        else editErrorsNext[id] = { ...editErrorsNext[id], [`${prefix}${rest}`]: message };
        return true;
      };
      for (const [key, message] of Object.entries(err.alanlar)) {
        // A file the server no longer has ("yeniden yükleyin"): said on top, with the file's name.
        const pending = PENDING_FIELD.exec(key);
        if (pending !== null) {
          const name = sentPendingNames.current[Number(pending[1])];
          other.push(name === undefined ? message : `${name}: ${message}`);
          continue;
        }
        // A receipt field (`fisAlanlari.<receipt>.<field>`, also 409 alan_eksik) or the receipt as a whole.
        const receiptPath = RECEIPT_FIELD.exec(key);
        if (receiptPath !== null) {
          const receiptId = receiptPath[1] as string;
          const item = items.find((i) => isReceipt(i, receiptId));
          if (item !== undefined) {
            const field = receiptPath[2];
            if (field !== undefined && receiptFieldDefs.some((f) => f.anahtar === field)) {
              const rk = receiptKey(item);
              receiptErrorsNext[rk] = { ...receiptErrorsNext[rk], [field]: message };
            } else {
              // The receipt as a whole, or a field without an input here (e.g. turned off meanwhile).
              const text = field === undefined ? message : `${fieldName(defs, field)}: ${message}`;
              // Only a read invoice's card shows an error of its own; for a file being read it goes on top.
              if (attachmentId(item) !== null) itemErrors[item.key] = text;
              else other.push(`${itemName(item)}: ${text}`);
            }
            continue;
          }
        }
        const correction = CORRECTION_FIELD.exec(key);
        if (correction !== null && bindToInvoice(correction[1] as string, correction[2], message, '')) continue;
        const info = INVOICE_INFO_FIELD.exec(key);
        if (info !== null && bindToInvoice(info[1] as string, info[2], message, 'fatura.')) continue;
        const match = INVOICE_FIELD.exec(key);
        const itemKey = match !== null ? sentKeys.current[Number(match[1])] : undefined;
        const equivalentId = EQUIVALENT_FIELD.exec(key)?.[1];
        if (equivalentId !== undefined && faturaIdler.includes(equivalentId)) equivalentErrorsNext[equivalentId] = message;
        else if (itemKey !== undefined) itemErrors[itemKey] = message;
        else if (match !== null) fieldErrors.faturaIdler = message;
        // The cost centre's message has no place while its field is not shown (definitions not loaded).
        else if (key === 'masrafMerkeziId' && centreField === undefined) other.push(message);
        else if ((FIELD_KEYS as readonly string[]).includes(key)) fieldErrors[key as FieldKey] = message;
        else other.push(message);
      }
      // A race on the same invoice can come back without `alanlar`; show it on the invoice list.
      if (err.kod === 'fatura_kullaniliyor' && Object.keys(itemErrors).length === 0 && fieldErrors.faturaIdler === undefined) {
        fieldErrors.faturaIdler = err.message;
      }
      setErrors(fieldErrors);
      setInvoiceErrors(itemErrors);
      setEquivalentErrors(equivalentErrorsNext);
      setEditErrors(editErrorsNext);
      receipts.setErrors(receiptErrorsNext);
      // Receipts with an error open, so the marked field is in sight.
      const flagged = Object.keys(receiptErrorsNext);
      if (flagged.length > 0) setOpened((o) => ({ ...o, ...Object.fromEntries(flagged.map((rk) => [rk, true])) }));
      const hasFieldErrors =
        Object.keys(fieldErrors).length > 0 ||
        Object.keys(itemErrors).length > 0 ||
        Object.keys(equivalentErrorsNext).length > 0 ||
        Object.keys(editErrorsNext).length > 0 ||
        flagged.length > 0;
      setFormError(
        err.kod === 'karsilik_eksik'
          ? `Onaya göndermek için ${baseCurrency} karşılığı eksik faturalar var. Taslak olarak kaydedebilirsiniz.`
          : err.kod === 'fatura_eksik'
            ? 'Onaya göndermek için faturaların zorunlu bilgileri dolu olmalı. Eksik olan faturalara dokunup doldurun ya da taslak olarak kaydedin.'
            : err.kod === 'alan_eksik'
              ? [
                  'Onaya göndermek için zorunlu alanlar dolu olmalı.',
                  hasFieldErrors ? 'Eksik alanlar işaretlendi; doldurun ya da taslak olarak kaydedin.' : err.message,
                  ...other,
                ].join('\n')
              : err.kod === 'fatura_mukerrer' || err.kod === 'tutar_eksik'
                ? err.message
                : hasFieldErrors
                  ? other.length > 0
                    ? other.join('\n')
                    : 'Bazı alanları düzeltin.'
                  : Array.from(new Set([err.message, ...other, ...err.sorunlar])).join('\n'),
      );
    } else {
      setFormError(errorMessage(err));
    }
    scrollRef.current?.scrollTo({ y: 0, animated: !motion.reduced });
  };

  const save = async (send: boolean): Promise<void> => {
    if (saving.current) return;
    // validate() already stopped values that cannot go; this is the same build.
    const built = receiptPayload();
    if ('errors' in built) return;
    saving.current = true;
    setBusy(send ? 'send' : 'draft');
    setInvoiceErrors({});
    setEditErrors({});
    receipts.setErrors({});
    const sending = corrections;
    const fisAlanlari = built.payload;
    // An empty or deferred amount is not saved on a draft (validate let it through only there).
    const tutar = !send && amountDeferred ? null : amount;
    // "Okumalar bitince onaya gönder" counts only while there is something to wait for; it is never sent
    // with a send (the server refuses the two together).
    const autoSendNow = !send && canSend && hasPending ? autoSend : undefined;
    sentPendingNames.current = bekleyenFaturalar.map((hash) => {
      const item = items.find((i) => pendingHash(i) === hash);
      return item?.kind === 'pending' ? item.bekleyen.dosyaAdi : item?.kind === 'local' ? item.file.name : hash.slice(0, 8);
    });
    const fields = {
      baslik: values.baslik.trim(),
      kategoriId: values.kategoriId as number,
      masrafTarihi: values.masrafTarihi,
      paraBirimi: currency,
    };
    try {
      if (mode === 'create') {
        sentKeys.current = attached.map((a) => a.key);
        const detail = await createMasraf({
          ...fields,
          ...(tutar !== null ? { tutar } : {}),
          ...(needsKur && kur !== null ? { kur } : {}),
          ...(values.satici.trim() !== '' ? { satici: values.satici.trim() } : {}),
          ...(values.aciklama.trim() !== '' ? { aciklama: values.aciklama.trim() } : {}),
          ...(faturaIdler.length > 0 ? { faturaIdler } : {}),
          ...(bekleyenFaturalar.length > 0 ? { bekleyenFaturalar } : {}),
          ...(hasEquivalents ? { yerelKarsiliklar } : {}),
          ...(Object.keys(sending).length > 0 ? { faturaDuzeltmeleri: sending } : {}),
          ...(autoSendNow === true ? { okununcaGonder: true } : {}),
          // Only while the field is on. Left out, the server chooses the user's single active cost centre;
          // a cleared choice goes as null so it does not.
          ...(centreField !== undefined && (masrafMerkeziId !== null || centre.touched) ? { masrafMerkeziId } : {}),
          ...(Object.keys(fisAlanlari).length > 0 ? { fisAlanlari } : {}),
          gonder: send,
        });
        await changed(detail);
        const outcome = savedOutcome(detail, send, autoSendNow === true, true);
        haptics.success();
        toast(outcome.message, outcome.tone);
        onDone(detail, outcome.sent);
        return;
      }
      if (initial === undefined || base === null) return;
      // Edit: PATCH what changed since the screen opened (empty optional text clears it), then send when asked.
      const patch = editPatch(
        {
          ...fields,
          tutar,
          kur: needsKur ? kur : null,
          satici: values.satici.trim() === '' ? null : values.satici.trim(),
          aciklama: values.aciklama.trim() === '' ? null : values.aciklama.trim(),
          faturaIdler,
          yerelKarsiliklar,
          bekleyenFaturalar,
          okununcaGonder: autoSendNow,
          masrafMerkeziId: centreField !== undefined ? masrafMerkeziId : undefined,
        },
        base,
        sending,
        fisAlanlari,
      );
      sentKeys.current = patch.faturaIdler !== undefined ? attached.map((a) => a.key) : [];
      if (Object.keys(patch).length === 0 && !send) {
        toast('Değişiklik yok.', 'info');
        onDone(initial, false);
        return;
      }
      const patched = Object.keys(patch).length > 0;
      let detail = initial;
      if (patched) {
        detail = await updateMasraf(initial.id, patch);
        // The server holds these corrections and values now; a later save in this screen does not repeat them.
        for (const [id, value] of Object.entries(sending)) savedEdits.current[id] = JSON.stringify(value);
        receipts.markSaved(built.sent);
        await changed(detail);
      }
      if (send) {
        try {
          detail = await runMasrafAction(initial.id, 'gonder');
          await changed(detail);
        } catch (err) {
          // Nothing was saved: show it like any failed save, on this screen.
          if (!patched) throw err;
          if (
            err instanceof ApiError &&
            (err.kod === 'karsilik_eksik' ||
              err.kod === 'fatura_eksik' ||
              err.kod === 'alan_eksik' ||
              err.kod === 'fatura_mukerrer' ||
              err.kod === 'tutar_eksik')
          ) {
            // Saved, but something the user can fix here is missing: stay so it can be entered. What was saved is the new base.
            setBase(savedFields(detail));
            applyServerError(err);
            setFormError(
              err.kod === 'karsilik_eksik'
                ? `Değişiklikler kaydedildi ancak gönderilemedi. Onaya göndermek için ${baseCurrency} karşılığı eksik faturalar var.`
                : err.kod === 'fatura_eksik'
                  ? 'Değişiklikler kaydedildi ancak gönderilemedi: faturaların zorunlu bilgileri eksik. Faturalara dokunup doldurun.'
                  : err.kod === 'alan_eksik'
                    ? 'Değişiklikler kaydedildi ancak gönderilemedi: zorunlu alanlar eksik. İşaretli alanları doldurun.'
                    : `Değişiklikler kaydedildi ancak gönderilemedi. ${err.message}`,
            );
            return;
          }
          // Saved but not sent (e.g. 409 onaylayan_yok): keep the changes, show why it did not go out.
          haptics.error();
          toast(`Değişiklikler kaydedildi ancak gönderilemedi: ${errorMessage(err)}`, 'danger');
          onDone(detail, false);
          return;
        }
      }
      const outcome = savedOutcome(detail, send, autoSendNow === true, false);
      haptics.success();
      toast(outcome.message, outcome.tone);
      onDone(detail, outcome.sent);
    } catch (err) {
      applyServerError(err);
    } finally {
      saving.current = false;
      setBusy(null);
    }
  };

  // Why the form cannot go to approval now (the button stays off and says so); null when it can.
  const sendBlock: string | null = attachments.reading
    ? `${readingCount > 1 ? 'Faturalar' : 'Fatura'} okunurken onaya gönderilemez.`
    : pendingFailedCount > 0
      ? 'Okunamayan faturaları yeniden okutun ya da kaldırın; sonra onaya gönderebilirsiniz.'
      : amount === null || amount <= 0
        ? 'Onaya göndermek için tutarı girin.'
        : null;

  const submit = (send: boolean): void => {
    if (busy !== null || attachments.uploading || (send && sendBlock !== null)) return;
    setFormError(null);
    if (!validate(send)) {
      haptics.error();
      return;
    }
    // Sending with required invoice fields empty is a sure rejection: guide the user to them instead.
    // (The server still enforces the rule; this only saves the round trip.)
    if (send) {
      const incomplete = items.find((item) => !isReading(item) && !isFailed(item) && attachmentId(item) !== null && stateOf(item).missingHeader.length > 0);
      if (incomplete !== undefined) {
        haptics.warning();
        toast('Göndermeden önce eksik bilgileri doldurun.', 'info');
        setEditingKey(incomplete.key);
        return;
      }
    }
    // A file that could not be read has no invoice record to attach; say so instead of dropping it quietly.
    const failed = items.filter(isFailed).length;
    if (failed > 0) {
      haptics.warning();
      Alert.alert(
        failed === 1 ? 'Okunamayan dosya' : 'Okunamayan dosyalar',
        failed === 1
          ? 'Okunamayan dosya masrafa eklenmeyecek. Tekrar deneyebilir ya da onsuz kaydedebilirsiniz.'
          : `Okunamayan ${failed} dosya masrafa eklenmeyecek. Tekrar deneyebilir ya da onlarsız kaydedebilirsiniz.`,
        [
          { text: 'Vazgeç', style: 'cancel' },
          { text: failed === 1 ? 'Onsuz kaydet' : 'Onlarsız kaydet', onPress: () => void save(send) },
        ],
      );
      return;
    }
    void save(send);
  };

  const editingItem = editingKey === null ? undefined : items.find((i) => i.key === editingKey);
  const editingTitle = editingItem === undefined ? '' : itemName(editingItem);

  /** One line over the buttons: what keeps the form from being saved or sent, or what happens next. */
  const footerNote: { readonly tone: 'muted' | 'warning'; readonly text: string } | null = attachments.uploading
    ? { tone: 'muted', text: 'Dosya sunucuya yükleniyor; yükleme bitince kaydedebilirsiniz.' }
    : attachments.reading
      ? {
          tone: 'muted',
          text: !canSend
            ? 'Okuma arka planda sürer; beklemeden kaydedip çıkabilirsiniz.'
            : autoSend
              ? 'Faturaların hepsi okununca masraf kendiliğinden onaya gönderilecek. Kaydedip çıkabilirsiniz.'
              : `${sendBlock ?? ''} Taslak olarak kaydedip çıkabilirsiniz; okuma bitince bildirim gelir.`,
        }
      : canSend && pendingFailedCount > 0
        ? { tone: 'warning', text: sendBlock ?? '' }
        : canSend && missingEquivalents > 0
          ? {
              tone: 'warning',
              text: `${missingEquivalents === 1 ? 'Bir faturanın' : `${missingEquivalents} faturanın`} ${baseCurrency} karşılığı eksik; onaya göndermeden önce girin. Taslak olarak kaydedilebilir.`,
            }
          : canSend && sendBlock !== null
            ? { tone: 'muted', text: sendBlock }
            : canSend && centreRequired && masrafMerkeziId === null
              ? { tone: 'warning', text: 'Onaya göndermek için masraf merkezi seçin. Taslak olarak kaydedilebilir.' }
              : canSend && incompleteReceipts > 0
                ? {
                    tone: 'warning',
                    text: `${incompleteReceipts === 1 ? 'Bir fişte' : `${incompleteReceipts} fişte`} zorunlu alan eksik; onaya göndermeden önce doldurun. Taslak olarak kaydedilebilir.`,
                  }
                : null;

  const currencies = Array.from(new Set<string>([localCurrency.toUpperCase(), ...BASE_CURRENCIES, currency]));
  const showPicker = items.length === 0 && !manual;
  const several = items.length > 1;
  // While saving, the invoice list is fixed: what is being saved is what the user sees.
  const locked = busy !== null;

  /** The receipt's "Fiş bilgileri" (null when there are no receipt fields or the file is not saved). */
  const renderFields = (item: InvoiceAttachment): ReactNode => {
    if (!hasFields(item)) return null;
    const state = stateOf(item);
    const expanded = expandedOf(state.rk);
    return (
      <ReceiptFields
        name={itemName(item)}
        fields={receiptFieldDefs}
        required={state.requiredSet}
        missing={state.missingFields}
        values={receipts.of(state.rk)}
        errors={receipts.errors[state.rk]}
        expanded={expanded}
        onToggle={() => setOpened((o) => ({ ...o, [state.rk]: !expanded }))}
        disabled={locked}
        onChange={(anahtar, value) => setReceiptValue(state.rk, anahtar, value)}
        onPick={(field) => openPicker(item, field)}
        onPickDate={(field) => openDate(item, field)}
      />
    );
  };

  const pickValue = pick === null ? undefined : receipts.of(pick.rk)[pick.field.anahtar];
  const dateValue = dateTarget === null ? undefined : receipts.of(dateTarget.rk)[dateTarget.field.anahtar];

  /** The equivalent field of an invoice in a third currency; null for any other invoice. */
  const equivalentInput = (item: InvoiceAttachment): EquivalentInput | null => {
    const id = attachmentId(item);
    const summary = effectiveOf(item, edits)?.fatura ?? null;
    if (id === null || summary === null || !needsEquivalent(currency, baseCurrency, summary)) return null;
    return { value: form.equivalents[id] ?? '', error: equivalentErrors[id], onChange: (text) => setEquivalent(id, text) };
  };

  /** Base-currency amounts on a foreign-currency form count through the rate; say so while it is missing. */
  const rateNote = (item: InvoiceAttachment): string | null => {
    const summary = effectiveOf(item, edits)?.fatura ?? null;
    const id = attachmentId(item);
    if (summary === null || id === null || !needsKur || kurValid) return null;
    const inBase = summary.paraBirimi === baseCurrency && summary.genelToplam !== null && summary.genelToplam > 0;
    const withEquivalent = needsEquivalent(currency, baseCurrency, summary) && yerelKarsiliklar[id] !== undefined;
    return inBase || withEquivalent ? 'Kur girilince tutar toplamına katılır.' : null;
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {formError !== null ? <Banner tone="danger" message={formError} /> : null}

        {/* Invoices */}
        <Animated.View layout={motion.layout} style={styles.section}>
          {showPicker ? (
            <>
              <Text variant="heading" accessibilityRole="header">
                Fatura veya fiş ekle
              </Text>
              <Text variant="small" tone="muted">
                Fotoğrafını çekin ya da dosyayı seçin; tutar, tarih ve satıcıyı biz dolduralım. Birden çok fiş ekleyebilirsiniz.
              </Text>
              <SourcePicker onPick={(c) => void choose(c)} />
            </>
          ) : items.length > 0 ? (
            <>
              <View style={styles.listHead}>
                <Text variant="heading" accessibilityRole="header" style={styles.flex}>
                  {several ? 'Faturalar' : 'Fatura'}
                </Text>
                {several ? (
                  <Text variant="caption" tone="muted" accessibilityLabel={`${items.length} fatura, en çok ${MAX_INVOICES}`}>
                    {items.length}/{MAX_INVOICES}
                  </Text>
                ) : null}
              </View>
              {items.map((item) => (
                <Animated.View key={item.key} entering={motion.enter(0)} exiting={motion.fadeOut} layout={motion.layout}>
                  {/* Keyed by stage so the card fades over when its reading finishes or fails. */}
                  <Animated.View
                    key={isReading(item) ? 'reading' : isFailed(item) || isPendingFailed(item) ? 'failed' : 'ready'}
                    entering={motion.fadeIn}
                  >
                    <InvoiceItem
                      item={item}
                      compact={several}
                      currency={currency}
                      baseCurrency={baseCurrency}
                      equivalent={equivalentInput(item)}
                      note={rateNote(item)}
                      summary={effectiveOf(item, edits)?.fatura ?? null}
                      missing={stateOf(item).missingHeader}
                      fields={renderFields(item)}
                      corrected={isCorrected(item, edits)}
                      issues={issueLabels(editErrors[attachmentId(item) ?? ''])}
                      onEdit={() => openEditor(item.key)}
                      error={invoiceErrors[item.key]}
                      disabled={locked}
                      retrying={item.kind === 'pending' && rereading}
                      onRemove={() => removeInvoice(item.key)}
                      onRetry={() => (item.kind === 'pending' ? void rereadPending() : retryInvoice(item.key))}
                    />
                  </Animated.View>
                </Animated.View>
              ))}
              {alanlar.isError && defs === undefined ? (
                <Pressable
                  onPress={() => void alanlar.refetch()}
                  accessibilityRole="button"
                  accessibilityHint="Fiş alanlarını yeniden yükler"
                  style={styles.retry}
                >
                  <Text variant="small" tone="danger">
                    Fiş alanları yüklenemedi. Tekrar denemek için dokunun.
                  </Text>
                </Pressable>
              ) : null}
              {invoiceSum !== null && invoiceSum.count > 1 ? (
                <Text variant="small" tone="muted" style={styles.groupLabel}>
                  {invoiceSum.count} faturanın toplamı: {formatMoney(invoiceSum.total, currency)}
                </Text>
              ) : null}
              {canSend && hasPending ? (
                <Animated.View
                  entering={motion.enter(0)}
                  style={[styles.autoSend, { backgroundColor: colors.surface, borderColor: autoSend ? colors.primary : colors.border }]}
                >
                  <Ionicons name="paper-plane-outline" size={20} color={colors.primary} />
                  <View style={styles.flex}>
                    <Text variant="bodyStrong">Okumalar bitince onaya gönder</Text>
                    <Text variant="small" tone="muted">
                      Faturaların hepsi okununca masraf kendiliğinden onaya gönderilir; sonucu bildirimle öğrenirsiniz.
                    </Text>
                  </View>
                  <Switch
                    value={autoSend}
                    disabled={locked}
                    onValueChange={(value) => {
                      haptics.tap();
                      autoSendTouched.current = true;
                      setAutoSend(value);
                    }}
                    trackColor={{ false: colors.border, true: colors.primary }}
                    accessibilityLabel="Okumalar bitince onaya gönder"
                    accessibilityHint="Faturaların hepsi okununca masrafı kendiliğinden onaya gönderir"
                    accessibilityRole="switch"
                  />
                </Animated.View>
              ) : null}
              {items.length < MAX_INVOICES ? (
                <View style={styles.fieldGroup}>
                  <Text variant="label" tone="muted" style={styles.groupLabel}>
                    Başka fatura ekle
                  </Text>
                  <View style={styles.row}>
                    {ADD_SOURCES.map((source) => (
                      <Button
                        key={source.value}
                        title={source.title}
                        icon={source.icon}
                        size="sm"
                        variant="secondary"
                        flex
                        accessibilityLabel={source.label}
                        accessibilityHint={source.hint}
                        disabled={locked}
                        onPress={() => void choose(source.value)}
                      />
                    ))}
                  </View>
                </View>
              ) : (
                <Text variant="small" tone="muted" style={styles.groupLabel}>
                  Bir masrafa en çok {MAX_INVOICES} fatura eklenebilir.
                </Text>
              )}
            </>
          ) : (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Fatura ekle"
              accessibilityHint="Fiş veya fatura ekleyerek alanları otomatik doldurur"
              onPress={() => setManual(false)}
              style={[styles.addInvoice, { borderColor: colors.border }]}
            >
              <Ionicons name="attach" size={20} color={colors.primary} />
              <Text variant="label" tone="primary" style={styles.flex}>
                Faturasız masraf · Fatura ekle
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </PressableScale>
          )}
          <FieldError message={errors.faturaIdler} />
        </Animated.View>

        {/* Details */}
        <View style={styles.section}>
          <TextField
            label="Başlık"
            value={values.baslik}
            onChangeText={(t) => set('baslik', t)}
            placeholder="Örn. Müşteri yemeği"
            maxLength={120}
            error={errors.baslik}
            returnKeyType="next"
            required
          />

          <View style={styles.fieldGroup}>
            <FieldLabel label="Kategori" required />
            {kategoriler.isPending ? (
              <View style={styles.row}>
                <Skeleton width={96} height={44} round />
                <Skeleton width={110} height={44} round />
                <Skeleton width={90} height={44} round />
              </View>
            ) : kategoriler.isError ? (
              <Pressable onPress={() => void kategoriler.refetch()} accessibilityRole="button" style={styles.retry}>
                <Text variant="small" tone="danger">
                  Kategoriler yüklenemedi. Tekrar denemek için dokunun.
                </Text>
              </Pressable>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="radiogroup">
                {kategoriler.data.map((k) => (
                  <Chip
                    key={k.id}
                    label={k.ad}
                    categoryIcon={categoryIcon(k.simge)}
                    selected={values.kategoriId === k.id}
                    onPress={() => set('kategoriId', k.id)}
                  />
                ))}
              </ScrollView>
            )}
            <FieldError message={errors.kategoriId} />
          </View>

          {centreField !== undefined ? (
            <Animated.View entering={motion.fadeIn} style={styles.fieldGroup}>
              {ben.isPending ? (
                <>
                  <FieldLabel label={centreField.ad} required={centreRequired} />
                  <View style={styles.row}>
                    <Skeleton width={120} height={44} round />
                    <Skeleton width={104} height={44} round />
                  </View>
                </>
              ) : centreOptions.length === 0 ? (
                <>
                  <FieldLabel label={centreField.ad} required={centreRequired} />
                  <Text variant="small" tone={centreRequired ? 'warning' : 'muted'} style={styles.groupLabel}>
                    Size tanımlı masraf merkezi yok; yöneticinize başvurun.
                  </Text>
                </>
              ) : centreOptions.length <= CENTRE_CHIPS_MAX ? (
                <>
                  <FieldLabel label={centreField.ad} required={centreRequired} />
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="radiogroup">
                    {centreOptions.map((o) => (
                      <Chip
                        key={o.id}
                        label={o.gosterim}
                        icon="business-outline"
                        selected={masrafMerkeziId === o.id}
                        accessibilityLabel={`${centreField.ad}: ${o.gosterim}${o.note !== undefined ? `, ${o.note}` : ''}`}
                        // Tapping the chosen one again clears it.
                        onPress={() => setCentreId(masrafMerkeziId === o.id ? null : o.id)}
                      />
                    ))}
                  </ScrollView>
                  {chosenCentre?.note !== undefined ? (
                    <Text variant="caption" tone="warning" style={styles.groupLabel}>
                      Seçili masraf merkezi: {chosenCentre.note.toLocaleLowerCase('tr-TR')}. Taslak böyle kaydedilebilir; onaya göndermek için başka birini seçin.
                    </Text>
                  ) : null}
                </>
              ) : (
                <SelectField
                  label={centreField.ad}
                  value={chosenCentre?.gosterim ?? null}
                  note={chosenCentre?.note ?? null}
                  placeholder="Masraf merkezi seçin"
                  icon="business-outline"
                  required={centreRequired}
                  disabled={locked}
                  onPress={() => setCentreSheet(true)}
                  onClear={() => setCentreId(null)}
                />
              )}
              {errors.masrafMerkeziId !== undefined ? (
                <FieldError message={errors.masrafMerkeziId} />
              ) : centreRequired && masrafMerkeziId === null && centreOptions.length > 0 ? (
                <Text variant="small" tone="faint" style={styles.groupLabel}>
                  Onaya göndermek için gerekli.
                </Text>
              ) : centreField.aciklama !== null ? (
                <Text variant="small" tone="faint" style={styles.groupLabel}>
                  {centreField.aciklama}
                </Text>
              ) : null}
            </Animated.View>
          ) : null}

          <View style={styles.fieldGroup}>
            <FieldLabel label="Masraf tarihi" required />
            <View style={styles.row}>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={`Masraf tarihi: ${formatDate(values.masrafTarihi)}`}
                accessibilityHint="Takvimi açar"
                onPress={() => setCalendarOpen(true)}
                style={[styles.dateField, { backgroundColor: colors.surface, borderColor: errors.masrafTarihi !== undefined ? colors.danger : colors.border }]}
              >
                <Ionicons name="calendar-outline" size={20} color={colors.primary} />
                <Text variant="bodyStrong" style={styles.flex} numberOfLines={1}>
                  {formatDateFriendly(values.masrafTarihi)}
                </Text>
                {/* "Bugün" and "Dün" are followed by the date; a date is followed by its weekday, not by itself again. */}
                <Text variant="small" tone="muted" numberOfLines={1}>
                  {formatDateFriendly(values.masrafTarihi) === formatDate(values.masrafTarihi)
                    ? formatWeekday(values.masrafTarihi)
                    : formatDate(values.masrafTarihi)}
                </Text>
              </PressableScale>
            </View>
            <View style={styles.row}>
              <Chip label="Bugün" selected={values.masrafTarihi === todayIso()} onPress={() => set('masrafTarihi', todayIso())} />
              <Chip
                label="Dün"
                selected={values.masrafTarihi === yesterdayIso()}
                onPress={() => set('masrafTarihi', yesterdayIso())}
              />
            </View>
            <FieldError message={errors.masrafTarihi} />
          </View>

          <TextField
            label={`Tutar (${currency})`}
            value={values.tutar}
            onChangeText={(t) => set('tutar', t.replace(/[^0-9.,]/g, ''))}
            placeholder="0,00"
            keyboardType="decimal-pad"
            error={errors.tutar}
            hint={
              amountDeferred
                ? values.tutar.trim() === ''
                  ? 'Boş bırakabilirsiniz; faturalar okununca tutar kendiliğinden dolar.'
                  : 'Şimdilik okunan faturaların toplamı; hepsi okununca tutar kendiliğinden dolar.'
                : form.amountCleared
                  ? waitingForRate
                    ? `Kur girilince faturaların ${baseCurrency} tutarı ${currency} cinsine çevrilip buraya yazılır.`
                    : `${currency} cinsinden tutara katılacak fatura kalmadı; tutarı girin.`
                  : amount !== null && amount > 0
                    ? formatMoney(amount, currency)
                    : undefined
            }
            inputStyle={styles.amountInput}
          />

          <View style={styles.fieldGroup}>
            <Text variant="label" tone="muted" style={styles.groupLabel}>
              Para birimi
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="radiogroup">
              {currencies.map((code) => (
                <Chip
                  key={code}
                  label={code}
                  selected={currency === code}
                  onPress={() => {
                    set('paraBirimi', code);
                    // Which invoices need an equivalent depends on the currency; old errors no longer apply.
                    setEquivalentErrors({});
                    // An amount that follows the invoices switches to the invoices in the new currency.
                    fillFromInvoices(items, null);
                  }}
                />
              ))}
            </ScrollView>
            <FieldError message={errors.paraBirimi} />
          </View>

          {needsKur ? (
            <Animated.View entering={motion.enter(0)}>
              <TextField
                label={`Kur (1 ${currency} = ? ${localCurrency})`}
                value={values.kur}
                onChangeText={(t) => {
                  set('kur', t.replace(/[^0-9.,]/g, ''));
                  // Base-currency invoices and equivalents count through the rate.
                  fillFromInvoices(items, null);
                }}
                placeholder="Örn. 34,25"
                keyboardType="decimal-pad"
                error={errors.kur}
                hint={
                  amount !== null && kur !== null
                    ? `Yerel tutar: ${formatMoney(Math.round(amount * kur * 100) / 100, localCurrency)}`
                    : waitingForRate
                      ? `Kur zorunludur; girilince ${baseCurrency} tutarları da fatura toplamına katılır.`
                      : 'Para birimi yerel para biriminden farklı; kur zorunludur.'
                }
              />
            </Animated.View>
          ) : null}

          <ApprovalPreview request={previewRequest} />

          <TextField
            label="Satıcı"
            value={values.satici}
            onChangeText={(t) => set('satici', t)}
            placeholder="İsteğe bağlı"
            error={errors.satici}
            icon="storefront-outline"
          />
          <TextField
            label="Açıklama"
            value={values.aciklama}
            onChangeText={(t) => set('aciklama', t)}
            placeholder="İsteğe bağlı: kiminle, ne için…"
            multiline
            error={errors.aciklama}
          />
        </View>
      </ScrollView>

      <View style={[styles.footer, { backgroundColor: colors.bg, borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
        {footerNote !== null ? (
          <Text variant="caption" tone={footerNote.tone} align="center" accessibilityLiveRegion="polite">
            {footerNote.text}
          </Text>
        ) : null}
        <View style={styles.row}>
          {/* Content-wide and without an icon, so "Onaya gönder" / "Kaydet ve gönder" keeps one line at 360 pt.
              While invoices are still to be read, saving is the way forward, so it becomes the main button. */}
          <Button
            title={mode === 'create' && !(canSend && hasPending && autoSend) ? 'Taslak kaydet' : 'Kaydet'}
            variant={hasPending ? 'primary' : 'outline'}
            flex={!canSend}
            loading={busy === 'draft'}
            disabled={attachments.uploading || busy === 'send'}
            accessibilityHint={hasPending ? 'Okumalar arka planda sürer; bitince bildirim gelir' : undefined}
            onPress={() => submit(false)}
          />
          {canSend ? (
            <Button
              title={mode === 'create' ? 'Onaya gönder' : 'Kaydet ve gönder'}
              icon="paper-plane"
              variant={hasPending ? 'outline' : 'primary'}
              flex
              loading={busy === 'send'}
              disabled={sendBlock !== null || attachments.uploading || busy === 'draft'}
              accessibilityHint={sendBlock ?? undefined}
              onPress={() => submit(true)}
            />
          ) : null}
        </View>
      </View>

      {editingItem !== undefined ? (
        <InvoiceEditSheet
          visible
          title={editingTitle}
          value={effectiveOf(editingItem, edits)}
          canRevert={isCorrected(editingItem, edits)}
          serverErrors={editErrors[attachmentId(editingItem) ?? ''] ?? NO_ERRORS}
          required={stateOf(editingItem).required ?? REQUIRED_FIELDS}
          help={headerHelp}
          onSave={(value) => saveEdit(editingItem, value)}
          onRevert={() => saveEdit(editingItem, null)}
          onClose={() => setEditingKey(null)}
        />
      ) : null}

      {pick !== null ? (
        <OptionPickerSheet
          visible={pickOpen}
          title={pick.field.ad}
          subtitle={pick.name}
          source={{ kind: 'remote', anahtar: pick.field.anahtar, count: pick.field.secenekSayisi }}
          selectedId={typeof pickValue?.deger === 'number' ? pickValue.deger : null}
          onSelect={(option) => setReceiptValue(pick.rk, pick.field.anahtar, { deger: option.id, gosterim: option.gosterim })}
          onClose={() => setPickOpen(false)}
        />
      ) : null}

      {centreField !== undefined && centreOptions.length > CENTRE_CHIPS_MAX ? (
        <OptionPickerSheet
          visible={centreSheet}
          title={centreField.ad}
          source={{ kind: 'local', options: centreOptions }}
          selectedId={masrafMerkeziId}
          onSelect={(option) => setCentreId(option.id)}
          onClose={() => setCentreSheet(false)}
        />
      ) : null}

      <CalendarSheet
        key={dateOpen ? 'date-open' : 'date-closed'}
        visible={dateOpen}
        value={typeof dateValue?.deger === 'string' && dateValue.deger !== '' ? dateValue.deger : todayIso()}
        title={dateTarget?.field.ad ?? 'Tarih'}
        allowFuture
        onChange={(iso) => {
          if (dateTarget !== null) setReceiptValue(dateTarget.rk, dateTarget.field.anahtar, { deger: iso, gosterim: iso });
        }}
        onClose={() => setDateOpen(false)}
      />

      <CalendarSheet
        key={calendarOpen ? 'open' : 'closed'}
        visible={calendarOpen}
        value={values.masrafTarihi}
        title="Masraf tarihi"
        onChange={(iso) => set('masrafTarihi', iso)}
        onClose={() => setCalendarOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}

const NO_ERRORS: Readonly<Record<string, string>> = {};

/** Names of the fields a server error points at, for the invoice card ("fatura no, genel toplam"). */
function issueLabels(errors: Readonly<Record<string, string>> | undefined): string[] {
  if (errors === undefined) return [];
  const names = Object.keys(errors).map((path) => (path.startsWith('fatura.') ? fieldLabel(path.slice('fatura.'.length)).toLowerCase() : 'kalemler'));
  return Array.from(new Set(names));
}

function yesterdayIso(): string {
  const d = new Date();
  return toIsoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
}

interface EquivalentInput {
  readonly value: string;
  readonly error: string | undefined;
  readonly onChange: (text: string) => void;
}

/** One invoice of the list: reading, failed, read on this device or already on the form. */
function InvoiceItem({
  item,
  compact,
  currency,
  baseCurrency,
  equivalent,
  note,
  summary,
  missing,
  fields,
  corrected,
  issues,
  onEdit,
  error,
  disabled,
  retrying,
  onRemove,
  onRetry,
}: {
  readonly item: InvoiceAttachment;
  /** The receipt's "Fiş bilgileri", shown at the bottom of its card in every state but a local failure. */
  readonly fields: ReactNode;
  /** Several invoices on the form: smaller cards. */
  readonly compact: boolean;
  /** The form's currency. */
  readonly currency: string;
  /** PARA_BIRIMI; an invoice in a third currency asks for its value in this one. */
  readonly baseCurrency: string;
  /** Set for an invoice in a third currency: its base-currency equivalent. */
  readonly equivalent: EquivalentInput | null;
  /** Why the invoice does not count toward the amount yet, if it does not. */
  readonly note: string | null;
  /** The invoice's effective information (the correction when there is one). */
  readonly summary: InvoiceSummary | null;
  /** Required header fields that are empty; the card says "Eksik bilgi". */
  readonly missing: readonly HeaderKey[];
  readonly corrected: boolean;
  /** Fields the server pointed at on the last save. */
  readonly issues: readonly string[];
  /** Opens "Fatura bilgileri". */
  readonly onEdit: () => void;
  readonly error: string | undefined;
  /** No removing or retrying while the form is being saved. */
  readonly disabled: boolean;
  /** A failed pending invoice is being put back in the reading queue. */
  readonly retrying: boolean;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
}) {
  const thumbW = compact ? 44 : 56;
  const thumbH = compact ? 56 : 70;

  // A file of the saved form the server reads in the background.
  if (item.kind === 'pending') {
    const b = item.bekleyen;
    if (b.durum === 'hata') {
      return (
        <FailedInvoice
          name={b.dosyaAdi}
          thumb={{ kind: 'icon', mime: b.mime }}
          message={b.hata?.mesaj ?? 'Fatura okunamadı.'}
          hint="Yeniden okutabilir ya da masraftan çıkarabilirsiniz."
          retryTitle="Yeniden oku"
          retryHint="Okunamayan faturaları yeniden okuma sırasına alır"
          compact={compact}
          disabled={disabled}
          retrying={retrying}
          onRetry={onRetry}
          onRemove={onRemove}
          thumbW={thumbW}
          thumbH={thumbH}
          footer={fields}
        />
      );
    }
    return (
      <ReadingCard
        file={{ name: b.dosyaAdi, mimeType: b.mime, uri: null }}
        startedAt={timeOf(b.eklenme)}
        phase={b.durum}
        kuyrukSirasi={b.kuyrukSirasi}
        onundeki={b.onundeki}
        onCancel={onRemove}
        compact={compact}
      >
        {fields}
      </ReadingCard>
    );
  }

  if (item.kind === 'local' && (item.reading.phase === 'pending' || item.reading.phase === 'uploading' || item.reading.phase === 'waiting')) {
    const reading = item.reading;
    return (
      <ReadingCard
        file={item.file}
        startedAt={reading.startedAt}
        phase={reading.phase === 'waiting' ? reading.itemState : reading.phase}
        kuyrukSirasi={reading.phase === 'waiting' ? reading.kuyrukSirasi : null}
        onundeki={reading.phase === 'waiting' ? reading.onundeki : null}
        onCancel={onRemove}
        compact={compact}
      >
        {fields}
      </ReadingCard>
    );
  }

  if (item.kind === 'local' && item.reading.phase === 'failed') {
    return (
      <FailedInvoice
        name={item.file.name}
        thumb={{ kind: 'local', uri: item.file.uri, mime: item.file.mimeType }}
        message={item.reading.message}
        hint="Bilgileri elle girebilirsiniz."
        retryTitle="Tekrar dene"
        compact={compact}
        disabled={disabled}
        retrying={false}
        onRetry={onRetry}
        onRemove={onRemove}
        thumbW={thumbW}
        thumbH={thumbH}
      />
    );
  }

  return (
    <ReadInvoice
      item={item}
      compact={compact}
      currency={currency}
      baseCurrency={baseCurrency}
      equivalent={equivalent}
      note={note}
      summary={summary}
      missing={missing}
      corrected={corrected}
      issues={issues}
      onEdit={onEdit}
      error={error}
      disabled={disabled}
      onRemove={onRemove}
      thumbW={thumbW}
      thumbH={thumbH}
      footer={fields}
    />
  );
}

/** An ISO time as epoch milliseconds; now when it cannot be read. */
function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

/** A file that could not be read: the reason, a retry and a remove button. */
function FailedInvoice({
  name,
  thumb,
  message,
  hint,
  retryTitle,
  retryHint,
  compact,
  disabled,
  retrying,
  onRetry,
  onRemove,
  thumbW,
  thumbH,
  footer,
}: {
  readonly name: string;
  readonly thumb: InvoiceThumbSource;
  readonly message: string;
  /** What the user can do, after the message on a large card. */
  readonly hint: string;
  readonly retryTitle: string;
  readonly retryHint?: string;
  readonly compact: boolean;
  readonly disabled: boolean;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly onRemove: () => void;
  readonly thumbW: number;
  readonly thumbH: number;
  /** A pending file of the saved form keeps its fields while it waits to be read again. */
  readonly footer?: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.attached, compact && styles.attachedCompact, { backgroundColor: colors.surface, borderColor: colors.warning }]}>
      {/* Top-aligned: a long server message must not push the thumbnail down. */}
      <View style={[styles.attachedRow, styles.attachedRowTop]}>
        <InvoiceThumb source={thumb} width={thumbW} height={thumbH} />
        <View style={styles.flex} accessible accessibilityLabel={`Okunamadı: ${name}. ${message}`}>
          <View style={styles.attachedTitle}>
            <Ionicons name="alert-circle" size={18} color={colors.warning} />
            <Text variant="bodyStrong" style={styles.flex}>
              Okunamadı
            </Text>
          </View>
          <Text variant="caption" tone="faint" numberOfLines={1}>
            {name}
          </Text>
          {/* The full message is in the label above; a long technical one would make the card very tall. */}
          <Text variant="small" tone="muted" numberOfLines={compact ? 3 : 4}>
            {compact ? message : `${message} ${hint}`}
          </Text>
        </View>
      </View>
      <View style={styles.row}>
        <Button
          title={retryTitle}
          icon="refresh"
          size="sm"
          variant="secondary"
          flex
          accessibilityLabel={`${retryTitle}: ${name}`}
          accessibilityHint={retryHint}
          disabled={disabled}
          loading={retrying}
          onPress={onRetry}
        />
        <Button
          title="Kaldır"
          icon="trash-outline"
          size="sm"
          variant="dangerSoft"
          flex
          accessibilityLabel={`Kaldır: ${name}`}
          disabled={disabled}
          onPress={onRemove}
        />
      </View>
      {footer}
    </View>
  );
}

/** An invoice that was read: what it says, its state and the way to its information. */
function ReadInvoice({
  item,
  compact,
  currency,
  baseCurrency,
  equivalent,
  note,
  summary,
  missing,
  corrected,
  issues,
  onEdit,
  error,
  disabled,
  onRemove,
  thumbW,
  thumbH,
  footer,
}: {
  readonly item: Exclude<InvoiceAttachment, { kind: 'pending' }>;
  readonly compact: boolean;
  readonly currency: string;
  readonly baseCurrency: string;
  readonly equivalent: EquivalentInput | null;
  readonly note: string | null;
  readonly summary: InvoiceSummary | null;
  readonly missing: readonly HeaderKey[];
  /** The receipt's "Fiş bilgileri". */
  readonly footer: ReactNode;
  readonly corrected: boolean;
  readonly issues: readonly string[];
  readonly onEdit: () => void;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly onRemove: () => void;
  readonly thumbW: number;
  readonly thumbH: number;
}) {
  const { colors } = useTheme();

  const title =
    item.kind === 'server'
      ? 'Bağlı fatura'
      : item.reading.phase === 'done' && item.reading.onbellek
        ? // Short enough for one line beside the thumbnail and delete button on a 360 pt screen.
          'Daha önce okunmuş'
        : 'Fatura okundu';
  const name = item.kind === 'server' ? (item.fatura.dosyaAdi ?? item.fatura.faturaNo ?? 'Fatura') : item.file.name;
  const facts = [
    summary?.genelToplam !== null && summary?.genelToplam !== undefined ? formatMoney(summary.genelToplam, summary.paraBirimi ?? currency) : null,
    summary?.faturaTarihi !== null && summary?.faturaTarihi !== undefined ? formatDate(summary.faturaTarihi) : null,
    summary?.saticiUnvan ?? null,
  ].filter((f): f is string => f !== null);
  const emptyNote = facts.length === 0 && item.kind === 'local' ? 'Faturadan alan okunamadı; bilgileri elle girin.' : null;
  const missingText = missing.map((m) => fieldLabel(m).toLowerCase()).join(', ');
  const invalid = error !== undefined || equivalent?.error !== undefined || missing.length > 0 || issues.length > 0;

  return (
    <View
      style={[
        styles.attached,
        compact && styles.attachedCompact,
        { backgroundColor: colors.surface, borderColor: invalid ? colors.danger : colors.success },
      ]}
    >
      <View style={styles.attachedRow}>
        <InvoiceThumb
          source={
            item.kind === 'local'
              ? { kind: 'local', uri: item.file.uri, mime: item.file.mimeType }
              : { kind: 'remote', faturaId: item.fatura.id, mime: item.fatura.mime, hasFile: item.fatura.dosyaVar }
          }
          width={thumbW}
          height={thumbH}
        />
        <PressableScale
          style={styles.flex}
          accessibilityRole="button"
          accessibilityLabel={[
            title,
            corrected ? 'Düzeltildi' : null,
            name,
            ...facts,
            note,
            emptyNote,
            missing.length > 0 ? `Eksik bilgi: ${missingText}` : null,
            issues.length > 0 ? `Düzeltilmesi gereken: ${issues.join(', ')}` : null,
          ]
            .filter((p) => p !== null)
            .join('. ')}
          accessibilityHint="Fatura bilgilerini ve kalemlerini açar, düzeltmenizi sağlar"
          disabled={disabled}
          onPress={onEdit}
        >
          <View style={styles.attachedTitle}>
            <Ionicons name="checkmark-circle" size={18} color={colors.success} />
            <Text variant="bodyStrong" style={styles.flex} numberOfLines={1}>
              {title}
            </Text>
          </View>
          <Text variant="caption" tone="faint" numberOfLines={1}>
            {name}
          </Text>
          {facts.length > 0 ? (
            <Text variant="small" tone="muted" numberOfLines={2}>
              {facts.join(' · ')}
            </Text>
          ) : emptyNote !== null ? (
            <Text variant="small" tone="muted">
              {emptyNote}
            </Text>
          ) : null}
          {note !== null ? (
            <Text variant="caption" tone="warning">
              {note}
            </Text>
          ) : null}
          {corrected ? (
            <View style={styles.badgeRow}>
              <Ionicons name="create" size={14} color={colors.info} />
              <Text variant="caption" tone="info">
                Düzeltildi
              </Text>
            </View>
          ) : null}
          {missing.length > 0 ? (
            <View style={styles.badgeRow}>
              <Ionicons name="alert-circle" size={14} color={colors.danger} />
              <Text variant="caption" tone="danger" style={styles.flex}>
                Eksik bilgi: {missingText}
              </Text>
            </View>
          ) : null}
          {issues.length > 0 ? (
            <Text variant="caption" tone="danger">
              Düzeltilmesi gereken: {issues.join(', ')}
            </Text>
          ) : null}
          <View style={styles.badgeRow}>
            <Ionicons name={missing.length > 0 ? 'alert-circle-outline' : 'pencil'} size={13} color={colors.primary} />
            <Text variant={missing.length > 0 ? 'label' : 'caption'} tone="primary">
              {missing.length > 0 ? 'Eksikleri doldur' : 'Bilgileri aç ve düzenle'}
            </Text>
          </View>
        </PressableScale>
        <IconButton
          icon="trash-outline"
          tone="soft"
          color={colors.danger}
          accessibilityLabel={`Faturayı kaldır: ${name}`}
          disabled={disabled}
          onPress={onRemove}
        />
      </View>
      {equivalent !== null ? (
        <TextField
          label={`${baseCurrency} karşılığı`}
          value={equivalent.value}
          onChangeText={equivalent.onChange}
          placeholder="0,00"
          keyboardType="decimal-pad"
          editable={!disabled}
          error={equivalent.error}
          hint={`${summary?.paraBirimi ?? ''} fatura. Kart ekstrenizdeki ya da bankanızın uyguladığı ${baseCurrency} tutarı.`}
          accessibilityLabel={`${name} için ${baseCurrency} karşılığı`}
        />
      ) : null}
      {error !== undefined ? <FieldError message={error} /> : null}
      {footer}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.xl, gap: spacing.xxl, paddingBottom: spacing.huge },
  section: { gap: spacing.md },
  row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  fieldGroup: { gap: spacing.sm },
  groupLabel: { marginLeft: spacing.xs },
  chips: { gap: spacing.sm, paddingRight: spacing.xl },
  retry: { minHeight: minTouch, justifyContent: 'center' },
  dateField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.md + 2,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  amountInput: { fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  addInvoice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  listHead: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  autoSend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1.5,
    minHeight: minTouch,
  },
  attached: { borderRadius: radius.xl, borderWidth: 1.5, padding: spacing.lg, gap: spacing.md },
  attachedCompact: { padding: spacing.md, gap: spacing.sm },
  attachedRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  attachedRowTop: { alignItems: 'flex-start' },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  attachedTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  footer: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
});
