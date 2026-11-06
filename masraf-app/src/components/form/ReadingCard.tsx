import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import type { PickedFile } from '@/api/endpoints';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { isPdf } from '@/lib/pickers';
import { radius, spacing, useTheme } from '@/theme';

const DOC_W = 76;
const DOC_H = 96;

export interface ReadingCardProps {
  readonly file: PickedFile;
  readonly phase: 'uploading' | 'sirada' | 'okunuyor';
  readonly startedAt: number;
  readonly onCancel: () => void;
}

/** "Reading the invoice" state: a scan line sweeps over the document while Claude reads it. */
export function ReadingCard({ file, phase, startedAt, onCancel }: ReadingCardProps) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const scan = useSharedValue(0);
  const bar = useSharedValue(0);
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - startedAt) / 1000));

  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  useEffect(() => {
    if (reduced) return undefined;
    scan.set(
      withRepeat(
        withSequence(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.quad) }), withTiming(0, { duration: 1400, easing: Easing.inOut(Easing.quad) })),
        -1,
      ),
    );
    bar.set(withRepeat(withTiming(1, { duration: 1300, easing: Easing.inOut(Easing.cubic) }), -1));
    return () => {
      cancelAnimation(scan);
      cancelAnimation(bar);
    };
  }, [reduced, scan, bar]);

  const scanStyle = useAnimatedStyle(() => ({ transform: [{ translateY: scan.get() * (DOC_H - 14) }] }));
  const barStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -120 + bar.get() * 360 }] }));

  const title = phase === 'uploading' ? 'Dosya gönderiliyor' : phase === 'sirada' ? 'Sırada bekliyor' : 'Fatura okunuyor';
  const detail =
    phase === 'okunuyor'
      ? 'Tutar, tarih ve satıcı birazdan forma gelecek. Bu bir dakika kadar sürebilir.'
      : phase === 'sirada'
        ? 'Okuyucular dolu; sıra gelince okumaya başlanacak.'
        : 'Dosya sunucuya yükleniyor.';
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const elapsedText = minutes > 0 ? `${minutes} dk ${seconds} sn` : `${seconds} sn`;

  return (
    <View
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.primary }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${title}, ${elapsedText}`}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.row}>
        <View style={[styles.doc, { backgroundColor: colors.primarySoft, borderColor: colors.border }]}>
          {isPdf(file.mimeType) ? (
            <Ionicons name="document-text" size={40} color={colors.primary} />
          ) : (
            <Image source={{ uri: file.uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
          )}
          {!reduced ? (
            <Animated.View style={[styles.scan, scanStyle]}>
              <LinearGradient colors={['transparent', `${colors.primary}AA`, 'transparent']} style={StyleSheet.absoluteFill} />
              <View style={[styles.scanLine, { backgroundColor: colors.primary }]} />
            </Animated.View>
          ) : null}
        </View>
        <View style={styles.text}>
          <View style={styles.titleRow}>
            <Text variant="heading">{title}</Text>
            <Text variant="caption" tone="muted" style={styles.elapsed}>
              {elapsedText}
            </Text>
          </View>
          <Text variant="small" tone="muted">
            {detail}
          </Text>
          <Text variant="caption" tone="faint" numberOfLines={1}>
            {file.name}
          </Text>
        </View>
      </View>
      <View style={[styles.track, { backgroundColor: colors.primarySoft }]}>
        {reduced ? (
          <View style={[styles.barStatic, { backgroundColor: colors.primary }]} />
        ) : (
          <Animated.View style={[styles.bar, { backgroundColor: colors.primary }, barStyle]} />
        )}
      </View>
      <View style={styles.footer}>
        <Ionicons name="create-outline" size={16} color={colors.textMuted} />
        <Text variant="small" tone="muted" style={styles.flex}>
          Bu sırada kategori ve açıklamayı doldurabilirsiniz.
        </Text>
        <Button title="Vazgeç" size="sm" variant="ghost" onPress={onCancel} accessibilityHint="Okumayı bekleme, formu elle doldur" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.xl, borderWidth: 1.5, padding: spacing.lg, gap: spacing.md },
  row: { flexDirection: 'row', gap: spacing.lg, alignItems: 'center' },
  doc: {
    width: DOC_W,
    height: DOC_H,
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scan: { position: 'absolute', left: 0, right: 0, top: 0, height: 14, justifyContent: 'center' },
  scanLine: { height: 2 },
  text: { flex: 1, gap: spacing.xs },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.sm, flexWrap: 'wrap' },
  elapsed: { fontVariant: ['tabular-nums'] },
  track: { height: 6, borderRadius: radius.pill, overflow: 'hidden' },
  bar: { width: 120, height: 6, borderRadius: radius.pill },
  barStatic: { width: '40%', height: 6, borderRadius: radius.pill },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flex: { flex: 1 },
});
