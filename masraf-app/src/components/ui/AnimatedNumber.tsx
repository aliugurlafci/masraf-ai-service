import { useEffect } from 'react';
import { StyleSheet, TextInput, type TextInputProps, type TextStyle, type StyleProp } from 'react-native';
import Animated, { Easing, useAnimatedProps, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { formatNumber } from '@/lib/format';

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

/** Formats on the UI thread: "." thousands, "," decimals, with a prefix/suffix (e.g. "₺"). */
function formatOnUi(value: number, decimals: number, prefix: string, suffix: string): string {
  'worklet';
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(decimals);
  const dot = fixed.indexOf('.');
  const whole = dot < 0 ? fixed : fixed.slice(0, dot);
  const fraction = dot < 0 ? '' : fixed.slice(dot + 1);
  let grouped = '';
  for (let i = 0; i < whole.length; i++) {
    const fromEnd = whole.length - i;
    grouped += whole.charAt(i);
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) grouped += '.';
  }
  return `${negative ? '-' : ''}${prefix}${grouped}${fraction === '' ? '' : `,${fraction}`}${suffix}`;
}

export interface AnimatedNumberProps {
  readonly value: number;
  readonly decimals?: number;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly style?: StyleProp<TextStyle>;
  readonly durationMs?: number;
  /** What a screen reader says; defaults to the final formatted value. */
  readonly accessibilityLabel?: string;
}

/** Counts up to `value` on the UI thread. Shows the final value at once when reduce motion is on. */
export function AnimatedNumber({ value, decimals = 0, prefix = '', suffix = '', style, durationMs = 900, accessibilityLabel }: AnimatedNumberProps) {
  const reduced = useReducedMotion();
  const current = useSharedValue(reduced ? value : 0);
  useEffect(() => {
    current.set(reduced ? value : withTiming(value, { duration: durationMs, easing: Easing.out(Easing.cubic) }));
  }, [value, reduced, durationMs, current]);

  const animatedProps = useAnimatedProps(() => {
    const text = formatOnUi(current.get(), decimals, prefix, suffix);
    return { text, defaultValue: text } as unknown as TextInputProps;
  });
  const finalText = `${value < 0 ? '-' : ''}${prefix}${formatNumber(Math.abs(value), decimals)}${suffix}`;
  return (
    <AnimatedTextInput
      editable={false}
      underlineColorAndroid="transparent"
      caretHidden
      pointerEvents="none"
      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? finalText}
      defaultValue={finalText}
      animatedProps={animatedProps}
      maxFontSizeMultiplier={1.4}
      style={[styles.input, style]}
    />
  );
}

const styles = StyleSheet.create({
  input: { padding: 0, margin: 0, includeFontPadding: false },
});
