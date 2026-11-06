import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { errorMessage } from '@/api/client';
import { approveMasraf, rejectMasraf, runMasrafAction, type MasrafIslemi } from '@/api/endpoints';
import { useMasraf, useMasrafChanged, useOzet } from '@/api/queries';
import type { MasrafDetay } from '@/api/types';
import { CategoryIcon } from '@/components/expense/CategoryIcon';
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
import { isPdf } from '@/lib/pickers';
import { radius, spacing, statusColors, useTheme } from '@/theme';

type ActionKey = 'duzenle' | 'gonder' | 'geriCek' | 'iptal' | 'onayla' | 'reddet' | 'odendi';

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

  const localCurrency = ozet.data?.paraBirimi ?? 'TRY';
  const tone = statusColors(colors, detail.durum);
  const izin = detail.izinler;

  const run = async (key: ActionKey, call: () => Promise<MasrafDetay>, success: string): Promise<boolean> => {
    setBusy(key);
    try {
      const next = await call();
      await changed(next);
      haptics.success();
      toast(success, 'success');
      return true;
    } catch (err) {
      haptics.error();
      toast(errorMessage(err), 'danger');
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
  if (izin.duzenle) {
    actions.push({
      key: 'duzenle',
      title: 'Düzenle',
      icon: 'create-outline',
      variant: 'outline',
      onPress: () => router.push({ pathname: '/masraf/[id]/duzenle', params: { id: String(detail.id) } }),
    });
  }
  if (izin.gonder) {
    actions.push({ key: 'gonder', title: 'Onaya gönder', icon: 'paper-plane', variant: 'primary', onPress: () => simple('gonder', 'gonder', 'Masraf onaya gönderildi.') });
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

  const showLocal = detail.paraBirimi.toUpperCase() !== localCurrency.toUpperCase();
  const fatura = detail.fatura;
  const canZoom = fatura !== null && fatura.dosyaVar && !isPdf(fatura.mime);

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
          <Text variant="amountLarge" accessibilityLabel={`Tutar ${formatMoney(detail.tutar, detail.paraBirimi)}`}>
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

        {detail.tutarFarki !== null ? (
          <Animated.View entering={motion.enter(1)}>
            <Banner
              tone="warning"
              icon="alert-circle-outline"
              message={`Beyan edilen tutar (${formatMoney(detail.tutarFarki.beyan, localCurrency)}) fatura toplamından (${formatMoney(
                detail.tutarFarki.fatura,
                localCurrency,
              )}) farklı. Onay tutarı: ${formatMoney(detail.onayTutari, localCurrency)}.`}
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
          <SectionTitle>Fatura</SectionTitle>
          {fatura === null ? (
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
              confirm('Masrafı iptal et', 'İptal edilen masraf yeniden gönderilemez. Bağlı fatura başka bir masrafta kullanılabilir hale gelir.', 'İptal et', true, () =>
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
                  flex
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
  actions: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
  actionRow: { flexDirection: 'row', gap: spacing.sm },
});
