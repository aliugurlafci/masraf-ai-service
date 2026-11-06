import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { categoryIcon } from '@/lib/categories';
import { radius, useTheme } from '@/theme';

export function CategoryIcon({ simge, size = 44 }: { readonly simge: string | null | undefined; readonly size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      importantForAccessibility="no"
      accessibilityElementsHidden
      style={[styles.wrap, { width: size, height: size, backgroundColor: colors.primarySoft }]}
    >
      <MaterialCommunityIcons name={categoryIcon(simge)} size={Math.round(size * 0.5)} color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
});
