import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native';

import type { CategoryIconName } from '@/lib/categories';
import { haptics } from '@/lib/haptics';
import { minTouch, radius, spacing, useTheme } from '@/theme';

import type { IconName } from './Button';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export interface ChipProps {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly icon?: IconName;
  readonly categoryIcon?: CategoryIconName;
  /** Colour of the selected state; defaults to the primary colour. */
  readonly accent?: { readonly fg: string; readonly bg: string };
  readonly count?: number;
  readonly accessibilityLabel?: string;
}

/** Selectable pill used for filters, categories and currencies. */
export function Chip({ label, selected, onPress, icon, categoryIcon, accent, count, accessibilityLabel }: ChipProps) {
  const { colors } = useTheme();
  const fg = selected ? (accent?.fg ?? colors.onPrimary) : colors.text;
  const bg = selected ? (accent?.bg ?? colors.primary) : colors.surface;
  const border = selected ? (accent?.fg ?? colors.primary) : colors.border;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      style={[styles.chip, { backgroundColor: bg, borderColor: border }]}
    >
      {categoryIcon !== undefined ? <MaterialCommunityIcons name={categoryIcon} size={18} color={fg} /> : null}
      {icon !== undefined ? <Ionicons name={icon} size={16} color={fg} /> : null}
      <Text variant="label" color={fg} numberOfLines={1}>
        {label}
      </Text>
      {count !== undefined && count > 0 ? (
        <Text variant="caption" color={fg} style={styles.count}>
          {count}
        </Text>
      ) : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: minTouch,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  count: { opacity: 0.8 },
});
