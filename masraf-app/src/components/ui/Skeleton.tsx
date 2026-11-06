import { useEffect } from 'react';
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { radius, spacing, useTheme } from '@/theme';

export interface SkeletonProps {
  readonly width?: DimensionValue;
  readonly height?: number;
  readonly round?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

/** Placeholder block that pulses while content loads. Hidden from screen readers. */
export function Skeleton({ width = '100%', height = 14, round = false, style }: SkeletonProps) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reduced) return undefined;
    opacity.set(withRepeat(withTiming(0.45, { duration: 750, easing: Easing.inOut(Easing.quad) }), -1, true));
    return () => cancelAnimation(opacity);
  }, [reduced, opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <Animated.View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        { width, height, backgroundColor: colors.skeleton, borderRadius: round ? radius.pill : radius.sm },
        animated,
        style,
      ]}
    />
  );
}

/** Skeleton shaped like an expense row. */
export function ExpenseRowSkeleton() {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Skeleton width={44} height={44} round />
      <View style={styles.lines}>
        <Skeleton width="70%" height={16} />
        <Skeleton width="45%" height={12} />
      </View>
      <View style={styles.right}>
        <Skeleton width={72} height={16} />
        <Skeleton width={56} height={20} round />
      </View>
    </View>
  );
}

export function ListSkeleton({ count = 6 }: { readonly count?: number }) {
  return (
    <View style={styles.list} accessibilityLabel="Yükleniyor" accessibilityRole="progressbar">
      {Array.from({ length: count }, (_, i) => (
        <ExpenseRowSkeleton key={i} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  lines: { flex: 1, gap: spacing.sm },
  right: { alignItems: 'flex-end', gap: spacing.sm },
  list: { gap: spacing.sm },
});
