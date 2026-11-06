import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { errorMessage } from '@/api/client';
import { useMotion } from '@/hooks/useMotion';
import { radius, spacing, useTheme } from '@/theme';

import { Button, type IconName } from './Button';
import { Text } from './Text';

export interface EmptyStateProps {
  readonly icon: IconName;
  readonly title: string;
  readonly message?: string;
  readonly actionTitle?: string;
  readonly onAction?: () => void;
}

export function EmptyState({ icon, title, message, actionTitle, onAction }: EmptyStateProps) {
  const { colors } = useTheme();
  const motion = useMotion();
  return (
    <Animated.View entering={motion.enter(0)} style={styles.wrap}>
      <View style={[styles.iconWrap, { backgroundColor: colors.primarySoft }]}>
        <Ionicons name={icon} size={30} color={colors.primary} />
      </View>
      <Text variant="heading" align="center">
        {title}
      </Text>
      {message !== undefined ? (
        <Text tone="muted" align="center">
          {message}
        </Text>
      ) : null}
      {actionTitle !== undefined && onAction !== undefined ? (
        <Button title={actionTitle} onPress={onAction} variant="secondary" style={styles.action} />
      ) : null}
    </Animated.View>
  );
}

export function ErrorState({ error, onRetry }: { readonly error: unknown; readonly onRetry?: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap} accessibilityRole="alert">
      <View style={[styles.iconWrap, { backgroundColor: colors.dangerSoft }]}>
        <Ionicons name="cloud-offline-outline" size={30} color={colors.danger} />
      </View>
      <Text variant="heading" align="center">
        Yüklenemedi
      </Text>
      <Text tone="muted" align="center">
        {errorMessage(error)}
      </Text>
      {onRetry !== undefined ? (
        <Button title="Tekrar dene" icon="refresh" onPress={onRetry} variant="secondary" style={styles.action} />
      ) : null}
    </View>
  );
}

export type BannerTone = 'danger' | 'warning' | 'info' | 'success';

/** Small inline banner for errors and notices inside forms and cards. */
export function Banner({ tone, message, icon }: { readonly tone: BannerTone; readonly message: string; readonly icon?: IconName }) {
  const { colors } = useTheme();
  const motion = useMotion();
  const looks: Record<BannerTone, { fg: string; bg: string; icon: IconName }> = {
    danger: { fg: colors.danger, bg: colors.dangerSoft, icon: 'alert-circle' },
    warning: { fg: colors.warning, bg: colors.warningSoft, icon: 'warning' },
    info: { fg: colors.info, bg: colors.infoSoft, icon: 'information-circle' },
    success: { fg: colors.success, bg: colors.successSoft, icon: 'checkmark-circle' },
  };
  const look = looks[tone];
  return (
    <Animated.View
      entering={motion.fadeIn}
      accessibilityRole={tone === 'danger' ? 'alert' : undefined}
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: look.bg }]}
    >
      <Ionicons name={icon ?? look.icon} size={20} color={look.fg} />
      <Text variant="small" color={look.fg} style={styles.bannerText}>
        {message}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.huge, paddingHorizontal: spacing.xxl, gap: spacing.md },
  iconWrap: { width: 64, height: 64, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xs },
  action: { marginTop: spacing.sm, alignSelf: 'center' },
  banner: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md, borderRadius: radius.lg, alignItems: 'flex-start' },
  bannerText: { flex: 1, fontWeight: '500' },
});
