import { StyleSheet, View, type ViewProps } from 'react-native';

import { radius, spacing, useTheme } from '@/theme';

export interface CardProps extends ViewProps {
  readonly padded?: boolean;
  readonly tone?: 'surface' | 'alt';
}

export function Card({ padded = true, tone = 'surface', style, ...rest }: CardProps) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: tone === 'alt' ? colors.surfaceAlt : colors.surface, borderColor: colors.border },
        padded && styles.padded,
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth },
  padded: { padding: spacing.lg },
});
