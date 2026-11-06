import { Ionicons } from '@expo/vector-icons';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, errorMessage } from '@/api/client';
import { createMasraf, runMasrafAction, updateMasraf } from '@/api/endpoints';
import { useKategoriler, useMasrafChanged, useOzet } from '@/api/queries';
import type { MasrafDetay, MasrafGuncelleIstegi, OnizlemeIstegi } from '@/api/types';
import { InvoiceThumb } from '@/components/expense/InvoiceThumb';
import { Button, type IconName } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { IconButton } from '@/components/ui/IconButton';
import { PressableScale } from '@/components/ui/PressableScale';
import { Skeleton } from '@/components/ui/Skeleton';
import { Banner } from '@/components/ui/StateViews';
import { Text } from '@/components/ui/Text';
import { FieldError, TextField } from '@/components/ui/TextField';
import { useToast } from '@/components/ui/Toast';
import {
  attachmentId,
  attachmentSummary,
  isFailed,
  isReading,
  useInvoiceAttachments,
  type InvoiceAttachment,
} from '@/hooks/useInvoiceAttachments';
import { useMotion } from '@/hooks/useMotion';
import { categoryIcon } from '@/lib/categories';
import { amountToInput, formatDate, formatDateFriendly, formatMoney, formatWeekday, parseAmount, todayIso, toIsoDate } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import {
  invoiceTotalInForm,
  MAX_INVOICES,
  needsEquivalent,
  sameAmounts,
  sameIds,
  type InvoiceMoney,
} from '@/lib/invoices';
import { pickInvoices, type InvoiceSource } from '@/lib/pickers';
import { minTouch, radius, spacing, useTheme } from '@/theme';

import { ApprovalPreview } from './ApprovalPreview';
import { CalendarSheet } from './CalendarSheet';
import { ReadingCard } from './ReadingCard';
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

type FieldKey = keyof Values | 'faturaIdler';
const FIELD_KEYS: readonly FieldKey[] = ['baslik', 'kategoriId', 'masrafTarihi', 'tutar', 'paraBirimi', 'kur', 'satici', 'aciklama', 'faturaIdler'];
/** Server errors for one invoice of the list: `faturaIdler.<index in the sent list>`. */
const INVOICE_FIELD = /^faturaIdler\.(\d+)$/;
/** Server errors for one invoice's base-currency equivalent: `yerelKarsiliklar.<invoice id>`. */
const EQUIVALENT_FIELD = /^yerelKarsiliklar\.(.+)$/;

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
  const follows = sum !== null && cents(sum.total) === cents(initial.tutar);
  if (follows) delete touched.tutar;
  const equivalents: Record<string, string> = {};
  for (const f of initial.faturalar) if (f.yerelKarsilik !== null) equivalents[f.id] = amountToInput(f.yerelKarsilik);
  return { values, touched, amountAuto: follows, amountCleared: false, equivalents };
}

/** What each invoice adds to the total, with the equivalent typed for it. */
function moneyOf(list: readonly InvoiceAttachment[], equivalents: Readonly<Record<string, string>>): InvoiceMoney[] {
  return list.flatMap((item) => {
    const summary = attachmentSummary(item);
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
function fillState(state: FormState, list: readonly InvoiceAttachment[], readKey: string | null, localCurrency: string): FormState {
  const before = state.values;
  const fillable = (key: TextKey): boolean => state.touched[key] !== true || before[key].trim() === '';
  let values = before;
  if (readKey !== null) {
    const first = list.find((item) => attachmentSummary(item) !== null);
    const f = first !== undefined && first.key === readKey ? attachmentSummary(first) : null;
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
    const sum = invoiceTotalInForm(currency, baseCurrency, rate, moneyOf(list, state.equivalents));
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
  readonly tutar: number;
  readonly paraBirimi: string;
  readonly kur: number | null;
  readonly satici: string | null;
  readonly aciklama: string | null;
  readonly faturaIdler: readonly string[];
  readonly yerelKarsiliklar: Readonly<Record<string, number>>;
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
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Only what the user changed since the screen opened. PATCH leaves fields it does not get as they are, so
 * a change made elsewhere meanwhile (e.g. an invoice added on the web panel) is not overwritten by stale
 * values. A rate belongs to its currency, so the two always go together.
 */
function editPatch(
  next: Omit<SavedFields, 'faturaIdler' | 'yerelKarsiliklar'>,
  faturaIdler: readonly string[],
  yerelKarsiliklar: Readonly<Record<string, number>>,
  base: SavedFields,
): MasrafGuncelleIstegi {
  const patch: Mutable<MasrafGuncelleIstegi> = {};
  if (next.baslik !== base.baslik) patch.baslik = next.baslik;
  if (next.kategoriId !== base.kategoriId) patch.kategoriId = next.kategoriId;
  if (next.masrafTarihi !== base.masrafTarihi) patch.masrafTarihi = next.masrafTarihi;
  if (cents(next.tutar) !== cents(base.tutar)) patch.tutar = next.tutar;
  if (next.paraBirimi !== base.paraBirimi || next.kur !== base.kur) {
    patch.paraBirimi = next.paraBirimi;
    patch.kur = next.kur;
  }
  if (next.satici !== base.satici) patch.satici = next.satici;
  if (next.aciklama !== base.aciklama) patch.aciklama = next.aciklama;
  // The list replaces the form's invoices entirely, so it goes only when it changed.
  if (!sameIds(faturaIdler, base.faturaIdler)) patch.faturaIdler = faturaIdler;
  // The equivalents replace the stored ones as a whole: sent when they changed, and with a new list.
  if (patch.faturaIdler !== undefined || !sameAmounts(yerelKarsiliklar, base.yerelKarsiliklar)) patch.yerelKarsiliklar = yerelKarsiliklar;
  return patch;
}

function without(record: Readonly<Record<string, string>>, key: string): Readonly<Record<string, string>> {
  if (!(key in record)) return record;
  const next: Record<string, string> = { ...record };
  delete next[key];
  return next;
}

export function ExpenseForm({ mode, initial, autoSource, onDone }: ExpenseFormProps) {
  const { colors } = useTheme();
  const motion = useMotion();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const toast = useToast();
  const changed = useMasrafChanged();
  const kategoriler = useKategoriler();
  const ozet = useOzet();
  const scrollRef = useRef<ScrollViewInstance>(null);
  // Keys of the invoices in the last list sent to the server, to place `faturaIdler.<i>` errors.
  const sentKeys = useRef<readonly string[]>([]);
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

  const baseCurrency = localCurrency.toUpperCase();
  const currencyOf = (paraBirimi: string): string => (paraBirimi === '' ? localCurrency : paraBirimi).toUpperCase();
  const currency = currencyOf(values.paraBirimi);
  const needsKur = currency !== localCurrency.toUpperCase();
  const amount = parseAmount(values.tutar);
  const kur = parseAmount(values.kur);

  const fillFromInvoices = (list: readonly InvoiceAttachment[], readKey: string | null): void => {
    setForm((f) => fillState(f, list, readKey, localCurrency));
  };

  const attachments = useInvoiceAttachments(initial?.faturalar ?? [], {
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
    return id === null ? [] : [{ key: item.key, id, summary: attachmentSummary(item) }];
  });
  const faturaIdler = attached.map((a) => a.id);
  const readingCount = items.filter(isReading).length;
  const kurValid = kur !== null && kur > 0;
  const money = moneyOf(items, form.equivalents);
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

  const previewRequest: OnizlemeIstegi | null =
    amount !== null && amount > 0 && (!needsKur || (kur !== null && kur > 0))
      ? {
          tutar: amount,
          paraBirimi: currency,
          ...(needsKur && kur !== null ? { kur } : {}),
          ...(faturaIdler.length > 0 ? { faturaIdler } : {}),
          ...(hasEquivalents ? { yerelKarsiliklar } : {}),
        }
      : null;

  /**
   * Quick checks for instant feedback; the server's answer is what counts. Sending also needs every
   * equivalent (contract rule 6); a draft can be saved without them.
   */
  const validate = (send: boolean): boolean => {
    const local: Partial<Record<FieldKey, string>> = {};
    if (values.baslik.trim() === '') local.baslik = 'Başlık girin.';
    if (values.kategoriId === null) local.kategoriId = 'Bir kategori seçin.';
    if (amount === null || amount <= 0) local.tutar = 'Geçerli bir tutar girin.';
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
    if (Object.keys(equivalents).length > 0) {
      setFormError(
        send && missingEquivalents > 0
          ? `Onaya göndermek için ${baseCurrency} karşılığı eksik faturalar var. Taslak olarak kaydedebilirsiniz.`
          : 'Bazı alanları düzeltin.',
      );
      scrollRef.current?.scrollTo({ y: 0, animated: !motion.reduced });
    }
    return Object.keys(local).length === 0 && Object.keys(equivalents).length === 0;
  };

  const applyServerError = (err: unknown): void => {
    haptics.error();
    if (err instanceof ApiError) {
      const fieldErrors: Partial<Record<FieldKey, string>> = {};
      const itemErrors: Record<string, string> = {};
      const equivalentErrorsNext: Record<string, string> = {};
      const other: string[] = [];
      for (const [key, message] of Object.entries(err.alanlar)) {
        const match = INVOICE_FIELD.exec(key);
        const itemKey = match !== null ? sentKeys.current[Number(match[1])] : undefined;
        const equivalentId = EQUIVALENT_FIELD.exec(key)?.[1];
        if (equivalentId !== undefined && faturaIdler.includes(equivalentId)) equivalentErrorsNext[equivalentId] = message;
        else if (itemKey !== undefined) itemErrors[itemKey] = message;
        else if (match !== null) fieldErrors.faturaIdler = message;
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
      const hasFieldErrors =
        Object.keys(fieldErrors).length > 0 || Object.keys(itemErrors).length > 0 || Object.keys(equivalentErrorsNext).length > 0;
      setFormError(
        err.kod === 'karsilik_eksik'
          ? `Onaya göndermek için ${baseCurrency} karşılığı eksik faturalar var. Taslak olarak kaydedebilirsiniz.`
          : hasFieldErrors
            ? other.length > 0
              ? other.join('\n')
              : 'Bazı alanları düzeltin.'
            : [err.message, ...err.sorunlar].join('\n'),
      );
    } else {
      setFormError(errorMessage(err));
    }
    scrollRef.current?.scrollTo({ y: 0, animated: !motion.reduced });
  };

  const save = async (send: boolean): Promise<void> => {
    if (saving.current) return;
    saving.current = true;
    setBusy(send ? 'send' : 'draft');
    setInvoiceErrors({});
    const fields = {
      baslik: values.baslik.trim(),
      kategoriId: values.kategoriId as number,
      masrafTarihi: values.masrafTarihi,
      tutar: amount as number,
      paraBirimi: currency,
    };
    try {
      if (mode === 'create') {
        sentKeys.current = attached.map((a) => a.key);
        const detail = await createMasraf({
          ...fields,
          ...(needsKur && kur !== null ? { kur } : {}),
          ...(values.satici.trim() !== '' ? { satici: values.satici.trim() } : {}),
          ...(values.aciklama.trim() !== '' ? { aciklama: values.aciklama.trim() } : {}),
          ...(faturaIdler.length > 0 ? { faturaIdler } : {}),
          ...(hasEquivalents ? { yerelKarsiliklar } : {}),
          gonder: send,
        });
        await changed(detail);
        haptics.success();
        toast(send ? 'Masraf onaya gönderildi.' : 'Taslak kaydedildi.', 'success');
        onDone(detail, send);
        return;
      }
      if (initial === undefined || base === null) return;
      // Edit: PATCH what changed since the screen opened (empty optional text clears it), then send when asked.
      const patch = editPatch(
        {
          ...fields,
          kur: needsKur ? kur : null,
          satici: values.satici.trim() === '' ? null : values.satici.trim(),
          aciklama: values.aciklama.trim() === '' ? null : values.aciklama.trim(),
        },
        faturaIdler,
        yerelKarsiliklar,
        base,
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
        await changed(detail);
      }
      if (send) {
        try {
          detail = await runMasrafAction(initial.id, 'gonder');
          await changed(detail);
        } catch (err) {
          // Nothing was saved: show it like any failed save, on this screen.
          if (!patched) throw err;
          if (err instanceof ApiError && err.kod === 'karsilik_eksik') {
            // Saved, but an equivalent is missing: stay so the user can enter it. What was saved is the new base.
            setBase(savedFields(detail));
            applyServerError(err);
            setFormError(`Değişiklikler kaydedildi ancak gönderilemedi. Onaya göndermek için ${baseCurrency} karşılığı eksik faturalar var.`);
            return;
          }
          // Saved but not sent (e.g. 409 onaylayan_yok): keep the changes, show why it did not go out.
          haptics.error();
          toast(`Değişiklikler kaydedildi ancak gönderilemedi: ${errorMessage(err)}`, 'danger');
          onDone(detail, false);
          return;
        }
      }
      haptics.success();
      toast(send ? 'Masraf onaya gönderildi.' : 'Değişiklikler kaydedildi.', 'success');
      onDone(detail, send);
    } catch (err) {
      applyServerError(err);
    } finally {
      saving.current = false;
      setBusy(null);
    }
  };

  const submit = (send: boolean): void => {
    if (busy !== null || attachments.busy) return;
    setFormError(null);
    if (!validate(send)) {
      haptics.error();
      return;
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

  const currencies = Array.from(new Set<string>([localCurrency.toUpperCase(), ...BASE_CURRENCIES, currency]));
  const showPicker = items.length === 0 && !manual;
  const several = items.length > 1;
  // While saving, the invoice list is fixed: what is being saved is what the user sees.
  const locked = busy !== null;
  const canSend = mode === 'create' || initial?.izinler.gonder === true;

  /** The equivalent field of an invoice in a third currency; null for any other invoice. */
  const equivalentInput = (item: InvoiceAttachment): EquivalentInput | null => {
    const id = attachmentId(item);
    const summary = attachmentSummary(item);
    if (id === null || summary === null || !needsEquivalent(currency, baseCurrency, summary)) return null;
    return { value: form.equivalents[id] ?? '', error: equivalentErrors[id], onChange: (text) => setEquivalent(id, text) };
  };

  /** Base-currency amounts on a foreign-currency form count through the rate; say so while it is missing. */
  const rateNote = (item: InvoiceAttachment): string | null => {
    const summary = attachmentSummary(item);
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
                  <Animated.View key={isReading(item) ? 'reading' : isFailed(item) ? 'failed' : 'ready'} entering={motion.fadeIn}>
                    <InvoiceItem
                      item={item}
                      compact={several}
                      currency={currency}
                      baseCurrency={baseCurrency}
                      equivalent={equivalentInput(item)}
                      note={rateNote(item)}
                      error={invoiceErrors[item.key]}
                      disabled={locked}
                      onRemove={() => removeInvoice(item.key)}
                      onRetry={() => retryInvoice(item.key)}
                    />
                  </Animated.View>
                </Animated.View>
              ))}
              {invoiceSum !== null && invoiceSum.count > 1 ? (
                <Text variant="small" tone="muted" style={styles.groupLabel}>
                  {invoiceSum.count} faturanın toplamı: {formatMoney(invoiceSum.total, currency)}
                </Text>
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
          />

          <View style={styles.fieldGroup}>
            <Text variant="label" tone="muted" style={styles.groupLabel}>
              Kategori
            </Text>
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

          <View style={styles.fieldGroup}>
            <Text variant="label" tone="muted" style={styles.groupLabel}>
              Masraf tarihi
            </Text>
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
              form.amountCleared
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
        {attachments.busy ? (
          <Text variant="caption" tone="muted" align="center">
            {readingCount > 1
              ? 'Faturalar okunurken kaydedilemez; okumalar bitince düğmeler açılır.'
              : 'Fatura okunurken kaydedilemez; okuma bitince düğmeler açılır.'}
          </Text>
        ) : canSend && missingEquivalents > 0 ? (
          <Text variant="caption" tone="warning" align="center">
            {missingEquivalents === 1 ? 'Bir faturanın' : `${missingEquivalents} faturanın`} {baseCurrency} karşılığı eksik; onaya göndermeden
            önce girin. Taslak olarak kaydedilebilir.
          </Text>
        ) : null}
        <View style={styles.row}>
          {/* Content-wide and without an icon, so "Onaya gönder" / "Kaydet ve gönder" keeps one line at 360 pt. */}
          <Button
            title={mode === 'create' ? 'Taslak kaydet' : 'Kaydet'}
            variant="outline"
            flex={!canSend}
            loading={busy === 'draft'}
            disabled={attachments.busy || busy === 'send'}
            onPress={() => submit(false)}
          />
          {canSend ? (
            <Button
              title={mode === 'create' ? 'Onaya gönder' : 'Kaydet ve gönder'}
              icon="paper-plane"
              flex
              loading={busy === 'send'}
              disabled={attachments.busy || busy === 'draft'}
              onPress={() => submit(true)}
            />
          ) : null}
        </View>
      </View>

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
  error,
  disabled,
  onRemove,
  onRetry,
}: {
  readonly item: InvoiceAttachment;
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
  readonly error: string | undefined;
  /** No removing or retrying while the form is being saved. */
  readonly disabled: boolean;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
}) {
  const { colors } = useTheme();
  const thumbW = compact ? 44 : 56;
  const thumbH = compact ? 56 : 70;

  if (item.kind === 'local' && (item.reading.phase === 'pending' || item.reading.phase === 'uploading' || item.reading.phase === 'waiting')) {
    const reading = item.reading;
    return (
      <ReadingCard
        file={item.file}
        startedAt={reading.startedAt}
        phase={reading.phase === 'waiting' ? reading.itemState : reading.phase}
        onCancel={onRemove}
        compact={compact}
      />
    );
  }

  if (item.kind === 'local' && item.reading.phase === 'failed') {
    const message = item.reading.message;
    return (
      <View style={[styles.attached, compact && styles.attachedCompact, { backgroundColor: colors.surface, borderColor: colors.warning }]}>
        {/* Top-aligned: a long server message must not push the thumbnail down. */}
        <View style={[styles.attachedRow, styles.attachedRowTop]}>
          <InvoiceThumb source={{ kind: 'local', uri: item.file.uri, mime: item.file.mimeType }} width={thumbW} height={thumbH} />
          <View style={styles.flex} accessible accessibilityLabel={`Okunamadı: ${item.file.name}. ${message}`}>
            <View style={styles.attachedTitle}>
              <Ionicons name="alert-circle" size={18} color={colors.warning} />
              <Text variant="bodyStrong" style={styles.flex}>
                Okunamadı
              </Text>
            </View>
            <Text variant="caption" tone="faint" numberOfLines={1}>
              {item.file.name}
            </Text>
            {/* The full message is in the label above; a long technical one would make the card very tall. */}
            <Text variant="small" tone="muted" numberOfLines={compact ? 3 : 4}>
              {compact ? message : `${message} Bilgileri elle girebilirsiniz.`}
            </Text>
          </View>
        </View>
        <View style={styles.row}>
          <Button
            title="Tekrar dene"
            icon="refresh"
            size="sm"
            variant="secondary"
            flex
            accessibilityLabel={`Tekrar dene: ${item.file.name}`}
            disabled={disabled}
            onPress={onRetry}
          />
          <Button
            title="Kaldır"
            icon="trash-outline"
            size="sm"
            variant="dangerSoft"
            flex
            accessibilityLabel={`Kaldır: ${item.file.name}`}
            disabled={disabled}
            onPress={onRemove}
          />
        </View>
      </View>
    );
  }

  const summary = attachmentSummary(item);
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
  const invalid = error !== undefined || equivalent?.error !== undefined;

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
        <View style={styles.flex} accessible accessibilityLabel={[title, name, ...facts, note, emptyNote].filter((p) => p !== null).join('. ')}>
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
        </View>
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
  attached: { borderRadius: radius.xl, borderWidth: 1.5, padding: spacing.lg, gap: spacing.md },
  attachedCompact: { padding: spacing.md, gap: spacing.sm },
  attachedRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  attachedRowTop: { alignItems: 'flex-start' },
  attachedTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  footer: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
});
