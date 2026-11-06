import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated';

import { Text } from '@/components/ui/Text';
import { PressableScale } from '@/components/ui/PressableScale';
import type { IconName } from '@/components/ui/Button';
import { haptics } from '@/lib/haptics';
import { radius, spacing, useTheme } from '@/theme';

const ICONS: Readonly<Record<string, readonly [IconName, IconName]>> = {
  index: ['home-outline', 'home'],
  masraflar: ['receipt-outline', 'receipt'],
  onaylar: ['checkmark-done-circle-outline', 'checkmark-done-circle'],
  profil: ['person-circle-outline', 'person-circle'],
};

const SPRING = { damping: 16, stiffness: 240, mass: 0.6 } as const;

/**
 * Bottom tab bar with a raised "+" in the middle that opens the new expense flow. Tabs keep the
 * navigator's events (tabPress) so the default behaviour such as scroll-to-top still works.
 */
export function TabBar({ state, descriptors, emitter, navigateToTab, insets }: BottomTabBarProps) {
  const { colors } = useTheme();
  const routes = state.routes;
  const middle = Math.ceil(routes.length / 2);

  const renderTab = (index: number) => {
    const route = routes[index];
    if (route === undefined) return null;
    const descriptor = descriptors[route.key];
    const options = descriptor?.options;
    const label = options?.title ?? route.name;
    const badge = options?.tabBarBadge;
    const focused = state.index === index;
    return (
      <TabItem
        key={route.key}
        label={label}
        icons={ICONS[route.name] ?? ['ellipse-outline', 'ellipse']}
        focused={focused}
        badge={badge}
        onPress={() => {
          const event = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) {
            haptics.tap();
            navigateToTab(route.key);
          }
        }}
        onLongPress={() => emitter.emit({ type: 'tabLongPress', target: route.key })}
      />
    );
  };

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: colors.tabBar,
          borderTopColor: colors.border,
          paddingBottom: Math.max(insets.bottom, spacing.sm),
        },
      ]}
    >
      <View style={styles.row} accessibilityRole="tablist">
        {routes.slice(0, middle).map((_, i) => renderTab(i))}
        <PlusButton />
        {routes.slice(middle).map((_, i) => renderTab(middle + i))}
      </View>
    </View>
  );
}

interface TabItemProps {
  readonly label: string;
  readonly icons: readonly [IconName, IconName];
  readonly focused: boolean;
  readonly badge: string | number | undefined;
  readonly onPress: () => void;
  readonly onLongPress: () => void;
}

function TabItem({ label, icons, focused, badge, onPress, onLongPress }: TabItemProps) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(focused ? 1 : 0);
  useEffect(() => {
    progress.set(reduced ? (focused ? 1 : 0) : withSpring(focused ? 1 : 0, SPRING));
  }, [focused, reduced, progress]);
  const pill = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ scaleX: 0.6 + progress.get() * 0.4 }],
  }));
  const icon = useAnimatedStyle(() => ({ transform: [{ translateY: -progress.get() * 1.5 }, { scale: 1 + progress.get() * 0.06 }] }));
  const color = focused ? colors.primary : colors.textMuted;
  const hasBadge = badge !== undefined && badge !== '' && badge !== 0;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={hasBadge ? `${label}, ${badge} bekleyen` : label}
      onPress={onPress}
      onLongPress={onLongPress}
      style={styles.tab}
    >
      <View style={styles.iconWrap}>
        <Animated.View style={[styles.pill, { backgroundColor: colors.primarySoft }, pill]} />
        <Animated.View style={icon}>
          <Ionicons name={focused ? icons[1] : icons[0]} size={23} color={color} />
        </Animated.View>
        {hasBadge ? (
          <View style={[styles.badge, { backgroundColor: colors.danger, borderColor: colors.tabBar }]}>
            <Text variant="caption" color="#FFFFFF" maxFontSizeMultiplier={1.2} style={styles.badgeText}>
              {typeof badge === 'number' && badge > 99 ? '99+' : String(badge)}
            </Text>
          </View>
        ) : null}
      </View>
      <Text variant="caption" color={color} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
    </Pressable>
  );
}

function PlusButton() {
  const { colors } = useTheme();
  return (
    <View style={styles.plusSlot}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Yeni masraf"
        accessibilityHint="Fiş veya fatura ekleyerek yeni masraf oluşturur"
        scaleTo={0.9}
        onPress={() => {
          haptics.press();
          router.push('/masraf/yeni');
        }}
        style={[styles.plus, { backgroundColor: colors.primary, shadowColor: colors.primary, borderColor: colors.tabBar }]}
      >
        <Ionicons name="add" size={32} color={colors.onPrimary} />
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'flex-end' },
  tab: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center', gap: 2, paddingTop: spacing.xs },
  iconWrap: { width: 56, height: 30, alignItems: 'center', justifyContent: 'center' },
  pill: { ...StyleSheet.absoluteFill, borderRadius: radius.pill },
  badge: {
    position: 'absolute',
    top: -4,
    right: 6,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 11, lineHeight: 14 },
  plusSlot: { flex: 1, alignItems: 'center' },
  plus: {
    width: 62,
    height: 62,
    borderRadius: 31,
    marginTop: -26,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: Platform.OS === 'ios' ? 0.35 : 0,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
});
