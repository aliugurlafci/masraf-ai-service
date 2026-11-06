import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { haptics } from '@/lib/haptics';
import { minTouch, radius, useTheme } from '@/theme';

import type { IconName } from './Button';
import { PressableScale } from './PressableScale';

export interface IconButtonProps {
  readonly icon: IconName;
  readonly onPress: () => void;
  readonly accessibilityLabel: string;
  readonly tone?: 'plain' | 'soft';
  readonly color?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly disabled?: boolean;
}

export function IconButton({ icon, onPress, accessibilityLabel, tone = 'plain', color, style, disabled = false }: IconButtonProps) {
  const { colors } = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      scaleTo={0.9}
      style={[styles.base, tone === 'soft' && { backgroundColor: colors.surfaceAlt }, disabled && styles.disabled, style]}
    >
      <Ionicons name={icon} size={22} color={color ?? colors.text} />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: { width: minTouch, height: minTouch, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.45 },
});
