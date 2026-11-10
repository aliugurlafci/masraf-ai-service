import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Switch, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, errorMessage } from '@/api/client';
import { approveMasraf, rejectMasraf, runMasrafAction, updateMasraf, type MasrafIslemi } from '@/api/endpoints';
import { useAlanlar, useMasraf, useMasrafChanged, useOzet } from '@/api/queries';
import type { BekleyenFatura, MasrafDetay, MasrafFatura } from '@/api/types';
import { CategoryIcon } from '@/components/expense/CategoryIcon';
import { InvoiceInfoCard } from '@/components/expense/InvoiceInfoCard';
import { InvoiceThumb } from '@/components/expense/InvoiceThumb';
import { PendingInvoices } from '@/components/expense/PendingInvoices';
import { StatusBadge } from '@/components/expense/StatusBadge';
import { ApprovalTimeline, HistoryList } from '@/components/expense/Timeline';
import { Button, type ButtonVariant, type IconName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PressableScale } from '@/components/ui/PressableScale';
import { Sheet } from '@/components/ui/Sheet';
import { Skeleton } from '@/components/ui/Skeleton';
import { Banner, ErrorState } from '@/components/ui/StateViews';
import { Text } from '@/components/ui/Text';
import { TextField } from '@/components/ui/TextField';
import { useToast } from '@/components/ui/Toast';
import { useMotion } from '@/hooks/useMotion';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import { displayName, fieldName, type FieldDefs } from '@/lib/fields';
import { invoiceTotalInForm } from '@/lib/invoices';
import { isPdf } from '@/lib/pickers';
import { autoSendFailure } from '@/lib/reading';
import { amountLargeFor, radius, spacing, statusColors, useTheme } from '@/theme';

type ActionKey = 'duzenle' | 'gonder' | 'geriCek' | 'iptal' | 'onayla' | 'reddet' | 'odendi' | 'yenidenOku' | 'okununcaGonder' | 'bekleyen';

/** Send errors the sender fixes by editing the form. */
const FIXABLE: readonly string[] = ['karsilik_eksik', 'fatura_eksik', 'alan_eksik', 'fatura_mukerrer', 'tutar_eksik'];

/** Titles for the send errors explained in an alert (the server's message is the text). */
const SEND_ERROR_TITLES: Readonly<Record<string, string>> = {
  fatura_eksik: 'Fatura bilgisi eksik',
  alan_eksik: 'Zorunlu alan eksik',
  fatura_mukerrer: 'Mükerrer fatura',
  tutar_eksik: 'Tutar eksik',
  okuma_suruyor: 'Faturalar okunuyor',
  okuma_hatali: 'Okunamayan fatura var',
};

/** Width of one invoice in the strip of a form with several invoices. */
const TILE_W = 144;

export default function ExpenseDetailScreen() {
  const { colors } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const masraf = useMasraf(Number(id));
  // The spinner follows the user's own refresh, not the polling while invoices are read.
  const [refreshing, setRefreshing] = useState(false);
  const refresh = (): void => {
    setRefreshing(true);
    void masraf.refetch().finally(() => setRefreshing(false));
  };

  // A failed background refresh (asked again while invoices are read) keeps the form on screen; only a
  // first load that failed shows the error.
  if (masraf.data === undefined) {
    if (!masraf.isError) return <DetailSkeleton />;
    return (
      <View style={[styles.flex, { backgroundColor: colors.bg }]}>
        <ErrorState error={masraf.error} onRetry={() => void masraf.refetch()} />
      </View>
    );
  }
  return <Detail detail={masraf.data} refreshing={refreshing} onRefresh={refresh} />;
}

function Detail({ detail, refreshing, onRefresh }: { readonly detail: MasrafDetay; readonly refreshing: boolean; readonly onRefresh: () => void }) {
  const { colors } = useTheme();
  const motion = useMotion();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const changed = useMasrafChanged();
  const ozet = useOzet();
  // Field names for the missing fields and the receipt values; the keys show until they load.
  const defs = useAlanlar().data;
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [sheet, setSheet] = useState<'onayla' | 'reddet' | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  // The base currency (PARA_BIRIMI) comes from GET /api/ozet; TRY until it has loaded.
  const localCurrency = ozet.data?.paraBirimi ?? 'TRY';
  const base = localCurrency.toUpperCase();
  const tone = statusColors(colors, detail.durum);
  const izin = detail.izinler;

  // Background reading moves the form on by itself (an invoice read, the form sent by "okununca gönder"):
  // the lists, the summary and the notification badge follow when this screen's polling sees it.
  const progress = `${detail.durum}|${detail.bekleyenFaturalar.length}|${detail.faturalar.length}`;
  const lastProgress = useRef(progress);
  useEffect(() => {
    if (lastProgress.current === progress) return;
    lastProgress.current = progress;
    void changed(detail);
    // Only when the form moved on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress]);

  /** `explain` may show a failure its own way; it returns true when it did. `success` may word the new state. */
  const run = async (
    key: ActionKey,
    call: () => Promise<MasrafDetay>,
    success: string | ((next: MasrafDetay) => string),
    explain?: (err: unknown) => boolean,
  ): Promise<boolean> => {
    setBusy(key);
    try {
      const next = await call();
      await changed(next);
      haptics.success();
      toast(typeof success === 'string' ? success : success(next), 'success');
      return true;
    } catch (err) {
      haptics.error();
      if (explain?.(err) !== true) toast(errorMessage(err), 'danger');
      onRefresh();
      return false;
    } finally {
      setBusy(null);
    }
  };

  const simple = (key: ActionKey, action: MasrafIslemi, success: string): void => {
    void run(key, () => runMasrafAction(detail.id, action), success);
  };

  const confirm = (title: string, message: string, ok: string, destructive: boolean, onOk: () => void): void => {
    Alert.alert(title, message, [
      { text: 'Vazgeç', style: 'cancel' },
      { text: ok, style: destructive ? 'destructive' : 'default', onPress: onOk },
    ]);
  };

  const openSheet = (kind: 'onayla' | 'reddet'): void => {
    setNote('');
    setNoteError(null);
    setSheet(kind);
  };

  const submitSheet = async (): Promise<void> => {
    if (sheet === 'reddet' && note.trim().length < 3) {
      setNoteError('Ret gerekçesi en az 3 karakter olmalı.');
      haptics.error();
      return;
    }
    const ok =
      sheet === 'reddet'
        ? await run('reddet', () => rejectMasraf(detail.id, note), 'Masraf reddedildi.')
        : await run('onayla', () => approveMasraf(detail.id, note), 'Masraf onaylandı.');
    if (ok) setSheet(null);
  };

  // Invoice files the server still reads in the background, and those it could not read.
  const pending = detail.bekleyenFaturalar;
  const readingCount = pending.filter((b) => b.durum !== 'hata').length;
  const failedCount = pending.length - readingCount;
  // `izinler.gonder` stays true while files are pending; the server would refuse (409 okuma_suruyor /
  // okuma_hatali), so the button is off and says why.
  const sendBlock =
    !izin.gonder || pending.length === 0
      ? null
      : readingCount > 0
        ? detail.okununcaGonder
          ? 'Faturalar okununca masraf kendiliğinden onaya gönderilecek.'
          : `${readingCount > 1 ? 'Faturalar' : 'Fatura'} okunurken onaya gönderilemez; okuma bitince bildirim gelir.`
        : 'Okunamayan faturaları yeniden okutun ya da masraftan çıkarın; sonra onaya gönderebilirsiniz.';

  const actions: { key: ActionKey; title: string; icon: IconName; variant: ButtonVariant; onPress: () => void; blocked?: string }[] = [];
  if (izin.reddet) actions.push({ key: 'reddet', title: 'Reddet', icon: 'close-circle-outline', variant: 'dangerSoft', onPress: () => openSheet('reddet') });
  if (izin.onayla) actions.push({ key: 'onayla', title: 'Onayla', icon: 'checkmark-circle-outline', variant: 'success', onPress: () => openSheet('onayla') });
  const openEdit = (): void => router.push({ pathname: '/masraf/[id]/duzenle', params: { id: String(detail.id) } });
  // Sending with missing invoice information or without an amount is a sure rejection: the way forward
  // is to fill it in, so the main action leads to the edit screen.
  const incompleteInvoices = detail.faturalar.flatMap((f, i) => (f.eksikAlanlar.length > 0 ? [{ f, n: i + 1 }] : []));
  const firstIncomplete = incompleteInvoices[0];
  // Required form fields left empty (for now only the cost centre).
  const formMissing = detail.eksikAlanlar;
  const amountMissing = izin.gonder && detail.tutar === null;
  const fixFirst = izin.gonder && sendBlock === null && (firstIncomplete !== undefined || formMissing.length > 0 || amountMissing);
  if (izin.duzenle && !fixFirst) {
    actions.push({ key: 'duzenle', title: 'Düzenle', icon: 'create-outline', variant: 'outline', onPress: openEdit });
  }
  if (sendBlock !== null) {
    actions.push({ key: 'gonder', title: 'Onaya gönder', icon: 'paper-plane', variant: 'primary', onPress: () => undefined, blocked: sendBlock });
  } else if (fixFirst && firstIncomplete !== undefined) {
    actions.push({
      key: 'duzenle',
      title: 'Eksikleri tamamla',
      icon: 'create-outline',
      variant: 'primary',
      onPress: () => router.push({ pathname: '/masraf/[id]/duzenle', params: { id: String(detail.id), fatura: firstIncomplete.f.id } }),
    });
  } else if (fixFirst) {
    actions.push({
      key: 'duzenle',
      title: formMissing.length > 0 ? 'Eksikleri tamamla' : 'Tutarı gir',
      icon: 'create-outline',
      variant: 'primary',
      onPress: openEdit,
    });
  } else if (izin.gonder) {
    actions.push({
      key: 'gonder',
      title: 'Onaya gönder',
      icon: 'paper-plane',
      variant: 'primary',
      onPress: () =>
        void run('gonder', () => runMasrafAction(detail.id, 'gonder'), 'Masraf onaya gönderildi.', (err) => {
          // A missing amount, equivalent or invoice information or a duplicate is fixed on the edit
          // screen; offer to go there instead of a passing toast. Files still (or not) read are explained.
          if (!(err instanceof ApiError)) return false;
          if (FIXABLE.includes(err.kod)) {
            Alert.alert(
              err.kod === 'karsilik_eksik' ? `${base} karşılığı eksik` : (SEND_ERROR_TITLES[err.kod] ?? 'Gönderilemedi'),
              err.message,
              izin.duzenle
                ? [
                    { text: 'Vazgeç', style: 'cancel' },
                    { text: 'Düzenle', onPress: openEdit },
                  ]
                : [{ text: 'Tamam' }],
            );
            return true;
          }
          const title = SEND_ERROR_TITLES[err.kod];
          if (title === undefined) return false;
          Alert.alert(title, err.message, [{ text: 'Tamam' }]);
          return true;
        }),
    });
  }
  const reread = (): void => {
    void run('yenidenOku', () => runMasrafAction(detail.id, 'yeniden-oku'), 'Okunamayan faturalar yeniden okuma sırasına alındı.');
  };

  // The rest of the pending list replaces it; the file's reading result, if any, is not lost (it lands in
  // the user's invoices). With "okununca gönder" on, the server may send the form right away.
  const removePending = (item: BekleyenFatura): void => {
    confirm('Masraftan çıkar', `"${item.dosyaAdi}" bu masraftan çıkarılacak.`, 'Çıkar', true, () => {
      void run(
        'bekleyen',
        () => updateMasraf(detail.id, { bekleyenFaturalar: pending.filter((b) => b.dosyaOzeti !== item.dosyaOzeti).map((b) => b.dosyaOzeti) }),
        (next) =>
          next.durum === 'onayda'
            ? 'Masraf onaya gönderildi.'
            : detail.okununcaGonder && !next.okununcaGonder
              ? `Dosya masraftan çıkarıldı. ${autoSendFailure(next)}`
              : 'Dosya masraftan çıkarıldı.',
      );
    });
  };

  const setAutoSend = (value: boolean): void => {
    void run('okununcaGonder', () => updateMasraf(detail.id, { okununcaGonder: value }), (next) =>
      next.durum === 'onayda'
        ? 'Masraf onaya gönderildi.'
        : !value
          ? 'Okumalar bitince gönderme kapatıldı.'
          : next.okununcaGonder
            ? 'Faturalar okununca masraf onaya gönderilecek.'
            : autoSendFailure(next),
    );
  };
  const showAutoSend = detail.okununcaGonder || (izin.duzenle && pending.length > 0);

  if (izin.geriCek) {
    actions.push({
      key: 'geriCek',
      title: 'Geri çek',
      icon: 'arrow-undo-outline',
      variant: 'outline',
      onPress: () =>
        confirm('Geri çek', 'Masraf onaydan çekilip taslağa dönecek. Bekleyen adımlar iptal edilir.', 'Geri çek', false, () =>
          simple('geriCek', 'geri-cek', 'Masraf geri çekildi.'),
        ),
    });
  }
  if (izin.odendi) {
    actions.push({
      key: 'odendi',
      title: 'Ödendi olarak işaretle',
      icon: 'wallet-outline',
      variant: 'primary',
      onPress: () => confirm('Ödendi', 'Bu masraf ödendi olarak işaretlenecek.', 'İşaretle', false, () => simple('odendi', 'odendi', 'Masraf ödendi olarak işaretlendi.')),
    });
  }

  const showLocal = detail.paraBirimi.toUpperCase() !== base;
  const faturalar = detail.faturalar;
  const fatura = faturalar.length === 1 ? (faturalar[0] ?? null) : null;
  const canZoom = fatura !== null && canOpen(fatura);
  // Which invoices make up tutarFarki.fatura (contract rule 6); only used to word the notices. The
  // server's karsilikGerekli says which invoices need an equivalent.
  const counted = invoiceTotalInForm(detail.paraBirimi, base, detail.kur, faturalar);
  const missingCount = faturalar.filter((f) => f.karsilikGerekli && f.yerelKarsilik === null).length;
  // On a foreign-currency form, base-currency invoices and equivalents count through the form rate.
  const converted =
    showLocal &&
    faturalar.some((f) => (f.karsilikGerekli ? f.yerelKarsilik !== null : f.paraBirimi === base && f.genelToplam !== null && f.genelToplam > 0));
  const mismatch = detail.tutarFarki;
  // Why a returned form came back: the rejecting step's note, shown on top so the sender sees what to fix.
  const rejection = detail.durum === 'reddedildi' ? (detail.onaylar.find((o) => o.durum === 'reddedildi') ?? null) : null;

  return (
    <View style={[styles.flex, { backgroundColor: colors.bg }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />}
      >
        <Animated.View entering={motion.enter(0)} style={[styles.hero, { backgroundColor: tone.bg }]}>
          <View style={styles.heroTop}>
            <StatusBadge durum={detail.durum} size="md" />
            <Text variant="caption" tone="muted">
              #{detail.id}
              {detail.tur > 1 ? ` · ${detail.tur}. tur` : ''}
            </Text>
          </View>
          <Text variant="title" accessibilityRole="header">
            {detail.baslik}
          </Text>
          {detail.tutar !== null ? (
            <Text
              variant="amountLarge"
              style={amountLargeFor(formatMoney(detail.tutar, detail.paraBirimi))}
              accessibilityLabel={`Tutar ${formatMoney(detail.tutar, detail.paraBirimi)}`}
            >
              {formatMoney(detail.tutar, detail.paraBirimi)}
            </Text>
          ) : (
            // A draft saved without an amount: the server fills it once the invoices are read.
            <View style={styles.next}>
              <Ionicons name={readingCount > 0 ? 'hourglass-outline' : 'remove-circle-outline'} size={18} color={colors.textMuted} />
              <Text variant="heading" tone="muted">
                {readingCount > 0 ? 'Tutar okununca dolacak' : 'Tutar girilmedi'}
              </Text>
            </View>
          )}
          {showLocal && detail.yerelTutar !== null ? (
            <Text variant="small" tone="muted">
              ≈ {formatMoney(detail.yerelTutar, localCurrency)}
              {detail.kur !== null ? ` · kur ${formatNumber(detail.kur, 4)}` : ''}
            </Text>
          ) : null}
          {detail.durum === 'onayda' && detail.siradakiOnayci !== null ? (
            <View style={styles.next}>
              <Ionicons name="hourglass-outline" size={16} color={tone.fg} />
              <Text variant="label" color={tone.fg}>
                {detail.siradakiOnayci.adSoyad} onayında
              </Text>
            </View>
          ) : null}
        </Animated.View>

        {rejection !== null ? (
          <Animated.View entering={motion.enter(1)}>
            <Banner
              tone="danger"
              icon="close-circle-outline"
              message={
                rejection.aciklama !== null && rejection.aciklama !== ''
                  ? `${rejection.onayci.adSoyad} reddetti: “${rejection.aciklama}”`
                  : `${rejection.onayci.adSoyad} reddetti.`
              }
            />
          </Animated.View>
        ) : null}

        {missingCount > 0 && izin.gonder ? (
          <Animated.View entering={motion.enter(1)}>
            <Banner
              tone="warning"
              icon="cash-outline"
              message={`${missingCount === 1 ? 'Bir faturanın' : `${missingCount} faturanın`} ${base} karşılığı girilmedi. ${
                izin.duzenle ? `Göndermeden önce düzenleyip ${base} karşılığını girin.` : `Onaya göndermek için ${base} karşılığı gerekir.`
              }`}
            />
          </Animated.View>
        ) : null}

        {(incompleteInvoices.length > 0 || formMissing.length > 0) && izin.gonder ? (
          <Animated.View entering={motion.enter(1)}>
            <Banner
              tone="warning"
              icon="document-text-outline"
              message={[
                'Onaya göndermeden önce eksik bilgileri tamamlayın',
                ...formMissing.map((k) => `${fieldName(defs, k)} seçilmeli.`),
                ...incompleteInvoices.map(({ f, n }) => `${n}. fatura: ${missingNames(defs, f.eksikAlanlar)}`),
              ].join('\n')}
            />
          </Animated.View>
        ) : null}

        {mismatch !== null ? (
          <Animated.View entering={motion.enter(1)}>
            <Banner
              tone="warning"
              icon="alert-circle-outline"
              message={[
                // Both amounts are in the form's own currency; the approval amount is in the local one.
                `Beyan edilen tutar (${formatMoney(mismatch.beyan, detail.paraBirimi)}) ${
                  (counted?.count ?? 0) > 1 ? 'faturaların toplamından' : 'fatura toplamından'
                } (${formatMoney(mismatch.fatura, detail.paraBirimi)}) farklı.`,
                converted ? `${base} tutarlar formun kuruyla ${detail.paraBirimi} cinsine çevrildi.` : null,
                missingCount > 0 ? `${base} karşılığı girilmeyen ${missingCount} fatura bu toplama girmez.` : null,
                // Not detail.onayTutari: it is null before the first submission and stays at the last
                // submission's value while a returned form is edited. The rule (contract rule 6) is the larger one.
                `Onay tutarı ikisinden büyük olan ${formatMoney(Math.max(mismatch.fatura, mismatch.beyan), detail.paraBirimi)} üzerinden belirlenir.`,
              ]
                .filter((part) => part !== null)
                .join(' ')}
            />
          </Animated.View>
        ) : null}

        <Animated.View entering={motion.enter(2)}>
          <Card style={styles.facts}>
            <Fact label="Kategori" icon={<CategoryIcon simge={detail.kategori.simge} size={32} />} value={detail.kategori.ad} />
            {detail.masrafMerkezi !== null ? (
              <Fact
                label={fieldName(defs, 'masrafMerkezi')}
                icon={<FactIcon name="layers-outline" />}
                value={`${detail.masrafMerkezi.gosterim}${detail.masrafMerkezi.aktif ? '' : ' (pasif)'}`}
              />
            ) : null}
            {detail.organizasyon !== null ? (
              <Fact
                label="Organizasyon"
                icon={<FactIcon name="business-outline" />}
                value={`${displayName(detail.organizasyon.kod, detail.organizasyon.ad)}${detail.organizasyon.aktif ? '' : ' (pasif)'}`}
              />
            ) : null}
            <Fact label="Masraf tarihi" icon={<FactIcon name="calendar-outline" />} value={formatDate(detail.masrafTarihi)} />
            {detail.satici !== null && detail.satici !== '' ? <Fact label="Satıcı" icon={<FactIcon name="storefront-outline" />} value={detail.satici} /> : null}
            <Fact label="Oluşturan" icon={<FactIcon name="person-outline" />} value={detail.olusturan.adSoyad} />
            {detail.gonderim !== null ? <Fact label="Gönderim" icon={<FactIcon name="paper-plane-outline" />} value={formatDateTime(detail.gonderim)} /> : null}
            {detail.odeme !== null ? <Fact label="Ödeme" icon={<FactIcon name="wallet-outline" />} value={formatDateTime(detail.odeme)} /> : null}
          </Card>
        </Animated.View>

        {detail.aciklama !== null && detail.aciklama !== '' ? (
          <Animated.View entering={motion.enter(3)} style={styles.section}>
            <SectionTitle>Açıklama</SectionTitle>
            <Card>
              <Text>{detail.aciklama}</Text>
            </Card>
          </Animated.View>
        ) : null}

        {pending.length > 0 ? (
          <Animated.View entering={motion.enter(3)} style={styles.section}>
            <SectionTitle>
              {readingCount === 0
                ? pending.length > 1
                  ? `Okunamayan faturalar (${pending.length})`
                  : 'Okunamayan fatura'
                : pending.length > 1
                  ? `Okunmayı bekleyen faturalar (${pending.length})`
                  : 'Okunmayı bekleyen fatura'}
            </SectionTitle>
            <PendingInvoices
              items={pending}
              canEdit={izin.duzenle}
              rereading={busy === 'yenidenOku'}
              disabled={busy !== null}
              onReread={reread}
              onRemove={removePending}
              defs={defs}
            />
            {failedCount > 0 && readingCount > 0 ? (
              <Text variant="caption" tone="muted" style={styles.sectionTitle}>
                {failedCount} fatura okunamadı; diğerleri okunuyor.
              </Text>
            ) : null}
          </Animated.View>
        ) : null}

        {showAutoSend ? (
          <Animated.View entering={motion.enter(3)}>
            <Card style={styles.autoSend}>
              <View style={[styles.factIcon, { backgroundColor: colors.primarySoft }]}>
                <Ionicons name="paper-plane-outline" size={17} color={colors.primary} />
              </View>
              <View style={styles.flex}>
                <Text variant="bodyStrong">Okumalar bitince onaya gönder</Text>
                <Text variant="small" tone="muted">
                  {detail.okununcaGonder
                    ? 'Faturaların hepsi okununca masraf kendiliğinden onaya gönderilecek; sonucu bildirimle öğrenirsiniz.'
                    : 'Açarsanız faturaların hepsi okununca masraf kendiliğinden onaya gönderilir.'}
                </Text>
              </View>
              {izin.duzenle ? (
                <Switch
                  // Shows the requested value while the change is saved.
                  value={busy === 'okununcaGonder' ? !detail.okununcaGonder : detail.okununcaGonder}
                  disabled={busy !== null}
                  onValueChange={(value) => {
                    haptics.tap();
                    setAutoSend(value);
                  }}
                  trackColor={{ false: colors.border, true: colors.primary }}
                  accessibilityLabel="Okumalar bitince onaya gönder"
                  accessibilityRole="switch"
                />
              ) : null}
            </Card>
          </Animated.View>
        ) : null}

        <Animated.View entering={motion.enter(4)} style={styles.section}>
          <SectionTitle>{faturalar.length > 1 ? `Faturalar (${faturalar.length})` : 'Fatura'}</SectionTitle>
          {faturalar.length > 1 ? (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.stripBleed}
                contentContainerStyle={styles.strip}
                accessibilityLabel="Faturalar"
              >
                {faturalar.map((f, i) => (
                  <InvoiceTile key={f.id} fatura={f} index={i} count={faturalar.length} currency={detail.paraBirimi} base={base} />
                ))}
              </ScrollView>
              {counted !== null ? (
                <Text variant="small" tone="muted" style={styles.sectionTitle}>
                  {counted.count === faturalar.length ? 'Faturaların toplamı' : `${counted.count} faturanın toplamı`}:{' '}
                  {formatMoney(counted.total, detail.paraBirimi)}
                </Text>
              ) : null}
            </>
          ) : fatura === null ? (
            <Card style={styles.invoiceRow}>
              <View style={[styles.factIcon, { backgroundColor: colors.surfaceAlt }]}>
                <Ionicons name="document-outline" size={18} color={colors.textMuted} />
              </View>
              <Text tone="muted" style={styles.flex}>
                {pending.length > 0 ? 'Okunan faturalar burada görünecek.' : 'Bu masrafa fatura eklenmemiş.'}
              </Text>
            </Card>
          ) : (
            <PressableScale
              disabled={!canZoom}
              accessibilityRole={canZoom ? 'imagebutton' : undefined}
              accessibilityLabel={canZoom ? 'Fatura görselini tam ekran aç' : undefined}
              onPress={() => router.push({ pathname: '/fatura/[id]', params: { id: fatura.id } })}
              scaleTo={0.98}
              style={[styles.invoiceCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
            >
              <InvoiceThumb source={{ kind: 'remote', faturaId: fatura.id, mime: fatura.mime, hasFile: fatura.dosyaVar }} width={84} height={108} />
              <View style={styles.flex}>
                <Text variant="bodyStrong" numberOfLines={2}>
                  {isPdf(fatura.mime) ? 'PDF fatura' : (fatura.saticiUnvan ?? 'Fatura')}
                </Text>
                {fatura.dosyaAdi !== null ? (
                  <Text variant="caption" tone="faint" numberOfLines={1}>
                    {fatura.dosyaAdi}
                  </Text>
                ) : null}
                <Text variant="small" tone="muted">
                  {[fatura.faturaNo !== null ? `No ${fatura.faturaNo}` : null, fatura.faturaTarihi !== null ? formatDate(fatura.faturaTarihi) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                {fatura.genelToplam !== null ? (
                  <Text variant="amount">{formatMoney(fatura.genelToplam, fatura.paraBirimi ?? detail.paraBirimi)}</Text>
                ) : null}
                {fatura.karsilikGerekli ? (
                  fatura.yerelKarsilik !== null ? (
                    <Text variant="small" tone="muted" style={styles.tabular}>
                      {base} karşılığı: {formatMoney(fatura.yerelKarsilik, base)}
                    </Text>
                  ) : (
                    <Text variant="caption" tone="warning">
                      {base} karşılığı girilmedi; onay tutarına girmez.
                    </Text>
                  )
                ) : null}
                {!fatura.dosyaVar ? (
                  <Text variant="caption" tone="warning">
                    Orijinal dosya bulunamadı.
                  </Text>
                ) : canZoom ? (
                  <View style={styles.zoomHint}>
                    <Ionicons name="expand-outline" size={14} color={colors.primary} />
                    <Text variant="caption" tone="primary">
                      Büyütmek için dokunun
                    </Text>
                  </View>
                ) : null}
              </View>
            </PressableScale>
          )}
        </Animated.View>

        {faturalar.length > 0 ? (
          <View style={styles.section}>
            <SectionTitle>{faturalar.length > 1 ? 'Fatura bilgileri' : 'Fatura detayı'}</SectionTitle>
            {faturalar.map((f, i) => (
              <InvoiceInfoCard key={f.id} fatura={f} index={i} count={faturalar.length} currency={detail.paraBirimi} defs={defs} />
            ))}
          </View>
        ) : null}

        {detail.onaylar.length > 0 ? (
          <View style={styles.section}>
            <SectionTitle>Onay adımları</SectionTitle>
            <Card>
              <ApprovalTimeline steps={detail.onaylar} currency={localCurrency} />
            </Card>
          </View>
        ) : null}

        {detail.gecmis.length > 0 ? (
          <View style={styles.section}>
            <SectionTitle>Geçmiş</SectionTitle>
            <Card>
              <HistoryList items={detail.gecmis} />
            </Card>
          </View>
        ) : null}

        {izin.iptal ? (
          <Button
            title="Masrafı iptal et"
            icon="trash-outline"
            variant="ghost"
            loading={busy === 'iptal'}
            onPress={() =>
              confirm('Masrafı iptal et', `İptal edilen masraf yeniden gönderilemez.${releaseNote(faturalar.length)}`, 'İptal et', true, () =>
                simple('iptal', 'iptal', 'Masraf iptal edildi.'),
              )
            }
          />
        ) : null}
      </ScrollView>

      {actions.length > 0 ? (
        <Animated.View
          entering={motion.enter(1)}
          style={[styles.actions, { backgroundColor: colors.bg, borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, spacing.md) }]}
        >
          {sendBlock !== null ? (
            <Text variant="caption" tone="muted" align="center" accessibilityLiveRegion="polite">
              {sendBlock}
            </Text>
          ) : null}
          {chunk(actions, 2).map((row) => (
            <View key={row.map((a) => a.key).join('-')} style={styles.actionRow}>
              {row.map((a) => (
                <Button
                  key={a.key}
                  title={a.title}
                  icon={a.icon}
                  variant={a.variant}
                  // Beside a main action, an outline one (Düzenle) takes only its own width, so the main
                  // label fits on one line on a 360 pt screen.
                  flex={!(row.length > 1 && a.variant === 'outline')}
                  loading={busy === a.key}
                  disabled={a.blocked !== undefined || (busy !== null && busy !== a.key)}
                  accessibilityHint={a.blocked}
                  onPress={a.onPress}
                />
              ))}
            </View>
          ))}
        </Animated.View>
      ) : null}

      <Sheet
        visible={sheet !== null}
        onClose={() => setSheet(null)}
        title={sheet === 'reddet' ? 'Masrafı reddet' : 'Masrafı onayla'}
        subtitle={detail.tutar !== null ? `${detail.baslik} · ${formatMoney(detail.tutar, detail.paraBirimi)}` : detail.baslik}
      >
        <TextField
          label={sheet === 'reddet' ? 'Ret gerekçesi' : 'Not (isteğe bağlı)'}
          value={note}
          onChangeText={(t) => {
            setNote(t);
            if (noteError !== null) setNoteError(null);
          }}
          placeholder={sheet === 'reddet' ? 'Çalışanın görebileceği bir açıklama yazın' : 'Örn. Uygundur'}
          multiline
          autoFocus
          error={noteError}
          hint={sheet === 'reddet' ? 'Zorunlu, en az 3 karakter.' : undefined}
        />
        <Button
          title={sheet === 'reddet' ? 'Reddet' : 'Onayla'}
          icon={sheet === 'reddet' ? 'close-circle' : 'checkmark-circle'}
          variant={sheet === 'reddet' ? 'danger' : 'success'}
          loading={busy === 'reddet' || busy === 'onayla'}
          onPress={() => void submitSheet()}
        />
      </Sheet>
    </View>
  );
}

/** Only photos with a stored file open in the full-screen viewer (there is no PDF viewer). */
const canOpen = (f: MasrafFatura): boolean => f.dosyaVar && !isPdf(f.mime);

/** "fatura no, etiket": the missing fields' names in a sentence. */
const missingNames = (defs: FieldDefs | undefined, keys: readonly string[]): string =>
  keys.map((k) => fieldName(defs, k).toLocaleLowerCase('tr-TR')).join(', ');

function releaseNote(count: number): string {
  if (count === 0) return '';
  return count === 1 ? ' Bağlı fatura başka bir masrafta kullanılabilir hale gelir.' : ' Bağlı faturalar başka masraflarda kullanılabilir hale gelir.';
}

/** One invoice in the horizontal strip of a form with several invoices. */
function InvoiceTile({
  fatura,
  index,
  count,
  currency,
  base,
}: {
  readonly fatura: MasrafFatura;
  readonly index: number;
  readonly count: number;
  /** The form's currency, for a total whose currency was not read. */
  readonly currency: string;
  /** The base currency an equivalent is in. */
  readonly base: string;
}) {
  const { colors } = useTheme();
  const motion = useMotion();
  const zoom = canOpen(fatura);
  const heading = fatura.saticiUnvan ?? (isPdf(fatura.mime) ? 'PDF fatura' : (fatura.dosyaAdi ?? 'Fatura'));
  const total = fatura.genelToplam !== null ? formatMoney(fatura.genelToplam, fatura.paraBirimi ?? currency) : null;
  const date = fatura.faturaTarihi !== null ? formatDate(fatura.faturaTarihi) : null;
  const equivalent =
    fatura.karsilikGerekli && fatura.yerelKarsilik !== null ? `${base} karşılığı: ${formatMoney(fatura.yerelKarsilik, base)}` : null;
  const missing = fatura.karsilikGerekli && fatura.yerelKarsilik === null ? `${base} karşılığı girilmedi` : null;
  const note = !fatura.dosyaVar ? 'Dosya bulunamadı' : null;
  const label = [
    `Fatura ${index + 1} / ${count}`,
    heading,
    total,
    date,
    equivalent,
    missing !== null ? `${missing}, toplama girmez` : null,
    !fatura.dosyaVar ? 'orijinal dosya bulunamadı' : null,
  ]
    .filter((part) => part !== null)
    .join(', ');
  return (
    <Animated.View entering={motion.enter(index)}>
      <PressableScale
        disabled={!zoom}
        accessibilityRole={zoom ? 'imagebutton' : undefined}
        accessibilityLabel={label}
        accessibilityHint={zoom ? 'Fatura görselini tam ekran açar' : undefined}
        onPress={() => router.push({ pathname: '/fatura/[id]', params: { id: fatura.id } })}
        scaleTo={0.96}
        style={[styles.tile, { backgroundColor: colors.surface, borderColor: colors.border }]}
      >
        <View>
          <InvoiceThumb
            source={{ kind: 'remote', faturaId: fatura.id, mime: fatura.mime, hasFile: fatura.dosyaVar }}
            width={TILE_W - spacing.sm * 2}
            height={132}
          />
          {zoom ? (
            <View style={[styles.tileZoom, { backgroundColor: colors.surface }]}>
              <Ionicons name="expand-outline" size={14} color={colors.primary} />
            </View>
          ) : null}
        </View>
        <Text variant="label" numberOfLines={1} style={styles.tileText}>
          {heading}
        </Text>
        {total !== null ? (
          <Text variant="bodyStrong" numberOfLines={1} style={styles.tabular}>
            {total}
          </Text>
        ) : null}
        {date !== null ? (
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {date}
          </Text>
        ) : null}
        {equivalent !== null ? (
          <Text variant="caption" tone="muted" numberOfLines={2} style={styles.tabular}>
            {equivalent}
          </Text>
        ) : null}
        {missing !== null ? (
          <Text variant="caption" tone="warning" numberOfLines={2}>
            {missing}
          </Text>
        ) : null}
        {note !== null ? (
          <Text variant="caption" tone="warning" numberOfLines={1}>
            {note}
          </Text>
        ) : null}
      </PressableScale>
    </Animated.View>
  );
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function SectionTitle({ children }: { readonly children: ReactNode }) {
  return (
    <Text variant="heading" accessibilityRole="header" style={styles.sectionTitle}>
      {children}
    </Text>
  );
}

function FactIcon({ name }: { readonly name: IconName }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.factIcon, { backgroundColor: colors.surfaceAlt }]}>
      <Ionicons name={name} size={17} color={colors.textMuted} />
    </View>
  );
}

function Fact({ label, value, icon }: { readonly label: string; readonly value: string; readonly icon: ReactNode }) {
  return (
    <View style={styles.fact} accessible accessibilityLabel={`${label}: ${value}`}>
      {icon}
      <View style={styles.flex}>
        <Text variant="caption" tone="muted">
          {label}
        </Text>
        <Text variant="bodyStrong">{value}</Text>
      </View>
    </View>
  );
}

function DetailSkeleton() {
  const { colors } = useTheme();
  return (
    <View style={[styles.flex, styles.content, { backgroundColor: colors.bg }]}>
      <Skeleton height={170} style={{ borderRadius: radius.xxl }} />
      <Skeleton height={190} style={{ borderRadius: radius.xl }} />
      <Skeleton height={120} style={{ borderRadius: radius.xl }} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.xl, gap: spacing.xl, paddingBottom: spacing.huge },
  hero: { borderRadius: radius.xxl, padding: spacing.xl, gap: spacing.sm },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  next: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  facts: { gap: spacing.lg },
  autoSend: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  fact: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  factIcon: { width: 32, height: 32, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  section: { gap: spacing.sm },
  sectionTitle: { marginLeft: spacing.xs },
  invoiceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  invoiceCard: { flexDirection: 'row', gap: spacing.lg, padding: spacing.lg, borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  zoomHint: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.xs },
  // The strip runs to the screen edges while its first and last tiles line up with the content.
  stripBleed: { marginHorizontal: -spacing.xl },
  strip: { paddingHorizontal: spacing.xl, gap: spacing.md },
  // flexGrow: tiles in the strip share the tallest one's height (an equivalent line makes a tile taller).
  tile: { width: TILE_W, flexGrow: 1, padding: spacing.sm, gap: 2, borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth },
  tileText: { marginTop: spacing.xs },
  tileZoom: {
    position: 'absolute',
    right: spacing.xs,
    bottom: spacing.xs,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabular: { fontVariant: ['tabular-nums'] },
  actions: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
  actionRow: { flexDirection: 'row', gap: spacing.sm },
});
