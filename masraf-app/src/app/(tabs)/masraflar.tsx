import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { flattenPages, useMasrafList } from '@/api/queries';
import type { Kapsam, MasrafDurum, MasrafOzet } from '@/api/types';
import { useAuth } from '@/auth/AuthProvider';
import { ExpenseRow } from '@/components/expense/ExpenseRow';
import { Chip } from '@/components/ui/Chip';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/StateViews';
import { Text } from '@/components/ui/Text';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useMotion } from '@/hooks/useMotion';
import { canSeeAll, STATUS_LABELS, STATUS_ORDER } from '@/lib/status';
import { minTouch, radius, spacing, statusColors, typography, useTheme } from '@/theme';

const isStatus = (value: unknown): value is MasrafDurum => typeof value === 'string' && (STATUS_ORDER as readonly string[]).includes(value);

const openExpense = (id: number): void => router.push({ pathname: '/masraf/[id]', params: { id: String(id) } });

export default function ExpensesScreen() {
  const { colors } = useTheme();
  const motion = useMotion();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ durum?: string }>();
  const [durum, setDurum] = useState<MasrafDurum | null>(isStatus(params.durum) ? params.durum : null);
  const [kapsam, setKapsam] = useState<Kapsam>('benim');
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search, 350);
  const showScope = canSeeAll(user?.rol);

  // The home screen counters open this tab with ?durum=...; follow the latest one.
  useEffect(() => {
    if (isStatus(params.durum)) setDurum(params.durum);
  }, [params.durum]);

  const list = useMasrafList(showScope ? kapsam : 'benim', durum === null ? [] : [durum], q);
  const items = flattenPages(list.data);
  const total = list.data?.pages[0]?.toplam;

  const renderItem = ({ item, index }: { item: MasrafOzet; index: number }) => (
    <Animated.View entering={index < 12 ? motion.enter(index) : undefined}>
      <ExpenseRow item={item} onPress={openExpense} showOwner={kapsam === 'tumu'} />
    </Animated.View>
  );

  const filtered = durum !== null || q.trim() !== '';

  return (
    <SafeAreaView edges={['top']} style={[styles.flex, { backgroundColor: colors.bg }]}>
      <View style={styles.top}>
        <ScreenHeader
          title={kapsam === 'tumu' ? 'Tüm masraflar' : 'Masraflarım'}
          subtitle={total !== undefined ? `${total} kayıt` : undefined}
        />
        {showScope ? (
          <SegmentedControl
            accessibilityLabel="Kapsam"
            options={[
              { value: 'benim', label: 'Benim' },
              { value: 'tumu', label: 'Tümü' },
            ]}
            value={kapsam}
            onChange={setKapsam}
          />
        ) : null}
        <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Ionicons name="search" size={20} color={colors.textFaint} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Başlık, satıcı veya açıklama ara"
            placeholderTextColor={colors.textFaint}
            accessibilityLabel="Masraflarda ara"
            returnKeyType="search"
            autoCorrect={false}
            style={[styles.searchInput, typography.body, { color: colors.text }]}
          />
          {search !== '' ? (
            <Pressable onPress={() => setSearch('')} accessibilityRole="button" accessibilityLabel="Aramayı temizle" hitSlop={8} style={styles.clear}>
              <Ionicons name="close-circle" size={20} color={colors.textFaint} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="tablist">
          <Chip label="Tümü" selected={durum === null} onPress={() => setDurum(null)} />
          {STATUS_ORDER.map((d) => {
            const tone = statusColors(colors, d);
            return (
              <Chip
                key={d}
                label={STATUS_LABELS[d]}
                selected={durum === d}
                accent={{ fg: tone.fg, bg: tone.bg }}
                onPress={() => setDurum(durum === d ? null : d)}
              />
            );
          })}
        </ScrollView>
      </View>

      {list.isPending ? (
        <View style={styles.listPad}>
          <ListSkeleton />
        </View>
      ) : list.isError && items.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.listPad}
          ItemSeparatorComponent={Separator}
          onEndReached={() => {
            if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
          }}
          onEndReachedThreshold={0.4}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={9}
          removeClippedSubviews
          keyboardDismissMode="on-drag"
          refreshControl={
            <RefreshControl
              refreshing={list.isRefetching && !list.isFetchingNextPage}
              onRefresh={() => void list.refetch()}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          ListEmptyComponent={
            filtered ? (
              <EmptyState icon="search-outline" title="Sonuç yok" message="Filtreyi veya aramayı değiştirip tekrar deneyin." />
            ) : (
              <EmptyState
                icon="receipt-outline"
                title="Henüz masraf yok"
                message="Fişinizin fotoğrafını çekerek ilk masrafınızı oluşturun."
                actionTitle="Yeni masraf"
                onAction={() => router.push('/masraf/yeni')}
              />
            )
          }
          ListFooterComponent={
            list.isFetchingNextPage ? (
              <ActivityIndicator style={styles.footer} color={colors.primary} accessibilityLabel="Daha fazla yükleniyor" />
            ) : !list.hasNextPage && items.length > 0 ? (
              <Text variant="caption" tone="faint" align="center" style={styles.footer}>
                Hepsi bu kadar
              </Text>
            ) : undefined
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
  top: { paddingHorizontal: spacing.xl, gap: spacing.md },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: spacing.md + 2,
    minHeight: 48,
  },
  searchInput: { flex: 1, minHeight: minTouch, paddingVertical: spacing.sm },
  clear: { minWidth: 32, minHeight: minTouch, alignItems: 'center', justifyContent: 'center' },
  chips: { paddingHorizontal: spacing.xl, paddingVertical: spacing.md, gap: spacing.sm },
  listPad: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxxl, flexGrow: 1 },
  separator: { height: spacing.sm },
  footer: { paddingVertical: spacing.xl },
});
