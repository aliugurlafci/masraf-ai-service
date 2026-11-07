import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { FaturaKalemi, MasrafFatura } from '@/api/types';
import { Card } from '@/components/ui/Card';
import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/Text';
import { haptics } from '@/lib/haptics';
import {
  changedHeaderKeys,
  displayValue,
  fieldLabel,
  HEADER_FIELDS,
  LINE_FIELDS,
  sameLines,
  toOkunan,
  type FieldSpec,
  type HeaderKey,
} from '@/lib/invoiceEdit';
import { radius, spacing, useTheme } from '@/theme';

const spec = (key: HeaderKey): FieldSpec<string> => HEADER_FIELDS.find((f) => f.key === key) as FieldSpec<string>;

/** One invoice's information (the effective values) and lines; when corrected, how it differs from what was read. */
export function InvoiceInfoCard({ fatura, index, count, currency }: { readonly fatura: MasrafFatura; readonly index: number; readonly count: number; readonly currency: string }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const current = toOkunan(fatura);
  const read = fatura.okunan;
  const changed = read === null ? [] : changedHeaderKeys(read, current);
  const linesChanged = read !== null && !sameLines(read.kalemler, current.kalemler);
  const money = (f: FieldSpec<string>, value: string | number | null, invoiceCurrency: string | null): string =>
    displayValue(f, value, invoiceCurrency ?? currency);
  const filled = HEADER_FIELDS.filter((f) => current.fatura[f.key] !== null);
  const title = count > 1 ? `${index + 1}. fatura` : 'Fatura bilgileri';

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Text variant="bodyStrong" style={styles.flex} numberOfLines={1}>
          {title}
        </Text>
        {fatura.duzeltildi ? (
          <View style={[styles.badge, { backgroundColor: colors.infoSoft }]} accessible accessibilityLabel="Düzeltildi">
            <Ionicons name="create" size={13} color={colors.info} />
            <Text variant="caption" tone="info">
              Düzeltildi
            </Text>
          </View>
        ) : null}
      </View>

      {fatura.eksikAlanlar.length > 0 ? (
        <View style={styles.row}>
          <Ionicons name="alert-circle" size={16} color={colors.danger} />
          <Text variant="small" tone="danger" style={styles.flex}>
            Eksik bilgi: {fatura.eksikAlanlar.map((k) => fieldLabel(k).toLowerCase()).join(', ')}
          </Text>
        </View>
      ) : null}

      {filled.length === 0 ? (
        <Text variant="small" tone="muted">
          Faturadan okunan bilgi yok.
        </Text>
      ) : (
        filled.map((f) => (
          <View key={f.key} style={styles.fact} accessible accessibilityLabel={`${f.label}: ${money(f, current.fatura[f.key], current.fatura.paraBirimi)}`}>
            <Text variant="small" tone="muted">
              {f.label}
            </Text>
            <Text variant="label" style={styles.value}>
              {money(f, current.fatura[f.key], current.fatura.paraBirimi)}
            </Text>
          </View>
        ))
      )}

      {current.kalemler.length > 0 ? (
        <>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Kalemler, ${current.kalemler.length} kalem`}
            accessibilityState={{ expanded: open }}
            onPress={() => {
              haptics.tap();
              setOpen((o) => !o);
            }}
            scaleTo={0.98}
            style={styles.toggle}
          >
            <Text variant="label" tone="primary" style={styles.flex}>
              Kalemler ({current.kalemler.length})
            </Text>
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.primary} />
          </PressableScale>
          {open ? current.kalemler.map((line, i) => <Line key={i} line={line} index={i} currency={current.fatura.paraBirimi ?? currency} />) : null}
        </>
      ) : null}

      {read !== null && (changed.length > 0 || linesChanged) ? (
        <View style={[styles.diff, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
          <Text variant="label" tone="muted">
            Okunan ve geçerli değer
          </Text>
          {changed.map((key) => {
            const f = spec(key);
            const before = money(f, read.fatura[key], read.fatura.paraBirimi);
            const after = money(f, current.fatura[key], current.fatura.paraBirimi);
            return (
              <View key={key} style={styles.diffItem} accessible accessibilityLabel={`${f.label}: okunan ${before}, geçerli ${after}`}>
                <Text variant="small" tone="muted">
                  {f.label}
                </Text>
                <View style={styles.diffValues}>
                  <Text variant="small" tone="faint" style={styles.struck}>
                    {before}
                  </Text>
                  <Ionicons name="arrow-forward" size={12} color={colors.textFaint} />
                  <Text variant="label">{after}</Text>
                </View>
              </View>
            );
          })}
          {linesChanged ? (
            <Text variant="small" tone="muted">
              Kalemler: okunan {read.kalemler.length}, geçerli {current.kalemler.length} kalem.
            </Text>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function Line({ line, index, currency }: { readonly line: FaturaKalemi; readonly index: number; readonly currency: string }) {
  const { colors } = useTheme();
  const facts = LINE_FIELDS.filter((f) => f.key !== 'aciklama' && line[f.key] !== null).map((f) => {
    const value = line[f.key];
    if (value === null) return '';
    if (f.key === 'birimFiyat' || f.key === 'tutar') return `${f.label}: ${displayValue(f, value, currency)}`;
    if (f.key === 'kdvOrani') return `KDV %${value}`;
    return `${f.label}: ${value}`;
  });
  return (
    <View style={[styles.line, { borderTopColor: colors.border }]} accessible accessibilityLabel={`${index + 1}. kalem. ${line.aciklama ?? ''}. ${facts.join(', ')}`}>
      <Text variant="label">
        {index + 1}. {line.aciklama ?? 'Kalem'}
      </Text>
      <Text variant="small" tone="muted">
        {facts.join(' · ')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { gap: spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  fact: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.lg },
  value: { flexShrink: 1, textAlign: 'right' },
  toggle: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: spacing.sm },
  line: { paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, gap: 2 },
  diff: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: spacing.md, gap: spacing.sm },
  diffItem: { gap: 2 },
  diffValues: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
  struck: { textDecorationLine: 'line-through' },
});
