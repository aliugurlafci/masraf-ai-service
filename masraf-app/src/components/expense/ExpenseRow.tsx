import { Ionicons } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import type { MasrafOzet } from '@/api/types';
import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/Text';
import { formatDate, formatMoney } from '@/lib/format';
import { readingBadge } from '@/lib/reading';
import { STATUS_LABELS } from '@/lib/status';
import { amountFor, radius, spacing, useTheme } from '@/theme';

import { CategoryIcon } from './CategoryIcon';
import { StatusBadge } from './StatusBadge';

export interface ExpenseRowProps {
  readonly item: MasrafOzet;
  readonly onPress: (id: number) => void;
  /** Show who created it (approver and "all forms" lists). */
  readonly showOwner?: boolean;
  /** Show whose decision it waits for; off in the viewer's own inbox, where that is always the viewer. */
  readonly showNext?: boolean;
}

function ExpenseRowBase({ item, onPress, showOwner = false, showNext = true }: ExpenseRowProps) {
  const { colors } = useTheme();
  const lead = showOwner ? item.olusturan.adSoyad : item.kategori.ad;
  const date = formatDate(item.masrafTarihi);
  const subtitleParts = [lead, date];
  // A draft's amount may be empty until its invoices are read (the server fills it then).
  const amount = item.tutar !== null ? formatMoney(item.tutar, item.paraBirimi) : null;
  const stillReading = (item.okuma?.bekleyen ?? 0) > 0;
  const noAmount = stillReading ? 'Tutar okununca dolacak' : 'Tutar girilmedi';
  const badge = readingBadge(item.okuma);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={[item.baslik, amount ?? noAmount, STATUS_LABELS[item.durum], ...subtitleParts, badge?.text ?? null]
        .filter((part) => part !== null)
        .join(', ')}
      accessibilityHint="Ayrıntıları açar"
      onPress={() => onPress(item.id)}
      scaleTo={0.98}
      style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <CategoryIcon simge={item.kategori.simge} />
      <View style={styles.middle}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {item.baslik}
        </Text>
        {/* A long name or category gives way; the date after it is never cut. */}
        <View style={styles.subtitle}>
          <Text variant="small" tone="muted" numberOfLines={1} style={styles.lead}>
            {lead}
          </Text>
          <Text variant="small" tone="muted" numberOfLines={1} style={styles.date}>
            {`· ${date}`}
          </Text>
        </View>
        {showNext && item.durum === 'onayda' && item.siradakiOnayci !== null ? (
          <View style={styles.next}>
            <Ionicons name="time-outline" size={13} color={colors.textFaint} />
            <Text variant="caption" tone="faint" numberOfLines={1}>
              {item.siradakiOnayci.adSoyad}
            </Text>
          </View>
        ) : null}
        {badge !== null ? (
          <View style={[styles.badge, { backgroundColor: badge.failed ? colors.warningSoft : colors.infoSoft }]}>
            <Ionicons name={badge.failed ? 'alert-circle-outline' : 'sync-outline'} size={13} color={badge.failed ? colors.warning : colors.info} />
            <Text variant="caption" tone={badge.failed ? 'warning' : 'info'} numberOfLines={1} style={styles.badgeText}>
              {badge.text}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={styles.right}>
        {amount !== null ? (
          <Text variant="amount" numberOfLines={1} style={amountFor(amount)}>
            {amount}
          </Text>
        ) : (
          // Short enough for the amount column; the full wording is in the row's label.
          <Text variant="small" tone="muted" numberOfLines={1}>
            {stillReading ? 'Okununca dolacak' : 'Tutar yok'}
          </Text>
        )}
        <StatusBadge durum={item.durum} />
      </View>
    </PressableScale>
  );
}

export const ExpenseRow = memo(ExpenseRowBase);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 72,
  },
  middle: { flex: 1, gap: 2 },
  // Never shrinks: an amount is shown whole, the title and subtitle give way instead.
  right: { alignItems: 'flex-end', gap: spacing.xs + 2, flexShrink: 0 },
  next: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    marginTop: 2,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    maxWidth: '100%',
  },
  badgeText: { flexShrink: 1 },
  subtitle: { flexDirection: 'row', alignItems: 'baseline' },
  lead: { flexShrink: 1 },
  // The gap before "·" is a margin: a leading space in its own text node is dropped on some renderers.
  date: { flexShrink: 0, marginLeft: 4 },
});
