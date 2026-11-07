import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useBen, useOzet } from '@/api/queries';
import type { MasrafDurum, Ozet } from '@/api/types';
import { useAuth } from '@/auth/AuthProvider';
import { ExpenseRow } from '@/components/expense/ExpenseRow';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import type { IconName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PressableScale } from '@/components/ui/PressableScale';
import { Skeleton, ListSkeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/StateViews';
import { Text } from '@/components/ui/Text';
import { useMotion } from '@/hooks/useMotion';
import { firstName, formatMoney, initials, moneyAffixes, monthTitle } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import { STATUS_LABELS } from '@/lib/status';
import { amountLargeFor, radius, spacing, statusColors, typography, useTheme } from '@/theme';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return 'İyi geceler';
  if (hour < 12) return 'Günaydın';
  if (hour < 18) return 'İyi günler';
  return 'İyi akşamlar';
}

const COUNTERS: readonly MasrafDurum[] = ['taslak', 'onayda', 'onaylandi', 'reddedildi', 'odendi'];

const openList = (durum?: MasrafDurum): void => {
  router.navigate(durum === undefined ? '/masraflar' : { pathname: '/masraflar', params: { durum } });
};
const openExpense = (id: number): void => router.push({ pathname: '/masraf/[id]', params: { id: String(id) } });

export default function HomeScreen() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const ozet = useOzet();
  const ben = useBen();
  const unread = ben.data?.okunmamisBildirim ?? 0;
  const name = user?.adSoyad ?? '';

  return (
    <SafeAreaView edges={['top']} style={[styles.flex, { backgroundColor: colors.bg }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={ozet.isRefetching} onRefresh={() => void ozet.refetch()} tintColor={colors.primary} colors={[colors.primary]} />
        }
      >
        <View style={styles.header}>
          <View style={styles.flex}>
            <Text variant="label" tone="muted">
              {greeting()},
            </Text>
            <Text variant="title" accessibilityRole="header" numberOfLines={1}>
              {firstName(name)}
            </Text>
          </View>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={unread > 0 ? `Bildirimler, ${unread} okunmamış` : 'Bildirimler'}
            onPress={() => {
              haptics.tap();
              router.push('/bildirimler');
            }}
            style={[styles.avatar, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth }]}
          >
            <Ionicons name={unread > 0 ? 'notifications' : 'notifications-outline'} size={22} color={colors.primary} />
            {unread > 0 ? (
              <View style={[styles.badge, { backgroundColor: colors.danger }]}>
                <Text variant="caption" color={colors.onAccent} style={styles.badgeText}>
                  {unread > 99 ? '99+' : unread}
                </Text>
              </View>
            ) : null}
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Profil"
            onPress={() => router.navigate('/profil')}
            style={[styles.avatar, { backgroundColor: colors.primarySoft }]}
          >
            <Text variant="label" tone="primary">
              {initials(name)}
            </Text>
          </PressableScale>
        </View>

        {ozet.isPending ? (
          <HomeSkeleton />
        ) : ozet.isError ? (
          <ErrorState error={ozet.error} onRetry={() => void ozet.refetch()} />
        ) : (
          <HomeContent ozet={ozet.data} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function HomeContent({ ozet }: { readonly ozet: Ozet }) {
  const { colors } = useTheme();
  const motion = useMotion();
  const currency = ozet.paraBirimi;
  const affixes = moneyAffixes(currency);
  return (
    <View style={styles.sections}>
      <Animated.View entering={motion.enter(0)}>
        <LinearGradient colors={[colors.heroFrom, colors.heroTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
          <View style={styles.heroTop}>
            <Text variant="label" tone="onHeroMuted">
              Bu ay gönderilen
            </Text>
            <View style={styles.heroChip}>
              <Ionicons name="calendar-outline" size={14} color={colors.onHero} />
              <Text variant="caption" tone="onHero">
                {monthTitle(new Date().getFullYear(), new Date().getMonth())}
              </Text>
            </View>
          </View>
          <AnimatedNumber
            value={ozet.benim.buAyToplam}
            decimals={2}
            prefix={affixes.prefix}
            suffix={affixes.suffix}
            style={[amountLargeFor(formatMoney(ozet.benim.buAyToplam, currency)), { color: colors.onHero }]}
            accessibilityLabel={`Bu ay gönderilen toplam ${formatMoney(ozet.benim.buAyToplam, currency)}`}
          />
          <View style={styles.heroBottom}>
            <View style={styles.flex}>
              <Text variant="caption" tone="onHeroMuted">
                Onay bekleyen tutar
              </Text>
              <Text variant="bodyStrong" tone="onHero">
                {formatMoney(ozet.benim.bekleyenTutar, currency)}
              </Text>
            </View>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Fiş tara"
              accessibilityHint="Kamerayı açar ve yeni masraf oluşturur"
              onPress={() => {
                haptics.press();
                router.push({ pathname: '/masraf/yeni', params: { kaynak: 'kamera' } });
              }}
              style={styles.scanButton}
            >
              <Ionicons name="camera" size={18} color={colors.heroFrom} />
              <Text variant="label" color={colors.heroFrom}>
                Fiş tara
              </Text>
            </PressableScale>
          </View>
        </LinearGradient>
      </Animated.View>

      {ozet.bekleyenOnay > 0 ? (
        <Animated.View entering={motion.enter(1)}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`${ozet.bekleyenOnay} masraf onayınızı bekliyor`}
            accessibilityHint="Onaylar sekmesini açar"
            onPress={() => router.navigate('/onaylar')}
            style={[styles.pending, { backgroundColor: colors.warningSoft, borderColor: colors.warning }]}
          >
            <View style={[styles.pendingIcon, { backgroundColor: colors.warning }]}>
              <Ionicons name="hourglass-outline" size={20} color={colors.onAccent} />
            </View>
            <View style={styles.flex}>
              <Text variant="bodyStrong">{ozet.bekleyenOnay} masraf onayınızı bekliyor</Text>
              <Text variant="small" tone="muted">
                İncelemek için dokunun
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </PressableScale>
        </Animated.View>
      ) : null}

      <Animated.View entering={motion.enter(2)} style={styles.section}>
        <Text variant="heading" accessibilityRole="header">
          Masraflarım
        </Text>
        <View style={styles.counters}>
          {COUNTERS.map((durum) => {
            const tone = statusColors(colors, durum);
            const count = ozet.benim[durum as keyof Ozet['benim']];
            return (
              <PressableScale
                key={durum}
                accessibilityRole="button"
                accessibilityLabel={`${STATUS_LABELS[durum]}: ${count}`}
                accessibilityHint="Bu durumdaki masrafları listeler"
                onPress={() => {
                  haptics.tap();
                  openList(durum);
                }}
                style={[styles.counter, { backgroundColor: colors.surface, borderColor: colors.border }]}
              >
                <View style={[styles.counterDot, { backgroundColor: tone.fg }]} />
                <AnimatedNumber value={count} style={[typography.title, { color: colors.text }]} />
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {STATUS_LABELS[durum]}
                </Text>
              </PressableScale>
            );
          })}
        </View>
      </Animated.View>

      {ozet.genel !== null ? (
        <Animated.View entering={motion.enter(3)} style={styles.section}>
          <Text variant="heading" accessibilityRole="header">
            Şirket geneli
          </Text>
          <View style={styles.metrics}>
            <Metric icon="time-outline" label="Onayda" value={String(ozet.genel.onayda)} />
            <Metric icon="wallet-outline" label="Ödeme bekleyen" value={String(ozet.genel.odemeBekleyen)} />
            <Metric icon="cash-outline" label="Ödeme bekleyen tutar" value={formatMoney(ozet.genel.odemeBekleyenTutar, currency)} />
            <Metric icon="trending-up-outline" label="Bu ay onaylanan" value={formatMoney(ozet.genel.buAyOnaylanan, currency)} />
          </View>
        </Animated.View>
      ) : null}

      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Text variant="heading" accessibilityRole="header">
            Son masraflar
          </Text>
          {ozet.sonMasraflar.length > 0 ? (
            <PressableScale accessibilityRole="link" accessibilityLabel="Tüm masrafları gör" onPress={() => openList()} style={styles.link}>
              <Text variant="label" tone="primary">
                Tümünü gör
              </Text>
            </PressableScale>
          ) : null}
        </View>
        {ozet.sonMasraflar.length === 0 ? (
          <EmptyState
            icon="receipt-outline"
            title="Henüz masraf yok"
            message="Fişinizin fotoğrafını çekin, gerisini biz dolduralım."
            actionTitle="İlk masrafı ekle"
            onAction={() => router.push('/masraf/yeni')}
          />
        ) : (
          <View style={styles.list}>
            {ozet.sonMasraflar.map((item, i) => (
              <Animated.View key={item.id} entering={motion.enter(4 + i)}>
                <ExpenseRow item={item} onPress={openExpense} />
              </Animated.View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

function Metric({ icon, label, value }: { readonly icon: IconName; readonly label: string; readonly value: string }) {
  const { colors } = useTheme();
  return (
    <Card style={styles.metric} accessible accessibilityLabel={`${label}: ${value}`}>
      <Ionicons name={icon} size={20} color={colors.primary} />
      <Text variant="amount" numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text variant="caption" tone="muted" numberOfLines={2}>
        {label}
      </Text>
    </Card>
  );
}

function HomeSkeleton() {
  return (
    <View style={styles.sections}>
      <Skeleton height={180} style={{ borderRadius: radius.xxl }} />
      <View style={styles.counters}>
        {COUNTERS.map((d) => (
          <Skeleton key={d} height={92} style={styles.counterSkeleton} />
        ))}
      </View>
      <ListSkeleton count={3} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxxl },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.xl },
  badge: { position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontWeight: '700', fontSize: 11, lineHeight: 14 },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  sections: { gap: spacing.xxl },
  hero: { borderRadius: radius.xxl, padding: spacing.xl, gap: spacing.md },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  heroBottom: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.xs },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    borderRadius: radius.pill,
  },
  pending: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.xl, borderWidth: 1 },
  pendingIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  section: { gap: spacing.md },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.xs },
  counters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  counter: {
    flexGrow: 1,
    flexBasis: '30%',
    minHeight: 92,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xxs,
  },
  counterSkeleton: { flexGrow: 1, flexBasis: '30%', borderRadius: radius.lg },
  counterDot: { width: 8, height: 8, borderRadius: 4, marginBottom: spacing.xs },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  metric: { flexGrow: 1, flexBasis: '45%', gap: spacing.xs, borderRadius: radius.lg },
  list: { gap: spacing.sm },
});
