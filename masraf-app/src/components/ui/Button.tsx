import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { haptics } from '@/lib/haptics';
import { minTouch, radius, spacing, useTheme } from '@/theme';

import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type IconName = ComponentProps<typeof Ionicons>['name'];
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'dangerSoft' | 'success';

export interface ButtonProps {
  readonly title: string;
  readonly onPress: () => void;
  readonly variant?: ButtonVariant;
  readonly size?: 'md' | 'sm';
  readonly icon?: IconName;
  readonly loading?: boolean;
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly flex?: boolean;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  style,
  flex = false,
}: ButtonProps) {
  const { colors } = useTheme();
  const look: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: colors.primary, fg: colors.onPrimary, border: colors.primary },
    secondary: { bg: colors.primarySoft, fg: colors.primary, border: colors.primarySoft },
    outline: { bg: 'transparent', fg: colors.text, border: colors.border },
    ghost: { bg: 'transparent', fg: colors.primary, border: 'transparent' },
    danger: { bg: colors.danger, fg: '#FFFFFF', border: colors.danger },
    dangerSoft: { bg: colors.dangerSoft, fg: colors.danger, border: colors.dangerSoft },
    success: { bg: colors.success, fg: '#FFFFFF', border: colors.success },
  };
  const { bg, fg, border } = look[variant];
  const inactive = disabled || loading;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={() => {
        haptics.press();
        onPress();
      }}
      style={[
        styles.base,
        size === 'sm' ? styles.sm : styles.md,
        { backgroundColor: bg, borderColor: border, opacity: disabled ? 0.45 : 1 },
        flex && styles.flex,
        style,
      ]}
    >
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator color={fg} />
        ) : icon !== undefined ? (
          <Ionicons name={icon} size={size === 'sm' ? 18 : 20} color={fg} />
        ) : null}
        <Text variant={size === 'sm' ? 'label' : 'bodyStrong'} color={fg} numberOfLines={2} align="center" style={styles.label}>
          {title}
        </Text>
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth * 2,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  md: { minHeight: 52, paddingVertical: spacing.sm },
  sm: { minHeight: minTouch, paddingVertical: spacing.xs, borderRadius: radius.md },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  label: { flexShrink: 1 },
  flex: { flex: 1 },
});
