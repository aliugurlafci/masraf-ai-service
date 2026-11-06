import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useOzet } from '@/api/queries';
import { useAuth } from '@/auth/AuthProvider';
import { Button, type IconName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PressableScale } from '@/components/ui/PressableScale';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Text } from '@/components/ui/Text';
import { config } from '@/config';
import { useMotion } from '@/hooks/useMotion';
import { formatDateTime, formatRange, initials } from '@/lib/format';
import { ROLE_LABELS } from '@/lib/status';
import { radius, spacing, useTheme, type ThemePreference } from '@/theme';

export default function ProfileScreen() {
  const { colors, preference, setPreference } = useTheme();
  const motion = useMotion();
  const { user, signOut } = useAuth();
  const ozet = useOzet();
  const [leaving, setLeaving] = useState(false);
  const currency = ozet.data?.paraBirimi ?? 'TRY';

  if (user === null) return null;

  const confirmSignOut = (): void => {
    Alert.alert('Çıkış yap', 'Bu cihazdaki oturumunuz kapatılacak.', [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Çıkış yap',
        style: 'destructive',
        onPress: () => {
          setLeaving(true);
          void signOut();
        },
      },
    ]);
  };

  return (
    <SafeAreaView edges={['top']} style={[styles.flex, { backgroundColor: colors.bg }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <ScreenHeader title="Profil" />

        <Animated.View entering={motion.enter(0)}>
          <Card style={styles.identity}>
            <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
              <Text variant="title" tone="onPrimary">
                {initials(user.adSoyad)}
              </Text>
            </View>
            <View style={styles.flex}>
              <Text variant="heading" numberOfLines={2}>
                {user.adSoyad}
              </Text>
              <Text variant="small" tone="muted" numberOfLines={1}>
                {user.eposta}
              </Text>
              <View style={styles.tags}>
                <Tag icon="shield-checkmark-outline" label={ROLE_LABELS[user.rol]} />
                {user.departman !== null && user.departman !== '' ? <Tag icon="business-outline" label={user.departman} /> : null}
              </View>
            </View>
          </Card>
        </Animated.View>

        {user.onayAkisi !== null || user.onaycilik.length > 0 ? (
          <Animated.View entering={motion.enter(1)} style={styles.flows}>
            {user.onayAkisi !== null ? (
              <Card style={styles.row}>
                <View style={[styles.rowIcon, { backgroundColor: colors.primarySoft }]}>
                  <Ionicons name="git-merge-outline" size={20} color={colors.primary} />
                </View>
                <View style={styles.flex}>
                  <Text variant="bodyStrong">Masraflarınız: {user.onayAkisi.ad}</Text>
                  <Text variant="small" tone="muted">
                    {user.onayAkisiId === null ? 'Şirketin varsayılan onay akışı' : 'Size atanmış onay akışı'}
                  </Text>
                </View>
              </Card>
            ) : null}
            {user.onaycilik.map((yer) => (
              <Card key={yer.akis.id} style={styles.row}>
                <View style={[styles.rowIcon, { backgroundColor: colors.successSoft }]}>
                  <Ionicons name="git-network-outline" size={20} color={colors.success} />
                </View>
                <View style={styles.flex}>
                  <Text variant="bodyStrong">
                    {yer.akis.ad} akışında {yer.sira}. onaycısınız
                  </Text>
                  <Text variant="small" tone="muted">
                    Tutar aralığı: {formatRange(yer.altLimit, yer.ustLimit, currency)}
                  </Text>
                </View>
              </Card>
            ))}
          </Animated.View>
        ) : null}

        <Animated.View entering={motion.enter(2)} style={styles.section}>
          <Text variant="label" tone="muted" style={styles.sectionTitle}>
            HESAP
          </Text>
          <Card padded={false}>
            <MenuRow icon="key-outline" label="Şifre değiştir" onPress={() => router.push('/sifre')} />
          </Card>
        </Animated.View>

        <Animated.View entering={motion.enter(3)} style={styles.section}>
          <Text variant="label" tone="muted" style={styles.sectionTitle}>
            GÖRÜNÜM
          </Text>
          <SegmentedControl<ThemePreference>
            accessibilityLabel="Tema"
            options={[
              { value: 'system', label: 'Sistem' },
              { value: 'light', label: 'Açık' },
              { value: 'dark', label: 'Koyu' },
            ]}
            value={preference}
            onChange={setPreference}
          />
        </Animated.View>

        <Animated.View entering={motion.enter(4)} style={styles.section}>
          <Text variant="label" tone="muted" style={styles.sectionTitle}>
            UYGULAMA
          </Text>
          <Card style={styles.info}>
            <InfoLine label="Sunucu" value={config.apiUrl ?? '—'} />
            <InfoLine label="Sürüm" value={Constants.expoConfig?.version ?? '—'} />
            <InfoLine label="Son giriş" value={formatDateTime(user.sonGiris)} />
          </Card>
        </Animated.View>

        <Button title="Çıkış yap" icon="log-out-outline" variant="dangerSoft" onPress={confirmSignOut} loading={leaving} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Tag({ icon, label }: { readonly icon: IconName; readonly label: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tag, { backgroundColor: colors.primarySoft }]}>
      <Ionicons name={icon} size={13} color={colors.primary} />
      <Text variant="caption" tone="primary">
        {label}
      </Text>
    </View>
  );
}

function MenuRow({ icon, label, onPress }: { readonly icon: IconName; readonly label: string; readonly onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableScale accessibilityRole="button" accessibilityLabel={label} onPress={onPress} scaleTo={0.98} style={styles.menuRow}>
      <View style={[styles.rowIcon, { backgroundColor: colors.primarySoft }]}>
        <Ionicons name={icon} size={20} color={colors.primary} />
      </View>
      <Text variant="bodyStrong" style={styles.flex}>
        {label}
      </Text>
      <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
    </PressableScale>
  );
}

function InfoLine({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.infoLine} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant="small" tone="muted">
        {label}
      </Text>
      <Text variant="label" style={styles.infoValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxxl, gap: spacing.lg },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  avatar: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs + 2, marginTop: spacing.sm },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  flows: { gap: spacing.sm },
  rowIcon: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  section: { gap: spacing.sm },
  sectionTitle: { marginLeft: spacing.xs, letterSpacing: 0.8 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, minHeight: 60 },
  info: { gap: spacing.md },
  infoLine: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.lg },
  infoValue: { flexShrink: 1, textAlign: 'right' },
});
