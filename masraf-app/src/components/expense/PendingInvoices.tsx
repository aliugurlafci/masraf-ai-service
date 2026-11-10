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

import type { BekleyenFatura } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconButton } from '@/components/ui/IconButton';
import { Text } from '@/components/ui/Text';
import { useMotion } from '@/hooks/useMotion';
import { fieldName, valueLines, type FieldDefs } from '@/lib/fields';
import { queueText } from '@/lib/reading';
import { spacing, useTheme } from '@/theme';

import { InvoiceThumb } from './InvoiceThumb';

export interface PendingInvoicesProps {
  readonly items: readonly BekleyenFatura[];
  /** The owner may read failed files again and take them off the form (`izinler.duzenle`). */
  readonly canEdit: boolean;
  readonly rereading: boolean;
  /** No action while another one runs. */
  readonly disabled: boolean;
  readonly onReread: () => void;
  readonly onRemove: (item: BekleyenFatura) => void;
  /** Names the receipt fields (GET /api/alanlar); keys show until it loads. */
  readonly defs: FieldDefs | undefined;
}

/**
 * A saved form's invoice files the server reads in the background: each one's place in the shared queue,
 * "being read", or why it could not be read. The screen asks for the form again while any is not done.
 */
export function PendingInvoices({ items, canEdit, rereading, disabled, onReread, onRemove, defs }: PendingInvoicesProps) {
  const motion = useMotion();
  const failed = items.filter((b) => b.durum === 'hata').length;
  return (
    <Card style={styles.card}>
      {items.map((b) => (
        <Animated.View key={b.dosyaOzeti} layout={motion.layout} entering={motion.fadeIn} exiting={motion.fadeOut}>
          <PendingRow item={b} defs={defs} canRemove={canEdit && b.durum === 'hata'} disabled={disabled} onRemove={() => onRemove(b)} />
        </Animated.View>
      ))}
      {canEdit && failed > 0 ? (
        <Button
          title={failed > 1 ? 'Okunamayanları yeniden oku' : 'Yeniden oku'}
          icon="refresh"
          size="sm"
          variant="secondary"
          loading={rereading}
          disabled={disabled}
          accessibilityHint="Okunamayan faturaları yeniden okuma sırasına alır"
          onPress={onReread}
        />
      ) : null}
    </Card>
  );
}

function PendingRow({
  item,
  defs,
  canRemove,
  disabled,
  onRemove,
}: {
  readonly item: BekleyenFatura;
  readonly defs: FieldDefs | undefined;
  readonly canRemove: boolean;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}) {
  const { colors } = useTheme();
  const status =
    item.durum === 'sirada'
      ? queueText(item.kuyrukSirasi, item.onundeki)
      : item.durum === 'okunuyor'
        ? 'Okunuyor'
        : (item.hata?.mesaj ?? 'Fatura okunamadı.');
  // The receipt fields entered for the file; they move to the invoice once it is read.
  const values = valueLines(defs, item.alanlar)
    .map((line) => `${line.label}: ${line.gosterim}`)
    .join(' · ');
  const missing = item.eksikAlanlar.map((k) => fieldName(defs, k)).join(', ');
  return (
    <View style={styles.row}>
      <InvoiceThumb source={{ kind: 'icon', mime: item.mime }} width={40} height={50} />
      {/* The status changes as the queue moves; screen readers hear it without the row being focused. */}
      <View
        style={styles.flex}
        accessible
        accessibilityLabel={[
          item.dosyaAdi,
          item.durum === 'hata' ? `Okunamadı: ${status}` : status,
          values !== '' ? values : null,
          missing !== '' ? `Eksik: ${missing}` : null,
        ]
          .filter((part) => part !== null)
          .join('. ')}
        accessibilityLiveRegion="polite"
      >
        <Text variant="label" numberOfLines={1}>
          {item.dosyaAdi}
        </Text>
        <View style={styles.status}>
          {item.durum === 'okunuyor' ? (
            <PulseDot color={colors.primary} />
          ) : (
            <Ionicons name={item.durum === 'hata' ? 'alert-circle' : 'time-outline'} size={15} color={item.durum === 'hata' ? colors.warning : colors.textMuted} />
          )}
          <Text
            variant="small"
            tone={item.durum === 'hata' ? 'warning' : item.durum === 'okunuyor' ? 'primary' : 'muted'}
            numberOfLines={item.durum === 'hata' ? 3 : 1}
            style={styles.flex}
          >
            {status}
          </Text>
        </View>
        {values !== '' ? (
          <Text variant="caption" tone="faint" numberOfLines={2}>
            {values}
          </Text>
        ) : null}
        {missing !== '' ? (
          <Text variant="caption" tone="warning" numberOfLines={2}>
            Eksik: {missing}
          </Text>
        ) : null}
      </View>
      {canRemove ? (
        <IconButton icon="trash-outline" tone="soft" color={colors.danger} accessibilityLabel={`Masraftan çıkar: ${item.dosyaAdi}`} disabled={disabled} onPress={onRemove} />
      ) : null}
    </View>
  );
}

/** A dot with a ring that keeps spreading while the file is read; a still dot when motion is reduced. */
function PulseDot({ color }: { readonly color: string }) {
  const reduced = useReducedMotion();
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (reduced) return undefined;
    pulse.set(withRepeat(withTiming(1, { duration: 1200, easing: Easing.out(Easing.quad) }), -1));
    return () => cancelAnimation(pulse);
  }, [reduced, pulse]);
  const ring = useAnimatedStyle(() => ({ opacity: 0.5 * (1 - pulse.get()), transform: [{ scale: 1 + pulse.get() * 1.4 }] }));
  return (
    <View style={styles.dotWrap}>
      {!reduced ? <Animated.View style={[styles.dotRing, { backgroundColor: color }, ring]} /> : null}
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  );
}

const DOT = 8;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { gap: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  status: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2, marginTop: 2 },
  dotWrap: { width: 15, height: 15, alignItems: 'center', justifyContent: 'center' },
  dotRing: { position: 'absolute', width: DOT, height: DOT, borderRadius: DOT / 2 },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
});
