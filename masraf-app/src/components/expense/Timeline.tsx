import { Ionicons } from '@expo/vector-icons';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import type { AdimDurum, FormOnay, GecmisKaydi } from '@/api/types';
import type { IconName } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { useMotion } from '@/hooks/useMotion';
import { formatBand, formatDateTime } from '@/lib/format';
import { HISTORY_LABELS, STEP_LABELS } from '@/lib/status';
import { radius, spacing, useTheme, type Palette } from '@/theme';

function stepLook(p: Palette, durum: AdimDurum): { fg: string; bg: string; icon: IconName } {
  switch (durum) {
    case 'sirada':
      return { fg: p.textFaint, bg: p.surfaceAlt, icon: 'ellipse-outline' };
    case 'bekliyor':
      return { fg: p.warning, bg: p.warningSoft, icon: 'hourglass-outline' };
    case 'onaylandi':
      return { fg: p.success, bg: p.successSoft, icon: 'checkmark' };
    case 'reddedildi':
      return { fg: p.danger, bg: p.dangerSoft, icon: 'close' };
    case 'atlandi':
      return { fg: p.textMuted, bg: p.surfaceAlt, icon: 'play-skip-forward' };
    case 'iptal':
      return { fg: p.textFaint, bg: p.bg, icon: 'remove' };
  }
}

/** Approval steps as a vertical timeline; steps appear one after another. */
export function ApprovalTimeline({ steps, currency }: { readonly steps: readonly FormOnay[]; readonly currency: string }) {
  const motion = useMotion();
  return (
    <View accessibilityRole="list">
      {steps.map((step, i) => (
        <Animated.View key={step.id} entering={motion.enter(i + 1)}>
          <StepRow step={step} last={i === steps.length - 1} currency={currency} />
        </Animated.View>
      ))}
    </View>
  );
}

function StepRow({ step, last, currency }: { readonly step: FormOnay; readonly last: boolean; readonly currency: string }) {
  const { colors } = useTheme();
  const look = stepLook(colors, step.durum);
  const faded = step.durum === 'iptal' || step.durum === 'atlandi';
  return (
    <View
      style={styles.stepRow}
      accessible
      accessibilityLabel={`${step.sira}. adım, ${step.onayci.adSoyad}, ${STEP_LABELS[step.durum]}${step.yedek ? ', yedek onaycı' : ''}${
        step.aciklama !== null ? `, not: ${step.aciklama}` : ''
      }`}
    >
      <View style={styles.rail}>
        <Node durum={step.durum} fg={look.fg} bg={look.bg} icon={look.icon} />
        {!last ? <View style={[styles.line, { backgroundColor: colors.border }]} /> : null}
      </View>
      <View style={[styles.stepBody, faded && styles.faded]}>
        <View style={styles.stepHead}>
          <Text variant="bodyStrong" style={styles.flex} numberOfLines={2}>
            {step.onayci.adSoyad}
          </Text>
          {step.yedek ? (
            <View style={[styles.tag, { backgroundColor: colors.warningSoft }]}>
              <Text variant="caption" tone="warning">
                Yedek
              </Text>
            </View>
          ) : null}
        </View>
        <Text variant="small" color={look.fg}>
          {STEP_LABELS[step.durum]}
          {step.kararTarihi !== null ? ` · ${formatDateTime(step.kararTarihi)}` : ''}
        </Text>
        <Text variant="caption" tone="faint">
          {step.sira}. sıra · Tutar aralığı: {formatBand(step.altLimit, step.ustLimit, currency)}
        </Text>
        {step.aciklama !== null && step.aciklama !== '' ? (
          <View style={[styles.note, { backgroundColor: colors.surfaceAlt }]}>
            <Ionicons name="chatbubble-ellipses-outline" size={14} color={colors.textMuted} />
            <Text variant="small" style={styles.flex}>
              {step.aciklama}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Node({ durum, fg, bg, icon }: { readonly durum: AdimDurum; readonly fg: string; readonly bg: string; readonly icon: IconName }) {
  const reduced = useReducedMotion();
  const pulse = useSharedValue(0);
  const active = durum === 'bekliyor';
  useEffect(() => {
    if (!active || reduced) return undefined;
    pulse.set(withRepeat(withTiming(1, { duration: 1400, easing: Easing.out(Easing.quad) }), -1));
    return () => cancelAnimation(pulse);
  }, [active, reduced, pulse]);
  const ring = useAnimatedStyle(() => ({ opacity: 0.5 * (1 - pulse.get()), transform: [{ scale: 1 + pulse.get() * 0.7 }] }));
  return (
    <View style={styles.nodeWrap}>
      {active && !reduced ? <Animated.View style={[styles.ring, { backgroundColor: fg }, ring]} /> : null}
      <View style={[styles.node, { backgroundColor: bg, borderColor: fg }]}>
        <Ionicons name={icon} size={16} color={fg} />
      </View>
    </View>
  );
}

/** Form history, oldest first. */
export function HistoryList({ items }: { readonly items: readonly GecmisKaydi[] }) {
  const { colors } = useTheme();
  return (
    <View style={styles.history} accessibilityRole="list">
      {items.map((item, i) => (
        <View
          key={`${item.tarih}-${i}`}
          style={styles.historyRow}
          accessible
          accessibilityLabel={`${HISTORY_LABELS[item.islem]}, ${item.kullanici?.adSoyad ?? ''}, ${formatDateTime(item.tarih)}`}
        >
          <View style={[styles.historyDot, { backgroundColor: i === items.length - 1 ? colors.primary : colors.border }]} />
          <View style={styles.flex}>
            <Text variant="label">{HISTORY_LABELS[item.islem]}</Text>
            <Text variant="caption" tone="muted">
              {[item.kullanici?.adSoyad, formatDateTime(item.tarih)].filter(Boolean).join(' · ')}
            </Text>
            {item.aciklama !== null && item.aciklama !== '' ? (
              <Text variant="small" tone="muted" style={styles.historyNote}>
                “{item.aciklama}”
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const NODE = 32;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  stepRow: { flexDirection: 'row', gap: spacing.md },
  rail: { alignItems: 'center', width: NODE },
  line: { width: 2, flex: 1, marginVertical: spacing.xs, borderRadius: 1 },
  nodeWrap: { width: NODE, height: NODE, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: NODE, height: NODE, borderRadius: NODE / 2 },
  node: { width: NODE, height: NODE, borderRadius: NODE / 2, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  stepBody: { flex: 1, gap: 2, paddingBottom: spacing.xl },
  faded: { opacity: 0.6 },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tag: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill },
  note: { flexDirection: 'row', gap: spacing.xs + 2, padding: spacing.sm + 2, borderRadius: radius.md, marginTop: spacing.xs, alignItems: 'flex-start' },
  history: { gap: spacing.md },
  historyRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  historyDot: { width: 10, height: 10, borderRadius: 5, marginTop: 5 },
  historyNote: { marginTop: 2, fontStyle: 'italic' },
});
