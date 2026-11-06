import { Ionicons } from '@expo/vector-icons';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, errorMessage } from '@/api/client';
import { createMasraf, runMasrafAction, updateMasraf, type PickedFile } from '@/api/endpoints';
import { useKategoriler, useMasrafChanged, useOzet } from '@/api/queries';
import type { MasrafDetay, MasrafFatura, MasrafGuncelleIstegi, OkunanFatura, OnizlemeIstegi } from '@/api/types';
import { InvoiceThumb } from '@/components/expense/InvoiceThumb';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { PressableScale } from '@/components/ui/PressableScale';
import { Skeleton } from '@/components/ui/Skeleton';
import { Banner } from '@/components/ui/StateViews';
import { Text } from '@/components/ui/Text';
import { FieldError, TextField } from '@/components/ui/TextField';
import { useToast } from '@/components/ui/Toast';
import { useInvoiceReading } from '@/hooks/useInvoiceReading';
import { useMotion } from '@/hooks/useMotion';
import { categoryIcon } from '@/lib/categories';
import { amountToInput, formatDate, formatDateFriendly, formatMoney, parseAmount, todayIso, toIsoDate } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import { pickInvoice, type InvoiceSource } from '@/lib/pickers';
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

type FieldKey = keyof Values | 'faturaId';
const FIELD_KEYS: readonly FieldKey[] = ['baslik', 'kategoriId', 'masrafTarihi', 'tutar', 'paraBirimi', 'kur', 'satici', 'aciklama', 'faturaId'];

type Attached =
  | { readonly kind: 'none' }
  /** The invoice already on the form (edit mode). */
  | { readonly kind: 'server'; readonly fatura: MasrafFatura }
  /** An invoice read in this session. */
  | { readonly kind: 'read'; readonly file: PickedFile; readonly kayitId: string; readonly sonuc: OkunanFatura | null; readonly onbellek: boolean };

const BASE_CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP'] as const;

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

export function ExpenseForm({ mode, initial, autoSource, onDone }: ExpenseFormProps) {
  const { colors } = useTheme();
  const motion = useMotion();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const toast = useToast();
  const changed = useMasrafChanged();
  const kategoriler = useKategoriler();
  const ozet = useOzet();
  const reading = useInvoiceReading();
  const scrollRef = useRef<ScrollViewInstance>(null);

  const [values, setValues] = useState<Values>(() => initialValues(initial));
  const [touched, setTouched] = useState<Partial<Record<keyof Values, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [attached, setAttached] = useState<Attached>(
    initial?.fatura !== null && initial?.fatura !== undefined ? { kind: 'server', fatura: initial.fatura } : { kind: 'none' },
  );
  const [manual, setManual] = useState(mode === 'edit');
  const [busy, setBusy] = useState<'draft' | 'send' | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [autoStarted, setAutoStarted] = useState(false);

  const localCurrency = ozet.data?.paraBirimi ?? 'TRY';
  const currency = (values.paraBirimi === '' ? localCurrency : values.paraBirimi).toUpperCase();
  const needsKur = currency !== localCurrency.toUpperCase();
  const amount = parseAmount(values.tutar);
  const kur = parseAmount(values.kur);
  const faturaId = attached.kind === 'server' ? attached.fatura.id : attached.kind === 'read' ? attached.kayitId : null;
  const initialFaturaId = initial?.faturaId ?? null;

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
    try {
      const file = await pickInvoice(choice);
      if (file !== null) {
        setFormError(null);
        setErrors((e) => ({ ...e, faturaId: undefined }));
        reading.start(file);
      }
    } catch (err) {
      haptics.error();
      setFormError(err instanceof Error && err.message !== '' ? `Dosya seçilemedi: ${err.message}` : 'Dosya seçilemedi.');
    }
  };

  // "Fiş tara" opens the camera as soon as the screen is up.
  useEffect(() => {
    if (autoSource === undefined || autoStarted) return;
    setAutoStarted(true);
    void choose(autoSource);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSource, autoStarted]);

  // A finished reading attaches the invoice and fills every field the user has not typed into.
  const readingState = reading.state;
  useEffect(() => {
    if (readingState.phase !== 'done') return;
    const fatura = readingState.sonuc?.fatura;
    setAttached({ kind: 'read', file: readingState.file, kayitId: readingState.kayitId, sonuc: readingState.sonuc, onbellek: readingState.onbellek });
    if (fatura !== undefined) {
      setValues((v) => ({
        ...v,
        tutar: !touched.tutar && fatura.genelToplam !== null && fatura.genelToplam > 0 ? amountToInput(fatura.genelToplam) : v.tutar,
        paraBirimi: !touched.paraBirimi && fatura.paraBirimi !== null ? fatura.paraBirimi : v.paraBirimi,
        masrafTarihi:
          !touched.masrafTarihi && fatura.faturaTarihi !== null && fatura.faturaTarihi <= todayIso() ? fatura.faturaTarihi : v.masrafTarihi,
        satici: !touched.satici && fatura.saticiUnvan !== null ? fatura.saticiUnvan : v.satici,
        baslik: !touched.baslik && fatura.saticiUnvan !== null ? fatura.saticiUnvan.slice(0, 120) : v.baslik,
      }));
    }
    haptics.success();
    reading.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingState]);

  useEffect(() => {
    if (readingState.phase === 'failed') haptics.warning();
  }, [readingState]);

  const previewRequest: OnizlemeIstegi | null =
    amount !== null && amount > 0 && (!needsKur || (kur !== null && kur > 0))
      ? {
          tutar: amount,
          paraBirimi: currency,
          ...(needsKur && kur !== null ? { kur } : {}),
          ...(faturaId !== null ? { faturaId } : {}),
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
      const other: string[] = [];
      for (const [key, message] of Object.entries(err.alanlar)) {
        if ((FIELD_KEYS as readonly string[]).includes(key)) fieldErrors[key as FieldKey] = message;
        else other.push(message);
      }
      if (err.kod === 'fatura_kullaniliyor' && fieldErrors.faturaId === undefined) fieldErrors.faturaId = err.message;
      setErrors(fieldErrors);
      const hasFieldErrors = Object.keys(fieldErrors).length > 0;
      setFormError(hasFieldErrors ? (other.length > 0 ? other.join('\n') : 'Bazı alanları düzeltin.') : [err.message, ...err.sorunlar].join('\n'));
    } else {
      setFormError(errorMessage(err));
    }
    scrollRef.current?.scrollTo({ y: 0, animated: !motion.reduced });
  };

  const submit = async (send: boolean): Promise<void> => {
    if (busy !== null || reading.busy) return;
    setFormError(null);
    if (!validate()) {
      haptics.error();
      return;
    }
    setBusy(send ? 'send' : 'draft');
    const fields = {
      baslik: values.baslik.trim(),
      kategoriId: values.kategoriId as number,
      masrafTarihi: values.masrafTarihi,
      tutar: amount as number,
      paraBirimi: currency,
    };
    try {
      if (mode === 'create') {
        const detail = await createMasraf({
          ...fields,
          ...(needsKur && kur !== null ? { kur } : {}),
          ...(values.satici.trim() !== '' ? { satici: values.satici.trim() } : {}),
          ...(values.aciklama.trim() !== '' ? { aciklama: values.aciklama.trim() } : {}),
          ...(faturaId !== null ? { faturaId } : {}),
          gonder: send,
        });
        await changed(detail);
        haptics.success();
        toast(send ? 'Masraf onaya gönderildi.' : 'Taslak kaydedildi.', 'success');
        onDone(detail, send);
        return;
      }
      if (initial === undefined) return;
      // Edit: PATCH every field (empty optional text clears it), then send when asked.
      const patch: MasrafGuncelleIstegi = {
        ...fields,
        kur: needsKur ? kur : null,
        satici: values.satici.trim() === '' ? null : values.satici.trim(),
        aciklama: values.aciklama.trim() === '' ? null : values.aciklama.trim(),
        ...(faturaId !== initialFaturaId ? { faturaId } : {}),
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

  const currencies = Array.from(new Set<string>([localCurrency.toUpperCase(), ...BASE_CURRENCIES, currency]));
  const showPicker = attached.kind === 'none' && reading.state.phase === 'idle' && !manual;
  const state = reading.state;

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

        {/* Invoice */}
        <Animated.View layout={motion.layout} style={styles.section}>
          {showPicker ? (
            <>
              <Text variant="heading" accessibilityRole="header">
                Fatura veya fiş ekle
              </Text>
              <Text variant="small" tone="muted">
                Fotoğrafını çekin ya da dosyayı seçin; tutar, tarih ve satıcıyı biz dolduralım.
              </Text>
              <SourcePicker onPick={(c) => void choose(c)} />
            </>
          ) : state.phase === 'uploading' || state.phase === 'waiting' ? (
            <ReadingCard
              file={state.file}
              startedAt={state.startedAt}
              phase={state.phase === 'uploading' ? 'uploading' : state.itemState}
              onCancel={() => {
                reading.reset();
                setManual(true);
              }}
            />
          ) : state.phase === 'failed' ? (
            <View style={styles.section}>
              <Banner tone="warning" message={`${state.message} Bilgileri elle girebilirsiniz.`} />
              <View style={styles.row}>
                <Button title="Tekrar dene" icon="refresh" size="sm" variant="secondary" flex onPress={() => reading.start(state.file)} />
                <Button
                  title="Başka dosya"
                  icon="swap-horizontal"
                  size="sm"
                  variant="outline"
                  flex
                  onPress={() => {
                    reading.reset();
                    setManual(false);
                  }}
                />
              </View>
            </View>
          ) : attached.kind !== 'none' ? (
            <AttachedInvoice
              attached={attached}
              error={errors.faturaId}
              onReplace={() => {
                setAttached({ kind: 'none' });
                setManual(false);
              }}
              onRemove={() => {
                setAttached({ kind: 'none' });
                setManual(true);
                setErrors((e) => ({ ...e, faturaId: undefined }));
              }}
            />
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
          <FieldError message={attached.kind === 'none' ? errors.faturaId : undefined} />
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
                <Chip key={code} label={code} selected={currency === code} onPress={() => set('paraBirimi', code)} />
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
        {reading.busy ? (
          <Text variant="caption" tone="muted" align="center">
            Fatura okunurken kaydedilemez; okuma bitince düğmeler açılır.
          </Text>
        ) : null}
        <View style={styles.row}>
          <Button
            title={mode === 'create' ? 'Taslak kaydet' : 'Kaydet'}
            icon="save-outline"
            variant="outline"
            flex
            loading={busy === 'draft'}
            disabled={reading.busy || busy === 'send'}
            onPress={() => void submit(false)}
          />
          {mode === 'create' || initial?.izinler.gonder === true ? (
            <Button
              title={mode === 'create' ? 'Onaya gönder' : 'Kaydet ve gönder'}
              icon="paper-plane"
              flex
              loading={busy === 'send'}
              disabled={reading.busy || busy === 'draft'}
              onPress={() => void submit(true)}
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

function AttachedInvoice({
  attached,
  error,
  onReplace,
  onRemove,
}: {
  readonly attached: Exclude<Attached, { kind: 'none' }>;
  readonly error: string | undefined;
  readonly onReplace: () => void;
  readonly onRemove: () => void;
}) {
  const { colors } = useTheme();
  const motion = useMotion();
  const read = attached.kind === 'read';
  const fatura = read ? attached.sonuc?.fatura : attached.fatura;
  const title = read ? (attached.onbellek ? 'Fatura daha önce okunmuş' : 'Fatura okundu') : 'Bağlı fatura';
  const name = read ? attached.file.name : (attached.fatura.dosyaAdi ?? attached.fatura.faturaNo ?? 'Fatura');
  const facts = [
    fatura?.genelToplam !== null && fatura?.genelToplam !== undefined ? formatMoney(fatura.genelToplam, fatura.paraBirimi ?? 'TRY') : null,
    fatura?.faturaTarihi !== null && fatura?.faturaTarihi !== undefined ? formatDate(fatura.faturaTarihi) : null,
    fatura?.saticiUnvan ?? null,
  ].filter((f): f is string => f !== null);
  return (
    <Animated.View
      entering={motion.enter(0)}
      style={[styles.attached, { backgroundColor: colors.surface, borderColor: error !== undefined ? colors.danger : colors.success }]}
    >
      <View style={styles.attachedRow}>
        <InvoiceThumb
          source={
            read
              ? { kind: 'local', uri: attached.file.uri, mime: attached.file.mimeType }
              : { kind: 'remote', faturaId: attached.fatura.id, mime: attached.fatura.mime, hasFile: attached.fatura.dosyaVar }
          }
          width={56}
          height={70}
        />
        <View style={styles.flex}>
          <View style={styles.attachedTitle}>
            <Ionicons name="checkmark-circle" size={18} color={colors.success} />
            <Text variant="bodyStrong" style={styles.flex}>
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
          ) : read ? (
            <Text variant="small" tone="muted">
              Faturadan alan okunamadı; bilgileri elle girin.
            </Text>
          ) : null}
        </View>
      </View>
      {error !== undefined ? <FieldError message={error} /> : null}
      <View style={styles.row}>
        <Button title="Değiştir" icon="swap-horizontal" size="sm" variant="secondary" flex onPress={onReplace} />
        <Button title="Kaldır" icon="trash-outline" size="sm" variant="dangerSoft" flex onPress={onRemove} />
      </View>
    </Animated.View>
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
  attached: { borderRadius: radius.xl, borderWidth: 1.5, padding: spacing.lg, gap: spacing.md },
  attachedRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  attachedTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  footer: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
});
