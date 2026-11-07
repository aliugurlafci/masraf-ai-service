import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, errorMessage } from '@/api/client';
import { approveMasraf, rejectMasraf, runMasrafAction, type MasrafIslemi } from '@/api/endpoints';
import { useMasraf, useMasrafChanged, useOzet } from '@/api/queries';
import type { MasrafDetay, MasrafFatura } from '@/api/types';
import { CategoryIcon } from '@/components/expense/CategoryIcon';
import { InvoiceInfoCard } from '@/components/expense/InvoiceInfoCard';
import { InvoiceThumb } from '@/components/expense/InvoiceThumb';
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
import { invoiceTotalInForm } from '@/lib/invoices';
import { fieldLabel } from '@/lib/invoiceEdit';
import { isPdf } from '@/lib/pickers';
import { amountLargeFor, radius, spacing, statusColors, useTheme } from '@/theme';

type ActionKey = 'duzenle' | 'gonder' | 'geriCek' | 'iptal' | 'onayla' | 'reddet' | 'odendi';

/** Send errors the sender fixes by editing the form. */
const FIXABLE: readonly string[] = ['karsilik_eksik', 'fatura_eksik', 'fatura_mukerrer'];

/** Width of one invoice in the strip of a form with several invoices. */
const TILE_W = 144;

export default function ExpenseDetailScreen() {
  const { colors } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const masraf = useMasraf(Number(id));

  if (masraf.isPending) return <DetailSkeleton />;
  if (masraf.isError) {
    return (
      <View style={[styles.flex, { backgroundColor: colors.bg }]}>
        <ErrorState error={masraf.error} onRetry={() => void masraf.refetch()} />
      </View>
    );
  }
  return <Detail detail={masraf.data} refreshing={masraf.isRefetching} onRefresh={() => void masraf.refetch()} />;
}

function Detail({ detail, refreshing, onRefresh }: { readonly detail: MasrafDetay; readonly refreshing: boolean; readonly onRefresh: () => void }) {
  const { colors } = useTheme();
  const motion = useMotion();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const changed = useMasrafChanged();
  const ozet = useOzet();
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [sheet, setSheet] = useState<'onayla' | 'reddet' | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  // The base currency (PARA_BIRIMI) comes from GET /api/ozet; TRY until it has loaded.
  const localCurrency = ozet.data?.paraBirimi ?? 'TRY';
  const base = localCurrency.toUpperCase();
  const tone = statusColors(colors, detail.durum);
  const izin = detail.izinler;

  /** `explain` may show a failure its own way; it returns true when it did. */
  const run = async (key: ActionKey, call: () => Promise<MasrafDetay>, success: string, explain?: (err: unknown) => boolean): Promise<boolean> => {
    setBusy(key);
    try {
      const next = await call();
      await changed(next);
      haptics.success();
      toast(success, 'success');
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

  const actions: { key: ActionKey; title: string; icon: IconName; variant: ButtonVariant; onPress: () => void }[] = [];
  if (izin.reddet) actions.push({ key: 'reddet', title: 'Reddet', icon: 'close-circle-outline', variant: 'dangerSoft', onPress: () => openSheet('reddet') });
  if (izin.onayla) actions.push({ key: 'onayla', title: 'Onayla', icon: 'checkmark-circle-outline', variant: 'success', onPress: () => openSheet('onayla') });
  const openEdit = (): void => router.push({ pathname: '/masraf/[id]/duzenle', params: { id: String(detail.id) } });
  const hasIncomplete = izin.gonder && detail.faturalar.some((f) => f.eksikAlanlar.length > 0);
  if (izin.duzenle && !hasIncomplete) {
    actions.push({ key: 'duzenle', title: 'Düzenle', icon: 'create-outline', variant: 'outline', onPress: openEdit });
  }
  // Sending with missing invoice information is a sure rejection: the way forward is to fill it in.
  const incompleteInvoices = detail.faturalar.flatMap((f, i) => (f.eksikAlanlar.length > 0 ? [{ f, n: i + 1 }] : []));
  const firstIncomplete = incompleteInvoices[0];
  if (izin.gonder && firstIncomplete !== undefined) {
    actions.push({
      key: 'duzenle',
      title: 'Eksikleri tamamla',
      icon: 'create-outline',
      variant: 'primary',
      onPress: () => router.push({ pathname: '/masraf/[id]/duzenle', params: { id: String(detail.id), fatura: firstIncomplete.f.id } }),
    });
  } else if (izin.gonder) {
    actions.push({
      key: 'gonder',
      title: 'Onaya gönder',
      icon: 'paper-plane',
      variant: 'primary',
      onPress: () =>
        void run('gonder', () => runMasrafAction(detail.id, 'gonder'), 'Masraf onaya gönderildi.', (err) => {
          // A missing equivalent, missing invoice information or a duplicate is fixed on the edit screen;
          // offer to go there instead of a passing toast.
          if (!(err instanceof ApiError) || !FIXABLE.includes(err.kod)) return false;
          Alert.alert(
            err.kod === 'karsilik_eksik' ? `${base} karşılığı eksik` : err.kod === 'fatura_eksik' ? 'Fatura bilgisi eksik' : 'Mükerrer fatura',
            err.message,
            izin.duzenle
              ? [
                  { text: 'Vazgeç', style: 'cancel' },
                  { text: 'Düzenle', onPress: openEdit },
                ]
              : [{ text: 'Tamam' }],
          );
          return true;
        }),
    });
  }
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
          <Text
            variant="amountLarge"
            style={amountLargeFor(formatMoney(detail.tutar, detail.paraBirimi))}
            accessibilityLabel={`Tutar ${formatMoney(detail.tutar, detail.paraBirimi)}`}
          >
            {formatMoney(detail.tutar, detail.paraBirimi)}
          </Text>
          {showLocal ? (
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

        {incompleteInvoices.length > 0 && izin.gonder ? (
          <Animated.View entering={motion.enter(1)}>
            <Banner
              tone="warning"
              icon="document-text-outline"
              message={[
                'Onaya göndermeden önce eksik fatura bilgilerini tamamlayın',
                ...incompleteInvoices.map(({ f, n }) => `${n}. fatura: ${f.eksikAlanlar.map((k) => fieldLabel(k).toLowerCase()).join(', ')}`),
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
                Bu masrafa fatura eklenmemiş.
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
              <InvoiceInfoCard key={f.id} fatura={f} index={i} count={faturalar.length} currency={detail.paraBirimi} />
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
                  disabled={busy !== null && busy !== a.key}
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
        subtitle={`${detail.baslik} · ${formatMoney(detail.tutar, detail.paraBirimi)}`}
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
