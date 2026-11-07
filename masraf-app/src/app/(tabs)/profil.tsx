import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { errorMessage } from '@/api/client';
import { useMailPreference, useOzet } from '@/api/queries';
import type { OnayciYeri } from '@/api/types';
import { useAuth } from '@/auth/AuthProvider';
import { Button, type IconName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PressableScale } from '@/components/ui/PressableScale';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Text } from '@/components/ui/Text';
import { useToast } from '@/components/ui/Toast';
import { config } from '@/config';
import { useMotion } from '@/hooks/useMotion';
import { formatBand, formatDateTime, formatMoney, initials } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import { ROLE_LABELS, STRATEGY_LABELS } from '@/lib/status';
import { radius, spacing, useTheme, type ThemePreference } from '@/theme';

export default function ProfileScreen() {
  const { colors, preference, setPreference } = useTheme();
  const motion = useMotion();
  const { user, signOut } = useAuth();
  const ozet = useOzet();
  const toast = useToast();
  const mailPreference = useMailPreference();
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
              {/* Middle ellipsis keeps the domain of a long address visible. */}
              <Text variant="small" tone="muted" numberOfLines={1} ellipsizeMode="middle">
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
                  <Text variant="bodyStrong" numberOfLines={2}>
                    Masraflarınız: {user.onayAkisi.ad}
                  </Text>
                  <Text variant="small" tone="muted">
                    {user.onayAkisiId === null ? 'Şirketin varsayılan onay akışı' : 'Size atanmış onay akışı'}
                  </Text>
                </View>
              </Card>
            ) : null}
            {user.onaycilik.map((yer) => (
              <ApproverCard key={yer.akis.id} yer={yer} currency={currency} />
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
            BİLDİRİMLER
          </Text>
          <Card style={styles.row}>
            <View style={[styles.rowIcon, { backgroundColor: colors.primarySoft }]}>
              <Ionicons name="mail-outline" size={20} color={colors.primary} />
            </View>
            <View style={styles.flex}>
              <Text variant="bodyStrong">Bildirimleri e-posta ile de al</Text>
              <Text variant="small" tone="muted">
                Uygulama içi bildirimler her zaman gelir.
              </Text>
            </View>
            <Switch
              value={user.mailBildirim}
              onValueChange={(value) => {
                haptics.tap();
                mailPreference.mutate(value, {
                  onError: (err) => {
                    haptics.error();
                    toast(`Tercih kaydedilemedi: ${errorMessage(err)}`, 'danger');
                  },
                });
              }}
              trackColor={{ false: colors.border, true: colors.primary }}
              accessibilityLabel="Bildirimleri e-posta ile de al"
              accessibilityRole="switch"
            />
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

/** Where the user approves in one flow: the flow's strategy, their approval limit and what reaches them. */
function ApproverCard({ yer, currency }: { readonly yer: OnayciYeri; readonly currency: string }) {
  const { colors } = useTheme();
  const limit = yer.limit === null ? 'Sınırsız' : formatMoney(yer.limit, currency);
  const limitNote =
    yer.limit === null
      ? 'Her tutarda son onay sizde.'
      : yer.akis.strateji === 'zincir'
        ? 'Bu tutara kadar son onay sizde; daha büyük tutarlar sizden sonra üst onaycıya geçer.'
        : 'Bu tutara kadar son onay sizde; daha büyük tutarlar doğrudan üst onaycıya gider.';
  const band = formatBand(yer.altLimit, yer.ustLimit, currency);
  return (
    <Card style={styles.approver}>
      <View style={styles.row}>
        <View style={[styles.rowIcon, { backgroundColor: colors.successSoft }]}>
          <Ionicons name="git-network-outline" size={20} color={colors.success} />
        </View>
        <View style={styles.flex}>
          {/* The flow name may be long; the order and strategy stay on their own line so they are never cut. */}
          <Text variant="bodyStrong" numberOfLines={2}>
            {yer.akis.ad}
          </Text>
          <Text variant="small" tone="muted">
            {yer.sira}. onaycısınız · {STRATEGY_LABELS[yer.akis.strateji]}
          </Text>
        </View>
      </View>
      <View style={[styles.limits, { borderTopColor: colors.border }]}>
        <LimitLine icon="shield-checkmark-outline" label="Onay limiti" value={limit} note={limitNote} />
        <LimitLine icon="file-tray-full-outline" label="Size gelen masraflar" value={band} />
      </View>
    </Card>
  );
}

function LimitLine({ icon, label, value, note }: { readonly icon: IconName; readonly label: string; readonly value: string; readonly note?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.limitLine} accessible accessibilityLabel={[`${label}: ${value}`, note].filter((p) => p !== undefined).join('. ')}>
      <Ionicons name={icon} size={18} color={colors.textMuted} style={styles.limitIcon} />
      <View style={styles.flex}>
        <View style={styles.limitHead}>
          <Text variant="small" tone="muted" style={styles.limitLabel}>
            {label}
          </Text>
          <Text variant="label" style={[styles.limitValue, styles.tabular]}>
            {value}
          </Text>
        </View>
        {note !== undefined ? (
          <Text variant="caption" tone="faint">
            {note}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Tag({ icon, label }: { readonly icon: IconName; readonly label: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tag, { backgroundColor: colors.primarySoft }]}>
      <Ionicons name={icon} size={13} color={colors.primaryText} />
      {/* A long department name is cut inside the pill instead of running out of the card. */}
      <Text variant="caption" tone="primary" numberOfLines={1} style={styles.tagText}>
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
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill, maxWidth: '100%' },
  tagText: { flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  flows: { gap: spacing.sm },
  approver: { gap: spacing.md },
  limits: { gap: spacing.md, paddingTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  limitLine: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  limitIcon: { marginTop: 1 },
  limitHead: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: spacing.sm },
  limitLabel: { flexShrink: 1 },
  limitValue: { flexShrink: 1, textAlign: 'right' },
  tabular: { fontVariant: ['tabular-nums'] },
  rowIcon: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  section: { gap: spacing.sm },
  sectionTitle: { marginLeft: spacing.xs, letterSpacing: 0.8 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, minHeight: 60 },
  info: { gap: spacing.md },
  infoLine: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.lg },
  infoValue: { flexShrink: 1, textAlign: 'right' },
});
