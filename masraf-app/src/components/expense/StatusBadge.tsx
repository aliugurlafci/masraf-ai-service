import { StyleSheet, View } from 'react-native';

import type { MasrafDurum } from '@/api/types';
import { Text } from '@/components/ui/Text';
import { STATUS_LABELS } from '@/lib/status';
import { radius, spacing, statusColors, useTheme } from '@/theme';

export function StatusBadge({ durum, size = 'sm' }: { readonly durum: MasrafDurum; readonly size?: 'sm' | 'md' }) {
  const { colors } = useTheme();
  const { fg, bg } = statusColors(colors, durum);
  return (
    <View
      accessibilityLabel={`Durum: ${STATUS_LABELS[durum]}`}
      style={[
        styles.badge,
        size === 'md' && styles.md,
        { backgroundColor: bg },
        durum === 'iptal' && { borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: fg }]} />
      <Text variant={size === 'md' ? 'label' : 'caption'} color={fg} numberOfLines={1}>
        {STATUS_LABELS[durum]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 1,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 3,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  md: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
});
