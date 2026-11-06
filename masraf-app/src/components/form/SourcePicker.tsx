import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import type { IconName } from '@/components/ui/Button';
import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/Text';
import { useMotion } from '@/hooks/useMotion';
import { haptics } from '@/lib/haptics';
import type { InvoiceSource } from '@/lib/pickers';
import { radius, spacing, useTheme } from '@/theme';

export type SourceChoice = InvoiceSource | 'elle';

const OPTIONS: readonly { value: SourceChoice; icon: IconName; title: string; hint: string }[] = [
  { value: 'kamera', icon: 'camera', title: 'Kamera', hint: 'Fişin fotoğrafını çek' },
  { value: 'galeri', icon: 'images', title: 'Galeri', hint: 'Kayıtlı fotoğraftan seç' },
  { value: 'dosya', icon: 'document-text', title: 'PDF / Dosya', hint: 'e-Fatura veya PDF seç' },
  { value: 'elle', icon: 'create', title: 'Faturasız gir', hint: 'Bilgileri kendin yaz' },
];

export function SourcePicker({ onPick }: { readonly onPick: (choice: SourceChoice) => void }) {
  const { colors } = useTheme();
  const motion = useMotion();
  return (
    <View style={styles.grid} accessibilityLabel="Fatura kaynağı">
      {OPTIONS.map((option, i) => {
        const primary = option.value === 'kamera';
        return (
          <Animated.View key={option.value} entering={motion.enter(i)} style={styles.cell}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={option.title}
              accessibilityHint={option.hint}
              onPress={() => {
                haptics.press();
                onPick(option.value);
              }}
              style={[
                styles.tile,
                primary
                  ? { backgroundColor: colors.primary, borderColor: colors.primary }
                  : { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <View style={[styles.icon, { backgroundColor: primary ? 'rgba(255,255,255,0.18)' : colors.primarySoft }]}>
                <Ionicons name={option.icon} size={22} color={primary ? colors.onPrimary : colors.primary} />
              </View>
              <Text variant="bodyStrong" tone={primary ? 'onPrimary' : 'default'}>
                {option.title}
              </Text>
              <Text variant="caption" color={primary ? 'rgba(255,255,255,0.8)' : colors.textMuted} numberOfLines={2}>
                {option.hint}
              </Text>
            </PressableScale>
          </Animated.View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cell: { flexGrow: 1, flexBasis: '45%' },
  tile: { borderRadius: radius.xl, borderWidth: 1, padding: spacing.lg, gap: spacing.xs, minHeight: 120 },
  icon: { width: 42, height: 42, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xs },
});
