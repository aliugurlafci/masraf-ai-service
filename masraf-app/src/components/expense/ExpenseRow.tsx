import { Ionicons } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import type { MasrafOzet } from '@/api/types';
import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/Text';
import { formatDate, formatMoney } from '@/lib/format';
import { STATUS_LABELS } from '@/lib/status';
import { radius, spacing, useTheme } from '@/theme';

import { CategoryIcon } from './CategoryIcon';
import { StatusBadge } from './StatusBadge';

export interface ExpenseRowProps {
  readonly item: MasrafOzet;
  readonly onPress: (id: number) => void;
  /** Show who created it (approver and "all forms" lists). */
  readonly showOwner?: boolean;
}

function ExpenseRowBase({ item, onPress, showOwner = false }: ExpenseRowProps) {
  const { colors } = useTheme();
  const subtitleParts = [showOwner ? item.olusturan.adSoyad : item.kategori.ad, formatDate(item.masrafTarihi)];
  const amount = formatMoney(item.tutar, item.paraBirimi);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${item.baslik}, ${amount}, ${STATUS_LABELS[item.durum]}, ${subtitleParts.join(', ')}`}
      accessibilityHint="Ayrıntıları açar"
      onPress={() => onPress(item.id)}
      scaleTo={0.98}
      style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <CategoryIcon simge={item.kategori.simge} />
      <View style={styles.middle}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {item.baslik}
        </Text>
        <Text variant="small" tone="muted" numberOfLines={1}>
          {subtitleParts.join(' · ')}
        </Text>
        {item.durum === 'onayda' && item.siradakiOnayci !== null ? (
          <View style={styles.next}>
            <Ionicons name="time-outline" size={13} color={colors.textFaint} />
            <Text variant="caption" tone="faint" numberOfLines={1}>
              {item.siradakiOnayci.adSoyad}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={styles.right}>
        <Text variant="amount" numberOfLines={1}>
          {amount}
        </Text>
        <StatusBadge durum={item.durum} />
      </View>
    </PressableScale>
  );
}

export const ExpenseRow = memo(ExpenseRowBase);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 72,
  },
  middle: { flex: 1, gap: 2 },
  right: { alignItems: 'flex-end', gap: spacing.xs + 2, maxWidth: '45%' },
  next: { flexDirection: 'row', alignItems: 'center', gap: 3 },
});
