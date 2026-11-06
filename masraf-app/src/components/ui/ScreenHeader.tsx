import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { spacing } from '@/theme';

import { Text } from './Text';

export interface ScreenHeaderProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly right?: ReactNode;
}

/** Large title used at the top of tab screens. */
export function ScreenHeader({ title, subtitle, right }: ScreenHeaderProps) {
  return (
    <View style={styles.wrap}>
      <View style={styles.text}>
        {subtitle !== undefined ? (
          <Text variant="label" tone="muted">
            {subtitle}
          </Text>
        ) : null}
        <Text variant="title" accessibilityRole="header" numberOfLines={2}>
          {title}
        </Text>
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.lg },
  text: { flex: 1, gap: spacing.xxs },
});
