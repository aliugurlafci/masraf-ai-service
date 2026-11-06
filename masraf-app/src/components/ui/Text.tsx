import { Text as RNText, type TextProps } from 'react-native';

import { typography, useTheme, type TypographyVariant } from '@/theme';

export type TextTone = 'default' | 'muted' | 'faint' | 'primary' | 'danger' | 'success' | 'warning' | 'info' | 'onPrimary' | 'onHero' | 'onHeroMuted';

export interface AppTextProps extends TextProps {
  readonly variant?: TypographyVariant;
  readonly tone?: TextTone;
  readonly color?: string;
  readonly align?: 'left' | 'center' | 'right';
}

/** Themed text with the design system's type scale. Scales with the system font size. */
export function Text({ variant = 'body', tone = 'default', color, align, style, ...rest }: AppTextProps) {
  const { colors } = useTheme();
  const toneColor: Record<TextTone, string> = {
    default: colors.text,
    muted: colors.textMuted,
    faint: colors.textFaint,
    primary: colors.primaryText,
    danger: colors.danger,
    success: colors.success,
    warning: colors.warning,
    info: colors.info,
    onPrimary: colors.onPrimary,
    onHero: colors.onHero,
    onHeroMuted: colors.onHeroMuted,
  };
  return (
    <RNText
      maxFontSizeMultiplier={variant === 'display' || variant === 'amountLarge' ? 1.4 : 2}
      style={[typography[variant], { color: color ?? toneColor[tone] }, align !== undefined && { textAlign: align }, style]}
      {...rest}
    />
  );
}
