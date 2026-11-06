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
import { amountToInput, formatDate, formatDateFriendly, formatMoney, parseAmount, todayIso, toIsoDate } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import { invoiceTotal, isOtherCurrency, MAX_INVOICES, sameIds, type InvoiceSummary } from '@/lib/invoices';
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

/**
 * A saved amount that differs from its invoices' total was set by hand, so it counts as typed and is not
 * replaced when invoices are added or removed. An amount equal to the total keeps following the invoices.
 */
function initialTouched(initial: MasrafDetay | undefined): Partial<Record<keyof Values, boolean>> {
  if (initial === undefined) return {};
  const sum = invoiceTotal(initial.faturalar, initial.paraBirimi);
  return sum !== null && Math.round(sum.total * 100) !== Math.round(initial.tutar * 100) ? { tutar: true } : {};
}

function summariesOf(list: readonly InvoiceAttachment[]): InvoiceSummary[] {
  return list.map(attachmentSummary).filter((s): s is InvoiceSummary => s !== null);
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

  const [values, setValues] = useState<Values>(() => initialValues(initial));
  const [touched, setTouched] = useState<Partial<Record<keyof Values, boolean>>>(() => initialTouched(initial));
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [invoiceErrors, setInvoiceErrors] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [manual, setManual] = useState(mode === 'edit');
  const [busy, setBusy] = useState<'draft' | 'send' | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const localCurrency = ozet.data?.paraBirimi ?? 'TRY';
  const currencyOf = (paraBirimi: string): string => (paraBirimi === '' ? localCurrency : paraBirimi).toUpperCase();
  const currency = currencyOf(values.paraBirimi);
  const needsKur = currency !== localCurrency.toUpperCase();
  const amount = parseAmount(values.tutar);
  const kur = parseAmount(values.kur);

  /**
   * Fills what the user has not typed into from the invoices. The first invoice with read data fills the
   * date, seller, title and currency once it is read (`readKey`); the amount follows the sum of the
   * invoices in the form's currency until the user types an amount.
   */
  const fillFromInvoices = (list: readonly InvoiceAttachment[], readKey: string | null): void => {
    setValues((v) => {
      let next = v;
      if (readKey !== null) {
        const first = list.find((item) => attachmentSummary(item) !== null);
        const f = first !== undefined && first.key === readKey ? attachmentSummary(first) : null;
        if (f !== null) {
          next = {
            ...next,
            paraBirimi: !touched.paraBirimi && f.paraBirimi !== null ? f.paraBirimi : next.paraBirimi,
            masrafTarihi:
              !touched.masrafTarihi && f.faturaTarihi !== null && f.faturaTarihi <= todayIso() ? f.faturaTarihi : next.masrafTarihi,
            satici: !touched.satici && f.saticiUnvan !== null ? f.saticiUnvan : next.satici,
            baslik: !touched.baslik && f.saticiUnvan !== null ? f.saticiUnvan.slice(0, 120) : next.baslik,
          };
        }
      }
      if (!touched.tutar) {
        const sum = invoiceTotal(summariesOf(list), currencyOf(next.paraBirimi));
        if (sum !== null) next = { ...next, tutar: amountToInput(sum.total) };
      }
      return next;
    });
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
    return id === null ? [] : [{ key: item.key, id }];
  });
  const faturaIdler = attached.map((a) => a.id);
  const initialIds = initial?.faturalar.map((f) => f.id) ?? [];
  const readingCount = items.filter(isReading).length;
  const invoiceSum = invoiceTotal(summariesOf(items), currency);

  const set = <K extends keyof Values>(key: K, value: Values[K]): void => {
    setValues((v) => ({ ...v, [key]: value }));
    setTouched((t) => ({ ...t, [key]: true }));
    if (errors[key] !== undefined) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const choose = async (choice: SourceChoice): Promise<void> => {
    if (choice === 'elle') {
      setManual(true);
      return;
    }
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
      if (files.length === 0) return;
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

  // "Fiş tara" opens the camera as soon as the screen is up.
  useEffect(() => {
    if (autoSource === undefined || autoStarted.current) return;
    autoStarted.current = true;
    void choose(autoSource);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSource]);

  const removeInvoice = (key: string): void => {
    const list = attachments.remove(key);
    setInvoiceErrors((e) => without(e, key));
    setErrors((e) => ({ ...e, faturaIdler: undefined }));
    if (list.length === 0) setManual(true);
    fillFromInvoices(list, null);
  };

  const retryInvoice = (key: string): void => {
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
        }
      : null;

  /** Quick checks for instant feedback; the server's answer is what counts. */
  const validate = (): boolean => {
    const local: Partial<Record<FieldKey, string>> = {};
    if (values.baslik.trim() === '') local.baslik = 'Başlık girin.';
    if (values.kategoriId === null) local.kategoriId = 'Bir kategori seçin.';
    if (amount === null || amount <= 0) local.tutar = 'Geçerli bir tutar girin.';
    if (needsKur && (kur === null || kur <= 0)) local.kur = `${currency} için kur girin.`;
    setErrors(local);
    return Object.keys(local).length === 0;
  };

  const applyServerError = (err: unknown): void => {
    haptics.error();
    if (err instanceof ApiError) {
      const fieldErrors: Partial<Record<FieldKey, string>> = {};
      const itemErrors: Record<string, string> = {};
      const other: string[] = [];
      for (const [key, message] of Object.entries(err.alanlar)) {
        const match = INVOICE_FIELD.exec(key);
        const itemKey = match !== null ? sentKeys.current[Number(match[1])] : undefined;
        if (itemKey !== undefined) itemErrors[itemKey] = message;
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
      const hasFieldErrors = Object.keys(fieldErrors).length > 0 || Object.keys(itemErrors).length > 0;
      setFormError(hasFieldErrors ? (other.length > 0 ? other.join('\n') : 'Bazı alanları düzeltin.') : [err.message, ...err.sorunlar].join('\n'));
    } else {
      setFormError(errorMessage(err));
    }
    scrollRef.current?.scrollTo({ y: 0, animated: !motion.reduced });
  };

  const save = async (send: boolean): Promise<void> => {
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
          gonder: send,
        });
        await changed(detail);
        haptics.success();
        toast(send ? 'Masraf onaya gönderildi.' : 'Taslak kaydedildi.', 'success');
        onDone(detail, send);
        return;
      }
      if (initial === undefined) return;
      // Edit: PATCH every field (empty optional text clears it), then send when asked. The invoice list
      // replaces the form's invoices entirely, so it goes only when it changed; otherwise the invoices
      // stay exactly as they are (including any added on the web panel).
      const invoicesChanged = !sameIds(faturaIdler, initialIds);
      sentKeys.current = invoicesChanged ? attached.map((a) => a.key) : [];
      const patch: MasrafGuncelleIstegi = {
        ...fields,
        kur: needsKur ? kur : null,
        satici: values.satici.trim() === '' ? null : values.satici.trim(),
        aciklama: values.aciklama.trim() === '' ? null : values.aciklama.trim(),
        ...(invoicesChanged ? { faturaIdler } : {}),
      };
      let detail = await updateMasraf(initial.id, patch);
      await changed(detail);
      if (send) {
        try {
          detail = await runMasrafAction(initial.id, 'gonder');
          await changed(detail);
        } catch (err) {
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
      setBusy(null);
    }
  };

  const submit = (send: boolean): void => {
    if (busy !== null || attachments.busy) return;
    setFormError(null);
    if (!validate()) {
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
                      error={invoiceErrors[item.key]}
                      onRemove={() => removeInvoice(item.key)}
                      onRetry={() => retryInvoice(item.key)}
                    />
                  </Animated.View>
                </Animated.View>
              ))}
              {invoiceSum !== null && invoiceSum.count > 1 ? (
                <Text variant="small" tone="muted" style={styles.groupLabel}>
                  {invoiceSum.count} faturanın genel toplamı: {formatMoney(invoiceSum.total, currency)}
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
                <Text variant="bodyStrong" style={styles.flex}>
                  {formatDateFriendly(values.masrafTarihi)}
                </Text>
                <Text variant="small" tone="muted">
                  {formatDate(values.masrafTarihi)}
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
            hint={amount !== null && amount > 0 ? formatMoney(amount, currency) : undefined}
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
                onChangeText={(t) => set('kur', t.replace(/[^0-9.,]/g, ''))}
                placeholder="Örn. 34,25"
                keyboardType="decimal-pad"
                error={errors.kur}
                hint={
                  amount !== null && kur !== null ? `Yerel tutar: ${formatMoney(Math.round(amount * kur * 100) / 100, localCurrency)}` : 'Para birimi yerel para biriminden farklı; kur zorunludur.'
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
        ) : null}
        <View style={styles.row}>
          <Button
            title={mode === 'create' ? 'Taslak kaydet' : 'Kaydet'}
            icon="save-outline"
            variant="outline"
            flex
            loading={busy === 'draft'}
            disabled={attachments.busy || busy === 'send'}
            onPress={() => submit(false)}
          />
          {mode === 'create' || initial?.izinler.gonder === true ? (
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

/** One invoice of the list: reading, failed, read on this device or already on the form. */
function InvoiceItem({
  item,
  compact,
  currency,
  error,
  onRemove,
  onRetry,
}: {
  readonly item: InvoiceAttachment;
  /** Several invoices on the form: smaller cards. */
  readonly compact: boolean;
  /** The form's currency; invoices in another one stay out of the total. */
  readonly currency: string;
  readonly error: string | undefined;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
}) {
  const { colors } = useTheme();
  const thumbW = compact ? 44 : 56;
  const thumbH = compact ? 56 : 70;

  if (item.kind === 'local' && (item.reading.phase === 'uploading' || item.reading.phase === 'waiting')) {
    const reading = item.reading;
    return (
      <ReadingCard
        file={item.file}
        startedAt={reading.startedAt}
        phase={reading.phase === 'uploading' ? 'uploading' : reading.itemState}
        onCancel={onRemove}
        compact={compact}
      />
    );
  }

  if (item.kind === 'local' && item.reading.phase === 'failed') {
    const message = item.reading.message;
    return (
      <View style={[styles.attached, compact && styles.attachedCompact, { backgroundColor: colors.surface, borderColor: colors.warning }]}>
        <View style={styles.attachedRow}>
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
            <Text variant="small" tone="muted">
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
            onPress={onRetry}
          />
          <Button
            title="Kaldır"
            icon="trash-outline"
            size="sm"
            variant="dangerSoft"
            flex
            accessibilityLabel={`Kaldır: ${item.file.name}`}
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
        ? 'Fatura daha önce okunmuş'
        : 'Fatura okundu';
  const name = item.kind === 'server' ? (item.fatura.dosyaAdi ?? item.fatura.faturaNo ?? 'Fatura') : item.file.name;
  const facts = [
    summary?.genelToplam !== null && summary?.genelToplam !== undefined ? formatMoney(summary.genelToplam, summary.paraBirimi ?? currency) : null,
    summary?.faturaTarihi !== null && summary?.faturaTarihi !== undefined ? formatDate(summary.faturaTarihi) : null,
    summary?.saticiUnvan ?? null,
  ].filter((f): f is string => f !== null);
  const otherCurrency = summary !== null && isOtherCurrency(summary, currency) ? summary.paraBirimi : null;
  const otherNote = otherCurrency !== null ? `${otherCurrency} faturası; ${currency} tutar toplamına girmez.` : null;
  const emptyNote = facts.length === 0 && item.kind === 'local' ? 'Faturadan alan okunamadı; bilgileri elle girin.' : null;

  return (
    <View
      style={[
        styles.attached,
        compact && styles.attachedCompact,
        { backgroundColor: colors.surface, borderColor: error !== undefined ? colors.danger : colors.success },
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
        <View style={styles.flex} accessible accessibilityLabel={[title, name, ...facts, otherNote, emptyNote].filter((p) => p !== null).join('. ')}>
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
          {otherNote !== null ? (
            <Text variant="caption" tone="warning">
              {otherNote}
            </Text>
          ) : null}
        </View>
        <IconButton icon="trash-outline" tone="soft" color={colors.danger} accessibilityLabel={`Faturayı kaldır: ${name}`} onPress={onRemove} />
      </View>
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
  attachedTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  footer: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
});
