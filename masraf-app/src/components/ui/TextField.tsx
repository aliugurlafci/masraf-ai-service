import { Ionicons } from '@expo/vector-icons';
import { useState, type ReactNode, type Ref } from 'react';
import { StyleSheet, TextInput, View, type StyleProp, type TextInputInstance, type TextInputProps, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import { useMotion } from '@/hooks/useMotion';
import { minTouch, radius, spacing, typography, useTheme } from '@/theme';

import type { IconName } from './Button';
import { Text } from './Text';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  readonly label: string;
  /** Message under the field, e.g. the server's `alanlar` entry. */
  readonly error?: string | null;
  readonly hint?: string;
  readonly icon?: IconName;
  readonly right?: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly inputStyle?: TextInputProps['style'];
  readonly ref?: Ref<TextInputInstance>;
}

export function TextField({ label, error, hint, icon, right, style, inputStyle, multiline, onFocus, onBlur, ref, ...rest }: TextFieldProps) {
  const { colors } = useTheme();
  const motion = useMotion();
  const [focused, setFocused] = useState(false);
  const hasError = error !== undefined && error !== null && error !== '';
  const borderColor = hasError ? colors.danger : focused ? colors.primary : colors.border;
  return (
    <View style={[styles.wrap, style]}>
      <Text variant="label" tone="muted" style={styles.label}>
        {label}
      </Text>
      <View
        style={[
          styles.box,
          multiline === true && styles.boxMultiline,
          { borderColor, backgroundColor: colors.surface, borderWidth: focused || hasError ? 2 : 1 },
        ]}
      >
        {icon !== undefined ? <Ionicons name={icon} size={20} color={focused ? colors.primary : colors.textFaint} /> : null}
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          accessibilityHint={hasError ? (error ?? undefined) : hint}
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.primary}
          multiline={multiline}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, typography.body, { color: colors.text }, multiline === true && styles.inputMultiline, inputStyle]}
          {...rest}
        />
        {right}
      </View>
      {hasError ? (
        <Animated.View entering={motion.fadeIn} style={styles.message}>
          <Ionicons name="alert-circle" size={16} color={colors.danger} />
          <Text variant="small" tone="danger" style={styles.messageText} accessibilityLiveRegion="polite">
            {error}
          </Text>
        </Animated.View>
      ) : hint !== undefined ? (
        <Text variant="small" tone="faint" style={styles.hint}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** Error text under a custom (non-text) field such as the category chips. */
export function FieldError({ message }: { readonly message: string | null | undefined }) {
  const { colors } = useTheme();
  const motion = useMotion();
  if (message === undefined || message === null || message === '') return null;
  return (
    <Animated.View entering={motion.fadeIn} style={styles.message}>
      <Ionicons name="alert-circle" size={16} color={colors.danger} />
      <Text variant="small" tone="danger" style={styles.messageText} accessibilityLiveRegion="polite">
        {message}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs + 2 },
  label: { marginLeft: spacing.xs },
  box: {
    minHeight: 52,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md + 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  boxMultiline: { alignItems: 'flex-start', paddingVertical: spacing.sm },
  input: { flex: 1, minHeight: minTouch, paddingVertical: spacing.sm },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  message: { flexDirection: 'row', gap: spacing.xs, alignItems: 'flex-start', marginLeft: spacing.xs },
  messageText: { flex: 1 },
  hint: { marginLeft: spacing.xs },
});
