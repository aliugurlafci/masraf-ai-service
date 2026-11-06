import { useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, withSpring } from 'react-native-reanimated';

import { haptics } from '@/lib/haptics';
import { minTouch, radius, spacing, useTheme } from '@/theme';

import { Text } from './Text';

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly badge?: number;
}

export interface SegmentedControlProps<T extends string> {
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly accessibilityLabel: string;
}

/** Two to four options with a sliding highlight. */
export function SegmentedControl<T extends string>({ options, value, onChange, accessibilityLabel }: SegmentedControlProps<T>) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const segment = options.length === 0 ? 0 : (width - 8) / options.length;

  const indicator = useAnimatedStyle(() => {
    const x = index * segment;
    return { width: segment, transform: [{ translateX: reduced ? x : withSpring(x, { damping: 20, stiffness: 260 }) }] };
  });

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      style={[styles.track, { backgroundColor: colors.surfaceAlt }]}
    >
      {width > 0 ? <Animated.View style={[styles.indicator, { backgroundColor: colors.surface }, indicator]} /> : null}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={option.badge !== undefined && option.badge > 0 ? `${option.label}, ${option.badge}` : option.label}
            onPress={() => {
              if (!selected) {
                haptics.tap();
                onChange(option.value);
              }
            }}
            style={styles.segment}
          >
            <Text variant="label" tone={selected ? 'default' : 'muted'} numberOfLines={1}>
              {option.label}
            </Text>
            {option.badge !== undefined && option.badge > 0 ? (
              <View style={[styles.badge, { backgroundColor: colors.primary }]}>
                <Text variant="caption" tone="onPrimary">
                  {option.badge > 99 ? '99+' : option.badge}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', borderRadius: radius.lg, padding: 4 },
  indicator: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    left: 4,
    borderRadius: radius.md,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  segment: { flex: 1, minHeight: minTouch, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: spacing.xs },
  badge: { minWidth: 20, height: 20, borderRadius: radius.pill, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
});
