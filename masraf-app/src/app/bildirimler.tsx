import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { errorMessage } from '@/api/client';
import { useBildirimler, useMarkAllRead, useMarkRead } from '@/api/queries';
import type { Bildirim, BildirimTuru } from '@/api/types';
import { Button, type IconName } from '@/components/ui/Button';
import { PressableScale } from '@/components/ui/PressableScale';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/StateViews';
import { Text } from '@/components/ui/Text';
import { useToast } from '@/components/ui/Toast';
import { useMotion } from '@/hooks/useMotion';
import { formatDateTime } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import { radius, spacing, useTheme } from '@/theme';

const ICONS: Record<BildirimTuru, IconName> = {
  onay_bekliyor: 'hourglass-outline',
  hatirlatma: 'alarm-outline',
  devredildi: 'swap-horizontal-outline',
  onaylandi: 'checkmark-circle-outline',
  reddedildi: 'close-circle-outline',
  odendi: 'wallet-outline',
  odeme_bekliyor: 'cash-outline',
};

export default function NotificationsScreen() {
  const { colors } = useTheme();
  const motion = useMotion();
  const toast = useToast();
  const list = useBildirimler();
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const items = list.data?.pages.flatMap((p) => p.kayitlar) ?? [];
  const unread = list.data?.pages[0]?.okunmamis ?? 0;

  const open = (item: Bildirim): void => {
    haptics.tap();
    if (!item.okundu) markRead.mutate(item.id);
    if (item.form !== null) router.push({ pathname: '/masraf/[id]', params: { id: String(item.form.id) } });
  };

  const readAll = (): void => {
    haptics.press();
    markAll.mutate(undefined, {
      onSuccess: () => toast('Bildirimler okundu olarak işaretlendi.', 'success'),
      onError: (err) => {
        haptics.error();
        toast(errorMessage(err), 'danger');
      },
    });
  };

  return (
    <View style={[styles.flex, { backgroundColor: colors.bg }]}>
      {list.isPending ? (
        <View style={styles.pad}>
          <ListSkeleton />
        </View>
      ) : list.isError && items.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item, index }) => (
            <Animated.View entering={index < 12 ? motion.enter(index) : undefined}>
              <NotificationRow item={item} onPress={() => open(item)} />
            </Animated.View>
          )}
          contentContainerStyle={styles.pad}
          ItemSeparatorComponent={Separator}
          ListHeaderComponent={
            unread > 0 ? (
              <View style={styles.head}>
                <Text variant="small" tone="muted" style={styles.flex}>
                  {unread} okunmamış bildirim
                </Text>
                <Button
                  title="Hepsini okundu yap"
                  icon="checkmark-done"
                  size="sm"
                  variant="secondary"
                  loading={markAll.isPending}
                  onPress={readAll}
                  accessibilityHint="Bütün bildirimleri okundu olarak işaretler"
                />
              </View>
            ) : undefined
          }
          onEndReached={() => {
            if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
          }}
          onEndReachedThreshold={0.4}
          initialNumToRender={10}
          windowSize={9}
          refreshControl={
            <RefreshControl
              refreshing={list.isRefetching && !list.isFetchingNextPage}
              onRefresh={() => void list.refetch()}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          ListEmptyComponent={
            <EmptyState icon="notifications-off-outline" title="Bildirim yok" message="Onay ve ödeme gelişmeleri burada görünecek." />
          }
          ListFooterComponent={
            list.isFetchingNextPage ? (
              <ActivityIndicator style={styles.footer} color={colors.primary} accessibilityLabel="Daha fazla yükleniyor" />
            ) : undefined
          }
        />
      )}
    </View>
  );
}

function NotificationRow({ item, onPress }: { readonly item: Bildirim; readonly onPress: () => void }) {
  const { colors } = useTheme();
  const when = formatDateTime(item.olusturma);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${item.okundu ? '' : 'Okunmamış. '}${item.baslik}. ${item.mesaj}. ${when}`}
      accessibilityHint={item.form !== null ? 'Masrafı açar' : undefined}
      onPress={onPress}
      scaleTo={0.98}
      style={[
        styles.row,
        {
          backgroundColor: item.okundu ? colors.surface : colors.primarySoft,
          borderColor: item.okundu ? colors.border : colors.primary,
        },
      ]}
    >
      <View style={[styles.icon, { backgroundColor: item.okundu ? colors.surfaceAlt : colors.primary }]}>
        <Ionicons name={ICONS[item.tur]} size={20} color={item.okundu ? colors.textMuted : colors.onPrimary} />
      </View>
      <View style={styles.flex}>
        <View style={styles.titleRow}>
          <Text variant={item.okundu ? 'label' : 'bodyStrong'} style={styles.flex} numberOfLines={2}>
            {item.baslik}
          </Text>
          {!item.okundu ? <View style={[styles.dot, { backgroundColor: colors.primary }]} /> : null}
        </View>
        <Text variant="small" tone="muted">
          {item.mesaj}
        </Text>
        <Text variant="caption" tone="faint">
          {when}
        </Text>
      </View>
    </PressableScale>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { padding: spacing.xl, paddingBottom: spacing.xxxl, flexGrow: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  separator: { height: spacing.sm },
  footer: { paddingVertical: spacing.xl },
  row: { flexDirection: 'row', gap: spacing.md, padding: spacing.lg, borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth, minHeight: 72 },
  icon: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
