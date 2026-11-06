import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useBen, useOnaylar } from '@/api/queries';
import type { MasrafOzet, OnayListeDurumu } from '@/api/types';
import { ExpenseRow } from '@/components/expense/ExpenseRow';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/StateViews';
import { useMotion } from '@/hooks/useMotion';
import { spacing, useTheme } from '@/theme';

const openExpense = (id: number): void => router.push({ pathname: '/masraf/[id]', params: { id: String(id) } });

export default function ApprovalsScreen() {
  const { colors } = useTheme();
  const motion = useMotion();
  const [durum, setDurum] = useState<OnayListeDurumu>('bekleyen');
  const list = useOnaylar(durum);
  const ben = useBen();
  const pending = durum === 'bekleyen' ? (list.data?.length ?? ben.data?.bekleyenOnay ?? 0) : (ben.data?.bekleyenOnay ?? 0);

  const renderItem = ({ item, index }: { item: MasrafOzet; index: number }) => (
    <Animated.View entering={index < 12 ? motion.enter(index) : undefined}>
      <ExpenseRow item={item} onPress={openExpense} showOwner />
    </Animated.View>
  );

  return (
    <SafeAreaView edges={['top']} style={[styles.flex, { backgroundColor: colors.bg }]}>
      <View style={styles.top}>
        <ScreenHeader title="Onaylar" subtitle={durum === 'bekleyen' ? 'Kararınızı bekleyen masraflar' : 'Karar verdiğiniz masraflar'} />
        <SegmentedControl
          accessibilityLabel="Onay listesi"
          options={[
            { value: 'bekleyen', label: 'Bekleyen', badge: pending },
            { value: 'karar', label: 'Karar verdiklerim' },
          ]}
          value={durum}
          onChange={setDurum}
        />
      </View>
      {list.isPending ? (
        <View style={styles.listPad}>
          <ListSkeleton count={4} />
        </View>
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <FlatList
          data={list.data}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.listPad}
          ItemSeparatorComponent={Separator}
          initialNumToRender={10}
          windowSize={9}
          removeClippedSubviews
          refreshControl={
            <RefreshControl
              refreshing={list.isRefetching}
              onRefresh={() => {
                void list.refetch();
                void ben.refetch();
              }}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          ListEmptyComponent={
            durum === 'bekleyen' ? (
              <EmptyState icon="checkmark-done-circle-outline" title="Her şey yolunda" message="Onayınızı bekleyen masraf yok." />
            ) : (
              <EmptyState icon="file-tray-outline" title="Henüz karar yok" message="Onayladığınız veya reddettiğiniz masraflar burada görünür." />
            )
          }
        />
      )}
    </SafeAreaView>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  top: { paddingHorizontal: spacing.xl, gap: spacing.md, paddingBottom: spacing.md },
  listPad: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.xxxl, flexGrow: 1 },
  separator: { height: spacing.sm },
});
